/** Compare existing queue batches with native PDF Ink through read endpoints.
 * Authentication, source text, coordinates and paths remain in memory only.
 * ink_queue_list may resume work already owned by the host; this script never
 * enqueues/retries a write, changes a document, or requests a model.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const opaque = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const countPoints = paths => Array.isArray(paths) ? paths.reduce((n, path) => n + (Array.isArray(path) ? path.length : 0), 0) : 0;
const tolerance = .001;
const samePaths = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((path, i) =>
  Array.isArray(path) && Array.isArray(b[i]) && path.length === b[i].length && path.every((point, j) =>
    Array.isArray(point) && Array.isArray(b[i][j]) && point.length === 2 && b[i][j].length === 2 && point.every((v, k) =>
      Number.isFinite(v) && Number.isFinite(b[i][j][k]) && Math.abs(v - b[i][j][k]) <= tolerance)));

export function summarizeInk(queue, papers) {
  const jobs = (queue.jobs || []).map(job => {
    const batch = job.batch || {}, paper = papers.get(batch.paperId), matches = (paper?.annotations || []).filter(note => note.id === job.annotation_id && note.type === 'ink');
    const native = matches.length === 1 ? matches[0] : null;
    const match = native ? {
      page: native.page === batch.page,
      parent: (native.parent_id || native.reply_to || null) === (batch.parentId || null),
      strokes: native.paths?.length === batch.paths?.length,
      points: countPoints(native.paths) === countPoints(batch.paths),
      geometry: samePaths(batch.paths, native.paths),
      width: Number.isFinite(native.width) && Number.isFinite(batch.width) && Math.abs(native.width - batch.width) <= tolerance,
    } : null;
    return {
      paper_ref: opaque(batch.paperId), batch_ref: opaque(job.annotation_id),
      parent_ref: batch.parentId ? opaque(batch.parentId) : null,
      page: batch.page, status: job.status,
      queued_strokes: Array.isArray(batch.paths) ? batch.paths.length : 0,
      queued_points: countPoints(batch.paths), native_matches: matches.length,
      native_strokes: native?.paths?.length ?? null, native_points: native ? countPoints(native.paths) : null,
      annotations_truncated: Boolean(paper?.truncated),
      native_geometry_truncated: Boolean(native?.geometry_truncated),
      match, verified: Boolean(match && Object.values(match).every(Boolean) && !native.geometry_truncated),
    };
  });
  const receipts = queue.receipts || queue.jobs || [], returned = new Set((queue.jobs || []).map(job => job.annotation_id));
  const missingBodies = receipts.filter(job => !returned.has(job.annotation_id)).map(job => ({batch_ref: opaque(job.annotation_id), status: job.status}));
  return {
    queue_truncated: Boolean(queue.truncated), queue_error: Boolean(queue.error),
    listed_batches: receipts.length, checked_batches: jobs.length, omitted_batches: missingBodies,
    native_strokes_verified: jobs.filter(job => job.verified).reduce((n, job) => n + job.native_strokes, 0),
    all_listed_batches_match: jobs.length > 0 && !missingBodies.length && jobs.every(job => job.verified), jobs,
  };
}

async function boundedJson(response) {
  if (!response.ok) throw new Error(`READ_HTTP_${response.status}`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('READ_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('READ_INVALID_JSON'); }
  if (value?.ok !== true) throw new Error('READ_NOT_CONFIRMED');
  return value.result;
}

async function main() {
  const flags = new Map();
  for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i], process.argv[i + 1]);
  const port = Number(flags.get('--port')), log = flags.get('--log');
  if (!log || !Number.isInteger(port) || port < 1 || port > 65535 || [...flags.keys()].some(key => !['--log', '--port', '--output'].includes(key))) {
    throw new Error('USAGE: --log PRIVATE_HOST_LOG --port PORT [--output LOCAL_RECEIPT]');
  }
  const text = await readFile(log, 'utf8');
  const address = [...text.matchAll(/https?:\/\/[^\s]+/g)].reverse().map(match => { try { return new URL(match[0]); } catch { return null; } }).find(url => url?.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port && url.searchParams.has('token'));
  if (!address) throw new Error('AUTH_ADDRESS_UNAVAILABLE');
  const exchange = await fetch(address, {redirect: 'manual', signal: AbortSignal.timeout(10000)});
  if (exchange.status !== 303) throw new Error('AUTH_EXCHANGE_FAILED');
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('AUTH_COOKIE_UNAVAILABLE');
  const headers = {Cookie: cookie, Origin: address.origin, 'Content-Type': 'application/json'};
  const request = async (action, args = {}) => {
    if (!['ink_queue_list', 'annotations'].includes(action)) throw new Error('READ_ACTION_FORBIDDEN');
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${address.origin}/api/paper-library/api`, {method: 'POST', redirect: 'error', headers, body: JSON.stringify({action, ...args}), signal: AbortSignal.timeout(30000)});
      if (response.status === 429 && attempt < 2) { await response.body?.cancel(); await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); continue; }
      return boundedJson(response);
    }
  };
  const queue = await request('ink_queue_list');
  if (!Array.isArray(queue.jobs) || queue.jobs.length > 64) throw new Error('QUEUE_SHAPE_INVALID');
  const paperIds = [...new Set(queue.jobs.map(job => job.batch?.paperId))];
  if (paperIds.length > 32 || paperIds.some(id => typeof id !== 'string' || !id)) throw new Error('QUEUE_SCOPE_INVALID');
  const papers = new Map();
  for (const id of paperIds) {
    const result = await request('annotations', {id});
    if (!Array.isArray(result?.annotations)) throw new Error('ANNOTATIONS_SHAPE_INVALID');
    papers.set(id, result);
  }
  const report = {
    checked_at: new Date().toISOString(), ...summarizeInk(queue, papers),
    authenticated_host: true, private_documents_read: paperIds.length,
    model_requests: 0, explicit_mutation_requests: 0,
    coordinates_or_text_recorded: false, coordinate_tolerance_pdf_points: tolerance,
    limitations: [
      'Only retained queue batches are compared; this cannot detect a stroke lost before it entered that queue.',
      'Native annotation geometry is recovered from PDF through the existing bounded annotations endpoint; any omitted queue bodies are reported.',
      'The queue list endpoint may resume work already owned by the host; this script never enqueues or retries a write.',
    ],
  };
  if (flags.get('--output')) await writeFile(flags.get('--output'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(report));
  if (!report.all_listed_batches_match) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Network/runtime errors may embed request URLs; never print raw errors.
    const message = /^(?:USAGE:|READ_[A-Z0-9_]+$|AUTH_[A-Z_]+$|QUEUE_[A-Z_]+$|ANNOTATIONS_[A-Z_]+$)/.test(error.message) ? error.message : 'DIAGNOSTIC_FAILED_WITHOUT_DISCLOSING_PRIVATE_DETAILS';
    console.error(JSON.stringify({ok: false, error: message})); process.exitCode = 1;
  });
}
