/** Isolated challenge-mining browser flow: synthetic catalog only, no model or
 * network access. Exercises the corpus panel, the P1 scan receipts, the P3
 * aggregation, the review gate and the exports files. The model stages (P2 and
 * model merge suggestions) stay disabled in this standalone server, which the
 * fixture asserts instead of faking. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/challenge-browser-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const generated = spawnSync(join(project, '.venv/bin/python'), ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library });
assert.ok(imported.items.length >= 2, 'The demo import provides at least two papers');

/** One reviewed difficulty draft per paper, built exactly like the P2 output. */
const quotes = ['A key limitation is that our synthetic evaluation covers only one city.', 'A key limitation is that our synthetic evaluation covers one city only.'];
for (const [index, paper] of imported.items.slice(0, 2).entries()) {
  const src = await core({ action: 'knowledge_source_put', entity: { kind: 'paper', id: paper.id }, kind: 'user-text', text: quotes[index], locator: { page: index + 2 } }, { library });
  let draft = await core({
    action: 'knowledge_draft_put', entity: { kind: 'paper', id: paper.id }, mode: 'graph', origin: 'llm',
    title: 'Synthetic difficulty fixture', text: quotes[index], source_ids: [src.id], request_id: `fixture-${paper.id}`,
    nodes: [{ id: 'single-city', type: 'gap', label: 'Synthetic evaluation covers only one city', source_status: 'author-stated' },
            { id: 'evidence-one', type: 'evidence', label: 'Synthetic limitation quote', source_id: src.id, quote: quotes[index] }],
    assertions: [{ subject: 'evidence:evidence-one', object: 'gap:single-city', relation: 'identifies' }],
  }, { library });
  draft = await core({ action: 'knowledge_draft_review', id: draft.id, reviewed_by: 'user', decision: 'accepted', expected_revision: draft.revision }, { library });
  assert.equal(draft.status, 'accepted');
}

