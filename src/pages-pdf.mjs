import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const prefix = '/api/pages/pdf/';
const routes = new Set(['list', 'import', 'page', 'annotate', 'comment', 'download']);
const uploadLimit = 64 * 1024 * 1024;
let uploads = 0;

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function summary({ id, title, citekey, pdf }) {
  return { id, title, citekey, pdf };
}

function paperId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) fail('文献标识无效。');
  return value;
}

async function importLocalPdf(request, url, run) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/pdf') fail('导入需要 PDF 文件。', 415);
  if (!request.body) fail('缺少 PDF 文件。');
  if (Number(request.headers.get('content-length')) > uploadLimit) fail('单份 PDF 限 64 MiB。', 413);
  const name = url.searchParams.get('filename') || 'import.pdf';
  if (!/\.pdf$/i.test(name) || /[/\\<>:"|?*\u0000-\u001f]/u.test(name) || Buffer.byteLength(name) > 240) fail('PDF 文件名无效。');
  if (uploads >= 2) fail('已有两份 PDF 正在导入，请稍后重试。', 429);
  uploads++;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'paper-library-local-'));
    const path = join(directory, name);
    let size = 0;
    const guard = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > uploadLimit ? Object.assign(new Error('单份 PDF 限 64 MiB。'), { status: 413 }) : null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(request.body), guard, createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal: AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) });
    if (!size) fail('PDF 文件为空。');
    // 只把本次选中的文件交给本机内核。网页不会提供服务器路径、书目查询或远程下载参数。
    const result = await run('import', { path });
    return { items: result.items.map(summary), warnings: result.warnings, duplicates: result.duplicates };
  } finally {
    uploads--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function handlePdf(request, { run, readJson }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(prefix)) return null;
  const route = url.pathname.slice(prefix.length);
  if (!routes.has(route)) return null;
  if (route === 'download') {
    if (request.method !== 'GET') fail('下载需要 GET 请求。', 405);
    const { path, filename } = await run('export_pdf', { id: paperId(url.searchParams.get('id')) });
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      return new Response(Readable.toWeb(file.createReadStream()), { headers: {
        'Content-Type': 'application/pdf', 'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`
      } });
    } catch (error) { await file.close(); throw error; }
  }
  if (request.method !== 'POST') fail('请使用 POST 访问本机资料库。', 405);
  if (route === 'import') return Response.json(await importLocalPdf(request, url, run));

  const input = await readJson(request, 192 * 1024);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('需要 JSON 对象。');
  if (route === 'list') {
    const { query = '', offset = 0 } = input;
    if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('文献检索条件无效。');
    const { items, total, limit } = await run('list', { query, offset, limit: 20 });
    return Response.json({ items: items.map(summary), total, limit, offset });
  }

  const { id, page, type, rects, segments, comment, annotation_id } = input;
  paperId(id);
  if (route === 'page') {
    if (!Number.isSafeInteger(page) || page < 1 || page > 2000) fail('页码超出范围。');
    const { scale = 1.25, render_width, include_layout = false } = input;
    if (!Number.isFinite(scale) || scale <= 0 || typeof include_layout !== 'boolean' ||
      (render_width !== undefined && (!Number.isFinite(render_width) || render_width <= 0))) fail('页面尺寸无效。');
    return Response.json(await run('page', { id, page, scale: Math.min(6, scale), include_layout,
      ...(render_width === undefined ? {} : { render_width: Math.min(render_width, 4096) }) }));
  }

  if (typeof comment !== 'string' || comment.length > 30000) fail('备注限 30000 字符。');
  if (route === 'comment') {
    if (typeof annotation_id !== 'string' || !annotation_id || annotation_id.length > 160 ||
      typeof input.version !== 'string' || !/^[0-9a-f]{64}$/.test(input.version)) fail('缺少有效的批注标识或版本。');
    return Response.json(await run('annotation_update', { id, annotation_id, comment, version: input.version }));
  }

  if (!['highlight', 'underline', 'strikeout', 'square', 'note'].includes(type) ||
    typeof annotation_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(annotation_id)) fail('批注类型或保存标识无效。');
  // 页码、旋转后的坐标、跨页选文及重试身份均由原生批注内核再次校验。
  const selection = segments === undefined ? { page, rects, text: input.text ?? '' } : { segments };
  return Response.json(await run('annotate', { id, annotation_id, type, comment,
    color: ['square', 'underline', 'strikeout'].includes(type) ? '#26796a' : '#ffdb66', ...selection }));
}
