import { createServer } from 'node:http';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { core, projectRoot } from './bridge.mjs';
import { handlePdf } from './pages-pdf.mjs';
import { handleLatex } from './pages-latex.mjs';
import { configurePagesModel, readBytes } from './pages-model.mjs';

const defaultPython = join(projectRoot, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const directory = join(projectRoot, 'site/library-local');
const assets = new Map([['/library/', join(directory, 'index.html')]]);
for (const name of ['app.js', 'client.js', 'shell.css', 'pdf.js', 'pdf.css', 'latex.js', 'latex.css']) {
  assets.set('/library/' + name, join(directory, name));
}
for (const name of ['pdf-reader.js', 'pdf-reader.css']) assets.set('/' + name, join(projectRoot, 'web', name));

const policies = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};
const fail = (message, status) => Object.assign(new Error(message), { status });

async function readJson(request, limit = 1024 * 1024) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw fail('需要 JSON 数据。', 415);
  const bytes = await readBytes(request, limit);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw fail('请求的 JSON 无效。', 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('请求需要 JSON 对象。', 400);
  return parsed;
}

async function route(request, options) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET') {
    if (path === '/' || path === '/library') return new Response(null, { status: 302, headers: { location: '/library/' } });
    const file = assets.get(path);
    if (file) {
      const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
      return new Response(await readFile(file), { headers: { 'content-type': type + '; charset=utf-8' } });
    }
  }
  if (!path.startsWith('/api/pages/')) throw fail('找不到该入口。', 404);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== url.origin) || (site && site !== 'same-origin')) throw fail('请从本机工作台访问资料库。', 403);
  if (!['GET', 'POST'].includes(request.method)) throw fail('不支持此方法。', 405);
  if (request.method === 'POST') {
    if (origin !== url.origin) throw fail('写入需要来自本机工作台。', 403);
    if (!['application/json', 'application/pdf'].includes(request.headers.get('content-type')?.split(';')[0].trim())) throw fail('不支持此数据格式。', 415);
  }
  if (path === '/api/pages/connection' && request.method === 'GET') {
    return Response.json({ library: options.library, name: basename(options.library) || options.library, api: options.model?.info ?? null });
  }
  if (path === '/api/pages/ask' && request.method === 'POST') {
    if (!options.model) throw fail('此工作台未配置模型 API。', 409);
    return Response.json(await options.model.ask(await readJson(request, 96 * 1024), request.signal));
  }
  const context = { library: options.library, readJson, readBytes,
    run: (action, payload = {}) => core({ ...payload, action }, {
      library: options.library, python: options.python, workerEnv: options.workerEnv, signal: request.signal,
    }) };
  return await handlePdf(request, context) ?? await handleLatex(request, context) ?? Response.json({ error: '找不到该入口。' }, { status: 404 });
}

export function createPagesServer(options) {
  const server = createServer(async (req, res) => {
    try {
      const port = server.address().port;
      const hosts = ['127.0.0.1', 'localhost'].map(host => port === 80 ? host : host + ':' + port);
      if (!hosts.includes(req.headers.host) || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw fail('仅允许本机地址。', 403);
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) && { body: Readable.toWeb(req), duplex: 'half' }), signal: controller.signal });
      const response = await route(request, options);
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...policies });
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
      else res.end();
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      const status = error.status >= 400 && error.status <= 599 ? error.status : 400;
      res.writeHead(status, { ...policies, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message || '本机操作未完成。' }));
    }
  });
  return server;
}

export const pagesUsage = 'paper-library pages --library <本地资料库目录> [--port 43122] [--python <解释器>] [--api-url <完整接口地址> --api-model <模型名> [--api-key-env <变量名>]]';

// Resolve existing ancestors even when the reader is starting a new library.
async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

export async function startPages(args) {
  const names = ['library', 'port', 'python', 'api-url', 'api-model', 'api-key-env'];
  const { values } = parseArgs({ args, options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
  if (!values.library?.trim()) throw new Error('请用 --library 选择本机资料库目录。');
  const port = Number(values.port ?? 43122);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效。');
  const python = values.python || defaultPython;
  if (!values.python) await access(python).catch(() => { throw new Error('请在源码目录运行 uv sync，或用 --python 指定已安装项目依赖的解释器。'); });
  const keyName = values['api-key-env'];
  const model = configurePagesModel({ apiUrl: values['api-url'], apiModel: values['api-model'], apiKeyEnv: keyName });
  const workerEnv = { ...process.env };
  if (keyName) {
    // Windows environment variable names are case-insensitive.
    for (const name of Object.keys(workerEnv)) {
      if (name === keyName || (process.platform === 'win32' && name.toUpperCase() === keyName.toUpperCase())) delete workerEnv[name];
    }
  }
  const library = await canonical(resolve(values.library));
  const localPath = relative(await realpath(projectRoot), library);
  if (!isAbsolute(localPath) && localPath !== '..' && !localPath.startsWith('..' + sep) &&
      !['.local', '.data', 'data', '.paper-library'].includes(localPath.split(sep)[0])) {
    throw new Error('请选择项目源码目录之外的资料库，或使用项目已忽略的 .data、data、.local、.paper-library 目录。');
  }
  const server = createPagesServer({ library, python, model, workerEnv });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  console.log('本机工作台 http://127.0.0.1:' + server.address().port + '/library/\n资料库 ' + library);
  return server;
}