let server, browser, startTimer;
const errors = [], external = [];
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: process.env.DSH_HOME || join(run, 'dsh-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => { startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`))); });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  await page.locator('#challenge-open').waitFor();
  await page.locator('#challenge-open').click();
  await page.locator('#challenge-panel').waitFor();
  record('corpus-panel-opens-from-the-shelf-without-calling-a-model');
  assert.equal(await page.locator('#challenge-extract').isDisabled(), true, 'P2 needs the host subagent, which the standalone server has not');
  await page.locator('#challenge-select-all').click();
  await page.locator('#challenge-scan').click();
  await page.waitForFunction(() => /候选段落/.test(document.getElementById('challenge-result')?.textContent || ''));
  const scanText = await page.locator('#challenge-result').innerText();
  assert.match(scanText, /P1 · 候选段落/);
  assert.match(scanText, /零模型调用/);
  assert.match(await page.locator('#challenge-status').innerText(), /零模型调用/);
  record('p1-scan-renders-section-and-trigger-receipts-for-the-selected-corpus');
  await page.locator('#challenge-aggregate').click();
  await page.waitForFunction(() => /P3 · 主题草稿/.test(document.getElementById('challenge-result')?.textContent || ''));
  const themeText = await page.locator('#challenge-result').innerText();
  assert.match(themeText, /待核对/);
  assert.match(themeText, /覆盖 2 篇 \/ 2 条记录/);
  assert.match(themeText, /author-stated 2/);
  assert.match(themeText, /\[@/, 'Rendered quotes keep their citekeys');
  record('p3-aggregation-renders-coverage-counters-years-and-quoted-evidence');
  await page.locator('#challenge-export').click();
  await page.waitForFunction(() => /导出未完成/.test(document.getElementById('challenge-status')?.textContent || ''));
  assert.match(await page.locator('#challenge-status').innerText(), /CHALLENGE_MISSING|没有已核对的/, 'Unreviewed themes are never exported');
  record('export-refuses-to-write-unreviewed-themes');
  await page.locator('#challenge-accept-' + (await page.locator('[id^="challenge-accept-"]').first().getAttribute('id')).slice('challenge-accept-'.length)).click();
  await page.waitForFunction(() => /主题已接受/.test(document.getElementById('challenge-status')?.textContent || ''));
  assert.match(await page.locator('#challenge-status').innerText(), /主题已接受（修订 2）/);
  await page.locator('#challenge-export').click();
  await page.waitForFunction(() => /已写入文献库 exports\//.test(document.getElementById('challenge-status')?.textContent || ''));
  record('accepted-theme-exports-after-an-explicit-human-review');
  const csv = await readFile(join(library, 'exports', 'challenges.csv'), 'utf8');
  assert.match(csv.split('\n')[0], /^theme_id,theme_label,theme_status,theme_revision/);
  assert.match(csv, /"accepted"/);
  const markdown = await readFile(join(library, 'exports', 'challenges.md'), 'utf8');
  assert.match(markdown, /研究难点主题导出/);
  assert.match(markdown, /待审阅的合并建议/);
  const bib = await readFile(join(library, 'exports', 'challenges.bib'), 'utf8');
  assert.match(bib, /@\w+\{/);
  record('exports-directory-holds-csv-markdown-and-bibtex-after-the-browser-flow');
  await page.locator('#challenge-check').click();
  await page.waitForFunction(() => /P4 · 结构检查/.test(document.getElementById('challenge-result')?.textContent || ''));
  const checkText = await page.locator('#challenge-result').innerText();
  assert.match(checkText, /结构检查（只读）/);
  assert.match(checkText, /主题 1 个/);
  assert.match(checkText, /theme-revised/, 'A re-aggregated theme is flagged before export');
  record('p4-structural-check-reports-verifiable-findings-only');
  await page.fill('#challenge-checklist', '# 我的清单\n- synthetic evaluation covers only one city\n- 未被覆盖的方向\n');
  await page.fill('#challenge-checklist-label', '合成清单');
  await page.locator('#challenge-comparison').click();
  await page.waitForFunction(() => /与自有清单对照/.test(document.getElementById('challenge-result')?.textContent || ''));
  const compareText = await page.locator('#challenge-result').innerText();
  assert.match(compareText, /合成清单/);
  assert.match(compareText, /覆盖 1/);
  assert.match(compareText, /缺口 1/);
  assert.match(compareText, /未被覆盖的方向/);
  assert.match(compareText, /κ/, 'The report keeps manual agreement out of scope');
  record('p4-comparison-matches-entries-and-lists-gaps-with-provenance');
  await page.locator('#challenge-packet').click();
  await page.waitForFunction(() => /评审包已写入/.test(document.getElementById('challenge-status')?.textContent || ''));
  const packetMarkdown = await readFile(join(library, 'exports', 'challenges-review-packet.md'), 'utf8');
  assert.match(packetMarkdown, /研究难点人工评审包/);
  assert.match(packetMarkdown, /与自有清单的对照/);
  assert.match(packetMarkdown, /challenge_theme_review/);
  const packetJson = JSON.parse(await readFile(join(library, 'exports', 'challenges-review-packet.json'), 'utf8'));
  assert.equal(packetJson.schema, 'paper-library-challenge-review-packet.v1');
  assert.equal(packetJson.comparison.checklist.source.startsWith('合成清单'), true);
  assert.equal(packetJson.counts.info >= 1, true);
  assert.equal(packetJson.counts.error, 0);
  assert.equal(packetJson.model_calls, 0);
  record('p4-review-packet-writes-findings-and-comparison-for-human-review');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/challenge-mining-browser.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic catalog in an isolated standalone server; corpus panel, P1 scan receipts, P3 aggregation, review gate, P4 structural check/comparison/review packet and exports files; no model calls and no external requests. The P2 extraction and model merge suggestions need the host subagent and are asserted to be disabled here instead of simulated.',
  checks, errors, externalRequests: external.length, modelRequests: 0,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
