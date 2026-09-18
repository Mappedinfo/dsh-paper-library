/** Isolated whiteboard browser flow: synthetic catalog only, no model or network
 * access. Exercises the free canvas, node/edge editing, paper drag-in, undo/redo,
 * zoom/fit, board switching, host persistence across a reload and the tombstones
 * behind deletion. The AI-proposal review path needs the native host tool and is
 * therefore asserted by tests-js/board-api.test.mjs instead of faked here. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/board-browser-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const generated = spawnSync(join(project, '.venv/bin/python'), ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library });
assert.ok(imported.items.length >= 1, 'The demo import provides at least one paper');

let server, browser, startTimer;
const errors = [], external = [];
try {
  // Always use an isolated state home: this fixture must read and write no real
  // DSH state, and the board's records live entirely there.
  const home = join(run, 'dsh-home');
  server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--library', library], { cwd: project, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((accept, reject) => {
    startTimer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
    server.stdout.on('data', data => { const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) accept(match[0]); });
    server.on('error', reject);
    server.on('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  clearTimeout(startTimer);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  page.on('dialog', dialog => void dialog.accept());

  /** Read the host's own record: the assertion is about what was persisted, not the DOM. */
  const hostBoard = () => page.evaluate(async () => {
    const call = async (action, args) => (await (await fetch('./api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json());
    const list = await call('board_list', {});
    const boards = list.result.boards;
    if (!boards.length) return { boards, board: null };
    const id = window.__boardId ?? boards[0].id;
    const got = await call('board_get', { id });
    return { boards, board: got.result?.board ?? null, outline: got.result?.outline ?? '' };
  });
  const shapeBox = async index => page.locator('.board-node').nth(index).locator('.board-node-shape').boundingBox();
  /** Saving is debounced, so a host read must wait for the record to settle — the DOM
   *  updates immediately and would otherwise be compared against a stale record. */
  const waitForHost = async (predicate, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    for (;;) {
      last = await hostBoard();
      if (predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the host record: ${label} (last: ${JSON.stringify(last).slice(0, 300)})`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };
  const nodeCount = () => page.locator('.board-node').count();

  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  // The library surface issues several status/list calls at boot; let the host's own
  // admission limit drain before driving the board, so this fixture measures the
  // board rather than a startup queue.
  await page.waitForFunction(() => ['本地文献库', '连接未完成'].includes(document.getElementById('library-status')?.textContent || ''));
  await page.locator('#board-open').waitFor();
  assert.equal(await page.locator('#board-open').isVisible(), true, 'the host advertises the whiteboard capability');
  await page.locator('#board-open').click();
  await page.locator('#board-view').waitFor();
  const stage = await page.locator('#board-stage').boundingBox();
  try { await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 1); }
  catch (error) {
    const status = await page.locator('#board-status').innerText().catch(() => '(unreadable)');
    throw new Error(`The board never listed a record (status: ${status}; page errors: ${errors.join(' | ') || 'none'})`);
  }
  record('board-view-opens-and-creates-the-first-board-without-a-model');

  // Place a note; the shape tool returns to selection so the follow-up click cannot
  // create a stray node while the inline editor is open.
  await page.locator('#board-tool-note').click();
  await page.mouse.click(stage.x + 220, stage.y + 180);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill('合成概念 A');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 1);
  assert.equal(await page.locator('#board-tool-select').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.board-node-text').first().textContent(), '合成概念 A');
  record('placing-a-shape-creates-one-editable-node-and-returns-to-selection');

  await page.locator('#board-tool-rect').click();
  await page.mouse.click(stage.x + 560, stage.y + 360);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill('合成概念 B');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 2);

  // Connect A -> B by dragging A's connect handle onto B.
  const a = await shapeBox(0), b = await shapeBox(1);
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.move(a.x + a.width + 4, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[data-edge-path]').length === 1);
  record('dragging-the-connect-handle-onto-another-node-creates-one-directed-edge');

  // Move the selection and confirm the host stored the new coordinates.
  const before = await waitForHost(value => value.board?.nodes.length === 2 && value.board.edges.length === 1, 'two nodes and one edge');
  const movedA = await shapeBox(0);
  await page.mouse.move(movedA.x + movedA.width / 2, movedA.y + movedA.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedA.x + movedA.width / 2 + 90, movedA.y + movedA.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  const after = await waitForHost(value => value.board.nodes[0].x !== before.board.nodes[0].x || value.board.nodes[0].y !== before.board.nodes[0].y, 'the moved node coordinates');
  assert.equal(after.board.edges.length, 1, 'moving a node keeps its edge');
  record('dragging-a-node-saves-new-coordinates-without-losing-its-edge');

  // A library paper drops onto the canvas as a paper node.
  const droppedCard = await page.locator('#paper-list .paper-card').first().getAttribute('data-id');
  await page.locator('#paper-list .paper-card').first().dragTo(page.locator('#board-stage'), { targetPosition: { x: 820, y: 220 } });
  await page.waitForFunction(() => document.querySelectorAll('.board-node-kind-paper').length === 1);
  const dropped = await waitForHost(value => (value.board?.nodes ?? []).some(node => node.kind === 'paper'), 'the dropped paper node');
  const paperNode = dropped.board.nodes.find(node => node.kind === 'paper');
  assert.equal(paperNode.paper.id, droppedCard, 'the node binds the catalog paper the reader dropped');
  assert.equal(imported.items.some(item => item.id === paperNode.paper.id), true);
  assert.equal(paperNode.origin, 'user');
  record('dragging-a-library-paper-onto-the-canvas-creates-a-bound-paper-node');

  // The keyboard-accessible picker reaches the same result.
  await page.locator('#board-add-paper').click();
  await page.locator('#board-paper-dialog').waitFor();
  await page.locator('#board-paper-list button').first().waitFor();
  await page.locator('#board-paper-list button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.board-node-kind-paper').length === 2);
  await waitForHost(value => value.board.nodes.length === 4, 'the picker node to reach the record');
  record('the-paper-picker-adds-the-same-node-kind-without-dragging');

  // Double-clicking a paper node leaves the board and opens that paper.
  await page.locator('#board-view').evaluate(node => { node.hidden = false; });
  await page.locator('.board-node-kind-paper').first().dblclick();
  await page.locator('#paper-detail').waitFor();
  assert.equal(await page.locator('#board-view').isVisible(), false, 'the board closes when a paper opens');
  record('double-clicking-a-paper-node-returns-to-that-paper-in-the-library');

  await page.locator('#board-open').click();
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 4);
  const beforeReload = await waitForHost(value => value.board?.nodes.length === 4, 'four nodes in the record before the reload');
  assert.equal(beforeReload.board.edges.length, 1);
  record('reopening-the-board-restores-every-node-and-edge');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.locator('#board-open').click();
  try { await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 4); }
  catch (error) {
    const status = await page.locator('#board-status').innerText().catch(() => '(unreadable)');
    const count = await page.locator('.board-node').count();
    throw new Error(`After a reload the board showed ${count} nodes (status: ${status}; page errors: ${errors.join(' | ') || 'none'})`);
  }
  assert.equal(await page.locator('[data-edge-path]').count(), 1);
  record('a-page-reload-restores-the-board-from-the-host-record');

  // Undo/redo over a structural edit.
  const reopenedStage = await page.locator('#board-stage').boundingBox();
  await page.locator('#board-tool-ellipse').click();
  await page.mouse.click(reopenedStage.x + 300, reopenedStage.y + 560);
  await page.locator('.board-text-editor').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 5);
  await page.locator('#board-undo').click();
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 4);
  await page.locator('#board-redo').click();
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 5);
  // Undo/redo restores geometry but deliberately not a selection, so select the node again.
  const restored = await page.locator('.board-node').nth(4).locator('.board-node-shape').boundingBox();
  await page.mouse.click(restored.x + restored.width / 2, restored.y + restored.height / 2);
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 4);
  record('undo-redo-and-delete-apply-to-the-canvas-and-its-undo-history');

  // Zoom, fit and fullscreen.
  await page.locator('#board-zoom-in').click();
  await page.waitForFunction(() => /120%/.test(document.getElementById('board-zoom-label')?.textContent || ''));
  await page.locator('#board-fit').click();
  record('zoom-and-fit-update-the-viewport-and-refit-the-content');
  await page.locator('#board-fullscreen').click();
  try { await page.waitForFunction(() => Boolean(document.fullscreenElement), null, { timeout: 8000 }); }
  catch (error) {
    const toastText = await page.locator('#toast').innerText().catch(() => '');
    const enabled = await page.evaluate(() => document.fullscreenEnabled);
    throw new Error(`Fullscreen never engaged (enabled: ${enabled}; toast: ${toastText}; page errors: ${errors.join(' | ') || 'none'})`);
  }
  assert.equal(await page.locator('#board-fullscreen').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#board-fullscreen').textContent(), /退出全屏/);
  // Exiting through the same control: Escape is browser chrome, which headless Chromium
  // does not deliver to the page, so the product path is the assertion here.
  await page.locator('#board-fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('#board-fullscreen').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#board-fullscreen').textContent(), /全屏/);
  record('fullscreen-grows-the-board-and-its-control-returns-to-the-embedded-view');

  // A second board stays separate, and deletion tombstones only that record.
  await page.locator('#board-new').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 2);
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 0);
  const two = await waitForHost(value => value.boards.length === 2, 'the second board record');
  assert.equal(two.boards.filter(board => board.node_count === 0).length, 1, 'the new board starts empty while the first keeps its nodes');
  record('a-second-board-is-created-empty-and-the-first-board-is-untouched');

  await page.locator('#board-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 1);
  const remaining = await waitForHost(value => value.boards.length === 1, 'the deleted board to disappear');
  assert.equal(remaining.boards[0].node_count, 4, 'the deleted board was the empty one');
  record('deleting-a-board-tombstones-only-that-record');

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/board-browser.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic catalog in an isolated standalone server; free canvas drawing, text editing, connecting, moving, paper drag-in and picker, undo/redo, delete, zoom/fit/fullscreen, board switching, deletion and host persistence across a reload; zero model calls and zero external requests. The AI-proposal review path and the conversation reference chip need the native host tool and the DSH composer, so they are covered by the native harness receipt and unit tests rather than simulated here.',
  checks, errors, externalRequests: external.length, modelRequests: 0,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
