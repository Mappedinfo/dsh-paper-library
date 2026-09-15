/** Isolated bibliography-build browser flow: synthetic catalog only, no model or
 * network lookup. Exercises the shelf button, the audit dialog and the files
 * written inside the library's exports directory. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';
const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/bibliography-browser-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const generated = spawnSync(join(project, '.venv/bin/python'), ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' }); assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library });
assert.ok(imported.items.length >= 2);
let server, browser, startTimer; const errors = [];
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: process.env.DSH_HOME || join(run, 'dsh-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => { startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`))); }); clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 741, height: 597 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForLoadState('networkidle');
  await page.locator('#build-bibliography').waitFor();
  assert.equal(await page.locator('#build-bibliography').isEnabled(), true);
  await page.locator('#build-bibliography').click();
  await page.locator('#text-dialog').waitFor();
  await page.waitForFunction(() => document.getElementById('copy-fallback')?.value.includes('references.bib'));
  const summary = await page.locator('#copy-fallback').inputValue();
  assert.match(summary, /身份审计/); assert.match(summary, /引用键冲突：0/); assert.match(summary, /未做在线 DOI 核验/);
  record('shelf-button-builds-bibliography-and-shows-audit-summary');
  const bib = await readFile(join(library, 'exports', 'references.bib'), 'utf8');
  assert.match(bib, /@/); assert.ok(bib.length > 100);
  const audit = JSON.parse(await readFile(join(library, 'exports', 'bibliography.audit.json'), 'utf8'));
  assert.equal(audit.totals.records, imported.items.length);
  assert.equal(audit.verification.requested, false);
  record('exports-directory-contains-bib-and-audit-after-browser-build');
  await page.keyboard.press('Escape'); await page.locator('#text-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []); record('no-browser-runtime-errors');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/bibliography-browser.json'), JSON.stringify({ verified_at: new Date().toISOString(), scope: 'Synthetic catalog in an isolated standalone server; browser build button, audit dialog and exports files; no model calls or network requests', checks, errors }, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
