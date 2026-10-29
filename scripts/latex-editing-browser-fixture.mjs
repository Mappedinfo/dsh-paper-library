/** Synthetic desktop checks for local spelling and selected-draft translation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, dispatch } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { createLanguageLearning } from '../src/harness/language-learning.mjs';
import { createLatexAI } from '../src/harness/latex-ai.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/latex-editing-'));
const library = join(run, 'library'), manuscript = join(run, 'manuscript'), python = join(project, '.venv/bin/python');
await mkdir(manuscript);
await writeFile(join(manuscript, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nThis is a synthetic sentense with 100\\% acheivement.\n$wrod + x$ \\cite{wrod}\n\\end{document}\n');
const options = { library, python };
const created = (await core({ action: 'latex_project_create', root: manuscript, title: 'Synthetic editing tools' }, options)).project;
const store = createLocalStateStore({ library, home: join(run, 'home') });
const modelList = [{ provider: 'synthetic', id: 'default-model', name: 'Synthetic default' }, { provider: 'synthetic', id: 'flash-model', name: 'Synthetic Flash' }];
const models = async () => ({ models: modelList, configured: true });
const getDefaultModel = () => ({ provider: 'synthetic', model: 'default-model' });
const calls = [], errors = [], checks = [];
const ai = async request => { const selection = JSON.parse(request.prompt.split('SOURCE_JSON:\n')[1]).text; calls.push({ provider: request.provider, model: request.model, selection }); return '合成译文：仅翻译明确选择的编辑草稿。'; };
const latexAI = createLatexAI({ store, ai, models, getDefaultModel, dispatch, library, python });
const languageLearning = createLanguageLearning({ store, models, getDefaultModel, dispatch, library, python });
const handle = createFetchHandler({ ...options, localState: store, languageLearning, latexAI, models });
const server = createServer(async (req, res) => {
  try {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    const response = await handle(request); res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch { if (!res.headersSent) res.writeHead(500); res.end('Synthetic fixture request failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const api = async input => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await fetch(`${origin}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (r.status === 429) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    const body = await r.json(); assert.equal(body.ok, true, body.error); return body.result;
  }
  throw new Error('Synthetic API admission did not clear');
};
const setting = await api({ action: 'settings_get' });
await api({ action: 'settings_update', patch: { latex_auto_compile: false }, expected_revision: setting.revision });
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
let browser, dictionaryRequests = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const open = async fallback => {
    const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/latex-spelling.js')) dictionaryRequests++; if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('external request'); });
    if (fallback) await page.route('**/latex-editor.js', route => route.fulfill({ contentType: 'text/javascript', body: '/* Synthetic enhanced-editor absence. */' }));
    await page.goto(`${origin}/?view=latex`, { waitUntil: 'networkidle' });
    await page.locator(fallback ? '#latex-editor' : '.cm-content').waitFor({ state: 'visible' }); return page;
  };
  const page = await open(false);
  assert.equal(dictionaryRequests, 0);
  assert.match(await page.locator('#latex-nav-toggle').innerText(), /侧边导航/);
  await page.locator('#latex-nav-toggle').click(); assert.equal(await page.locator('#latex-nav-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('#latex-nav-toggle').click();
  assert.equal(await page.locator('#latex-review-open').evaluate(node => node.previousElementSibling?.getAttribute('role')), 'separator');
  record('sidebar switch and a separate review toolbar divider preserve their semantics');

  await page.locator('#latex-spell-toggle').click();
  await page.locator('#latex-spelling-results').getByRole('button', { name: 'sentense', exact: true }).waitFor();
  await page.locator('#latex-spelling-results').getByRole('button', { name: 'acheivement', exact: true }).waitFor();
  assert.equal(await page.locator('#latex-spelling-results').getByRole('button', { name: 'wrod', exact: true }).count(), 0);
  assert.equal(dictionaryRequests, 1);
  await page.locator('#latex-spelling-results').getByRole('button', { name: 'sentense', exact: true }).click();
  await page.waitForFunction(() => window.getSelection()?.toString() === 'sentense');
  record('the dictionary loads only on demand, checks prose after escaped percent, and locates words');

  await page.locator('#latex-menu-open').click();
  await page.locator('#latex-translate-model option').filter({ hasText: 'Synthetic Flash' }).waitFor({ state: 'attached' });
  const route = JSON.stringify({ provider: 'synthetic', model: 'flash-model' });
  await page.locator('#latex-translate-model').selectOption(route);
  await page.locator('#latex-translate-prompt').fill('Keep LaTeX commands unchanged.');
  await page.locator('#latex-translate-settings-save').click();
  await page.locator('#latex-menu-open').click();
  const draft = '\\begin{abstract}\nA newly typed draft phrase for translation.\n\\end{abstract}';
  await page.locator('.cm-content').fill(draft); await page.locator('.cm-content').press('ControlOrMeta+A');
  await page.locator('#latex-translate-selection').click();
  await page.locator('#latex-translation-results').filter({ hasText: '合成译文' }).waitFor();
  assert.equal(calls.length, 1); assert.equal(calls[0].model, 'flash-model'); assert.equal(calls[0].selection, draft);
  assert.equal((await api({ action: 'latex_project_get', id: created.id })).project.id, created.id);
  await page.screenshot({ path: join(run, 'latex-editing-1512.png') });
  record('project model configuration translates only the selected draft through a local model double');

  const fallback = await open(true);
  await fallback.locator('#latex-editor').fill('A synthetic sentense.');
  if (await fallback.locator('#latex-spell-toggle').getAttribute('aria-pressed') !== 'true') await fallback.locator('#latex-spell-toggle').click();
  await fallback.locator('#latex-spelling-results').getByRole('button', { name: 'sentense', exact: true }).waitFor();
  assert.ok(dictionaryRequests >= 2);
  await fallback.locator('#latex-spell-toggle').click(); assert.equal(await fallback.locator('#latex-spelling-results').isVisible(), false);
  record('the textarea fallback keeps independent local spelling and a working off switch');
  assert.deepEqual(errors, []); record('no browser errors, external requests or real model calls');
} finally {
  await browser?.close(); await handle.disposeInkQueue(); await new Promise(resolve => server.close(resolve));
}
await writeFile(join(run, 'report.json'), JSON.stringify({ checks, errors, deterministicModelCalls: calls.length, dictionaryRequests }, null, 2));
console.log(JSON.stringify({ run, checks: checks.length, errors }));
