import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from '../src/bridge.mjs';
import { configurePagesModel, readBytes } from '../src/pages-model.mjs';
import { startPages } from '../src/pages-server.mjs';

function close(server) {
  return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
function jsonPost(origin, payload) {
  return { method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(payload) };
}
async function startLocal(t, extra = []) {
  const library = await mkdtemp(join(tmpdir(), 'pages-service-'));
  t.after(() => rm(library, { recursive: true, force: true }));
  const server = await startPages(['--library', library, '--port', '0', ...extra]);
  t.after(() => close(server));
  assert.equal(server.address().address, '127.0.0.1');
  return 'http://127.0.0.1:' + server.address().port;
}

test('the public navigation opens a local shell, and only that origin reaches the library', async t => {
  const origin = await startLocal(t);
  const page = await fetch(origin + '/library/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await page.text();
  // Include the app module graph, since both feature modules are loaded by its entry point.
  for (const path of [...html.matchAll(/(?:href|src)="([./][^"#]+)"/g)].map(match => match[1]).concat(['./pdf.js', './latex.js', './client.js'])) {
    const asset = await fetch(new URL(path, origin + '/library/'));
    assert.equal(asset.status, 200, path);
    await asset.arrayBuffer();
  }
  const api = origin + '/api/pages/';
  assert.equal((await (await fetch(api + 'connection')).json()).api, null);
  assert.equal((await fetch(api + 'ask', jsonPost(origin, {}))).status, 409);
  assert.equal((await fetch(api + 'latex/projects', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const foreign = await fetch(api + 'pdf/list', jsonPost('https://example.org', {}));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(api + 'latex/create', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(api + 'pdf/list', { method:'POST', headers: { origin }, body: '{}' })).status, 415);
  assert.equal((await fetch(origin + '/api/command')).status, 404);
  const unexpectedHost = await new Promise((resolve, reject) => {
    request(origin + '/api/pages/connection', { headers: { host: 'example.org' } }, res => { res.resume(); resolve(res.statusCode); })
      .on('error', reject).end();
  });
  assert.equal(unexpectedHost, 403);
  const papers = await fetch(api + 'pdf/list', jsonPost(origin, {}));
  assert.equal(papers.status, 200);
  assert.deepEqual((await papers.json()).items, []);
  const project = await fetch(api + 'latex/create', jsonPost(origin, { title: 'Synthetic manuscript' }));
  assert.equal(project.status, 201);
  const list = await (await fetch(api + 'latex/projects')).json();
  assert.equal(list.projects[0].id, (await project.json()).project.id);
});

test('only a submitted excerpt contacts the explicitly configured model endpoint', async t => {
  const calls = [];
  const modelServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'application/json');
    if (calls.length === 1) { res.writeHead(503); res.end(); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic answer' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  t.after(() => close(modelServer));
  const endpoint = 'http://127.0.0.1:' + modelServer.address().port + '/v1/chat/completions';
  const keyEnv = 'PAPER_LIBRARY_SYNTHETIC_' + process.pid;
  process.env[keyEnv] = 'fixture-value-for-this-test';
  t.after(() => { delete process.env[keyEnv]; });
  const origin = await startLocal(t, ['--api-url', endpoint, '--api-model', 'example', '--api-key-env', keyEnv]);
  const api = origin + '/api/pages/';
  const connection = await (await fetch(api + 'connection')).json();
  assert.deepEqual(connection.api, { endpoint, model: 'example' });
  assert.equal((await fetch(api + 'pdf/list', jsonPost(origin, {}))).status, 200);
  assert.equal((await fetch(api + 'ask', jsonPost(origin, { question: 'hello', excerpt: '' }))).status, 400);
  assert.deepEqual(calls, []);
  const payload = { question: 'Summarize', excerpt: 'An invented passage.', file: '/unrelated/file.pdf' };
  assert.equal((await fetch(api + 'ask', jsonPost(origin, payload))).status, 502);
  assert.equal(calls.length, 1);
  const answer = await fetch(api + 'ask', jsonPost(origin, payload));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { answer: 'Synthetic answer', model: 'example' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].auth, 'Bearer fixture-value-for-this-test');
  assert.equal(calls[1].url, '/v1/chat/completions');
  assert.deepEqual(JSON.parse(calls[1].body.messages[1].content), { question: payload.question, excerpt: payload.excerpt });
});

test('service setup requires an explicit local library and a complete opt-in API endpoint', async () => {
  await assert.rejects(startPages([]), /--library/);
  await assert.rejects(startPages(['--library', join(projectRoot, 'docs/demo/unused-library')]), /资料库/);
  assert.equal(configurePagesModel({}), null);
  for (const apiUrl of ['http://example.org/completions', 'https://example.org/path?key=example', 'https://user@example.org/path']) {
    assert.throws(() => configurePagesModel({ apiUrl, apiModel: 'example' }));
  }
  assert.throws(() => configurePagesModel({ apiUrl: 'https://example.org/chat', apiModel: 'example', apiKeyEnv: 'MY_KEY' }, { env:{} }), /密钥/);
  await assert.rejects(readBytes(new Response('1234'), 3), error => error.status === 413);
});
