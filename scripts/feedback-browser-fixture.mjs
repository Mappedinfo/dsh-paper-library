/** Isolated AI-feedback write-back flow: two synthetic annotations, two separate
 * replies plus one combined answer. Asserts the rail shows each answer under the
 * annotation it belongs to and never copies one answer across annotations.
 * No model call and no network request is involved. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/feedback-browser-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [], errors = [], external = [];
const record = value => { checks.push(value); console.log(`PASS ${value}`); };
const generated = spawnSync(join(project, '.venv/bin/python'), ['scripts/create-reader-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const python = join(project, '.venv/bin/python');
const imported = await core({ action: 'import', path: join(source, 'reader-export.json') }, { library, python });
const paper = imported.items[0];
const page = await core({ action: 'page', id: paper.id, page: 1 }, { library, python });
const words = page.words.filter(word => typeof word[4] === 'string' && word[4].trim().length > 4).slice(0, 2);
const first = (await core({ action: 'annotate', id: paper.id, page: 1, type: 'highlight', rects: [words[0].slice(0, 4)], text: words[0][4], comment: '第一条问题' }, { library, python })).annotation;
const second = (await core({ action: 'annotate', id: paper.id, page: 1, type: 'highlight', rects: [words[1].slice(0, 4)], text: words[1][4], comment: '第二条问题' }, { library, python })).annotation;
const split = await core({ action: 'save_feedback', id: paper.id, model: 'synthetic/model', annotation_ids: [first.id, second.id],
  replies: [{ annotation_id: first.id, comment: '只回答第一条批注。' }, { annotation_id: second.id, comment: '只回答第二条批注。' }] }, { library, python });
assert.deepEqual(split.replies.map(reply => reply.annotation_id), [first.id, second.id]);
assert.equal(split.split, true);
const combined = await core({ action: 'save_feedback', id: paper.id, text: '合并回答：两条批注一起说明。', model: 'synthetic/model', annotation_ids: [first.id, second.id] }, { library, python });
assert.ok(combined.annotation_id, 'A combined answer is stored as a single note');
const single = await core({ action: 'save_feedback', id: paper.id, text: '单条回答：只针对这张便笺。', model: 'synthetic/model', annotation_ids: [first.id] }, { library, python });
assert.ok(single.annotation_id);

let server, browser, startTimer;
try {
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: join(run, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => { startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000); server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); }); server.on('error', reject); server.on('exit', code => reject(new Error(`Server exited ${code}`))); });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page0 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page0.on('pageerror', error => errors.push(error.message));
  page0.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); });
  await page0.goto(origin); await page0.waitForLoadState('networkidle');
  await page0.waitForSelector(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page0.click(`#paper-list .paper-card[data-id="${paper.id}"]`);
  await page0.locator('#reader-annotations').click();
  await page0.locator('.library-pane #annotations-tab').waitFor();
  const railCard = id => page0.locator(`#annotation-list > .annotation-card[data-annotation-id="${id}"]`);
  await railCard(first.id).waitFor();
  const bodies = id => railCard(id).locator('.annotation-reply-body').allTextContents();
  const firstReplies = await bodies(first.id), secondReplies = await bodies(second.id);
  assert.equal(firstReplies.length, 3, `First annotation keeps its own reply, the combined answer and the single answer: ${JSON.stringify(firstReplies)}`);
  assert.equal(secondReplies.length, 1, `Second annotation must not inherit other answers: ${JSON.stringify(secondReplies)}`);
  assert.ok(firstReplies.some(text => text.includes('只回答第一条批注。')), 'The first annotation keeps its own answer');
  assert.ok(firstReplies.some(text => text.includes('合并回答：两条批注一起说明。')), 'The combined answer is shown where it belongs');
  assert.ok(firstReplies.some(text => text.includes('单条回答：只针对这张便笺。')), 'A single answer is shown once');
  assert.ok(secondReplies.some(text => text.includes('只回答第二条批注。')), 'The second annotation keeps its own answer');
  assert.ok(!secondReplies.some(text => text.includes('只回答第一条批注。') || text.includes('合并回答')), 'No answer is copied onto the other annotation');
  record('each-generated-reply-nests-under-its-own-annotation');
  const railText = await page0.locator('#annotation-list').evaluate(node => node.textContent);
  assert.equal(railText.split('合并回答：两条批注一起说明。').length - 1, 1, 'A combined answer appears exactly once');
  assert.equal(railText.split('只回答第一条批注。').length - 1, 1, 'Per-annotation answers appear exactly once');
  record('a-combined-or-single-answer-appears-exactly-once');
  // The reply must also be a real PDF object linked to its annotation.
  const annotations = (await core({ action: 'annotations', id: paper.id }, { library, python })).annotations;
  for (const [index, annotation] of [first, second].entries()) {
    const note = annotations.find(candidate => candidate.kind === 'ai-feedback' && candidate.reply_to === annotation.id && candidate.comment.includes(index ? '只回答第二条批注。' : '只回答第一条批注。'));
    assert.ok(note, `A stored reply is linked to ${annotation.id}`);
    assert.deepEqual(note.annotation_ids, [annotation.id], 'A stored reply cites exactly one annotation');
  }
  record('stored-replies-carry-exactly-their-own-annotation-id');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/feedback-browser.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic standalone UI: per-annotation feedback write-back rendering and PDF linking; no model call or external request',
  checks, errors, modelRequests: 0, externalRequests: external.length,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
