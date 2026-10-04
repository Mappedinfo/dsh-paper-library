/** Capture the current complete LaTeX workspace with a real compiled synthetic PDF.
 * Uses the shipped standalone HTTP/page/worker surfaces and an isolated state store.
 * No user library, DSH host, model service or external URL is opened.
 * Run: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-latex-demo.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';

assert.equal(process.argv.length, 2, 'This script takes no arguments and only creates its own synthetic demo.');
const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/latex-demo-'));
const library = join(run, 'library'), manuscript = join(run, 'manuscript');
const python = join(project, '.venv/bin/python');
await mkdir(manuscript, { recursive: true });
const source = String.raw`\documentclass[11pt]{article}
\usepackage[margin=22mm]{geometry}
\title{From Reading Notes to a Manuscript}
\author{Paper Library --- Synthetic Demonstration}
\date{}

\begin{document}
\maketitle
\begin{abstract}
This original example demonstrates a writing workflow.
It contains no empirical result or published quotation.
Reading notes, source files and the compiled PDF remain
available together for review.
\end{abstract}

\section{Keep the question with the evidence}
Start with a passage, record a question, and preserve
where it came from. Before drafting a claim, check
whether the evidence actually supports its scope.

\section{Move from notes to a reviewable draft}
\begin{enumerate}
  \item Collect the passages relevant to one question.
  \item Write a bounded claim in the source file.
  \item Compile and inspect the resulting page.
  \item Review proposed changes before accepting them.
\end{enumerate}

\section{A useful checkpoint}
Can a reader trace each claim back to its source?
Keep unresolved questions visible while revising.

\medskip
\noindent\textit{Synthetic example only.
No real paper, private notes or model response is shown.}
\end{document}
`;
const sourcePath = join(manuscript, 'main.tex');
await writeFile(sourcePath, source);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sourceHash = await hash(sourcePath);
const created = await core({ action: 'latex_project_create', root: manuscript, title: '从阅读笔记到手稿 · 合成演示' }, { library, python });
const localState = createLocalStateStore({ library, home: join(run, 'home') });
const handle = createFetchHandler({ library, python, localState, loopbackOnly: true });
const server = createServer(async (request, response) => {
  try {
    const input = new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method, headers: request.headers,
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
    });
    const result = await handle(input);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body).pipe(response); else response.end();
  } catch { response.writeHead(500); response.end('Synthetic demonstration service failed.'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const checks = [], errors = [], external = [], actions = [];
let browser, page, failure, compilation, screenshot;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { external.push(url); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api')) try { actions.push(request.postDataJSON().action); } catch {}
  });
  await page.goto(`${origin}/?view=latex`);
  await page.waitForLoadState('networkidle');
  await page.locator('#latex-view').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#latex-editor')?.value.includes('From Reading Notes to a Manuscript'));
  assert.equal(await page.locator('#latex-editor').inputValue(), source);
  assert.equal(await page.locator('#latex-project').inputValue(), created.project.id);
  assert.equal(await page.locator('#reading-sidebar-latex-ai').isVisible(), true);
  assert.equal(await page.locator('#reading-sidebar-library').isVisible(), false);
  checks.push('Current shipped page opens the registered synthetic source with DSH writing in the shared reading rail.');

  const compiled = page.waitForResponse(response => {
    try { return response.request().postDataJSON().action === 'latex_compile'; } catch { return false; }
  }, { timeout: 150000 });
  await page.locator('#latex-compile').click();
  const response = await (await compiled).json();
  assert.equal(response.ok, true, response.error);
  compilation = response.result;
  assert.equal(compilation.ok, true, compilation.log_tail);
  assert.equal(compilation.exit_code, 0);
  assert.equal(compilation.pages, 1);
  assert.deepEqual(compilation.errors, []);
  await page.waitForFunction(() => {
    const image = document.querySelector('#latex-preview img');
    return image?.complete && image.naturalWidth > 0;
  });
  assert.match(await page.locator('#latex-build-info').innerText(), /xelatex.*1 页/);
  assert.match(await page.locator('#latex-page-label').innerText(), /第 1 \/ 1 页/);
  assert.equal(await page.locator('#latex-errors li').count(), 0);
  checks.push('The visible Compile action runs the real local latexmk/xelatex and renders its successfully generated one-page PDF.');

  await page.waitForFunction(() => /需要连接 DSH 模型服务|未连接 DSH 模型服务/.test(document.querySelector('#latex-ai-route')?.textContent || ''));
  assert.equal((await page.locator('#latex-ai-answer').innerText()).trim(), '');
  assert.equal((await page.locator('#latex-ai-proposal').innerText()).trim(), '');
  assert.ok(!actions.some(action => ['latex_ai_ask', 'latex_ai_propose', 'latex_ai_accept'].includes(action)));
  checks.push('The standalone collaboration rail truthfully reports its missing DSH model connection; no answer or proposal is fabricated.');

  assert.equal(await hash(sourcePath), sourceHash);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  checks.push('Synthetic source remains unchanged, no private document or external/model request is used, and the current UI fits the viewport.');
  const path = join(project, 'docs/images/project-latex.jpg');
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, type: 'jpeg', quality: 94 });
  screenshot = { file: relative(project, path), width: 1440, height: 1080, sha256: await hash(path), description: 'Current LaTeX source and its actual compiled PDF, with the shared DSH writing rail honestly disconnected in standalone mode.' };
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  await handle.disposeInkQueue?.();
  await new Promise(resolve => server.close(resolve));
}
const receipt = {
  captured_at: new Date().toISOString(), complete: !failure, synthetic: true,
  source_generator: 'scripts/capture-latex-demo.mjs', runtime_directory: relative(project, run),
  mode: 'Current standalone Chromium page, light theme, 1440 × 1080 CSS pixels',
  ...(screenshot ? { screenshot } : {}),
  ...(compilation ? { compilation: { engine: compilation.engine, exit_code: compilation.exit_code, ok: compilation.ok, pages: compilation.pages, duration_ms: compilation.duration_ms, errors: compilation.errors, warnings: compilation.warnings } } : {}),
  source_sha256: sourceHash, checks, private_documents_read: 0, external_requests: external.length,
  model_requests: 0, browser_errors: errors,
  limitations: [
    'Standalone screenshot, not a live DSH host or model-quality demonstration.',
    'Original synthetic manuscript; no real paper, research finding or model output.',
    'Direct browser JPEG without retouching, injected DOM content or style overrides.',
    'Reproduction requires the project Python environment, Playwright and local latexmk/xelatex.',
  ],
  ...(failure ? { error: failure.message } : {}),
};
await writeFile(join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
if (failure) { console.error(`LaTeX demonstration diagnostics: ${relative(project, run)}`); throw failure; }
await writeFile(join(project, 'docs/community/latex-demo.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), screenshot: screenshot.file, checks: checks.length, compiled_pages: compilation.pages }));
