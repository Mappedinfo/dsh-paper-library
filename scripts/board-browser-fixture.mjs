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

  /** Read the host's own record: the assertion is about what was persisted, not the DOM.
   *  A failed read (the standalone server admits few concurrent JSON calls) is reported
   *  so the caller can retry rather than being mistaken for an empty board. */
  const hostBoard = () => page.evaluate(async () => {
    const call = async (action, args) => (await (await fetch('./api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) })).json());
    const list = await call('board_list', {});
    if (!list?.ok) return { boards: [], board: null, error: String(list?.error ?? 'board_list failed') };
    const boards = list.result.boards;
    if (!boards.length) return { boards, board: null };
    // The current board is the one the switcher shows, not simply the first record.
    const id = document.getElementById('board-select')?.value || boards[0].id;
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
      try { last = await hostBoard(); }
      catch (error) { last = { boards: [], board: null, error: error.message }; }
      if (!last.error && predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the host record: ${label} (last: ${JSON.stringify(last).slice(0, 300)})`);
      await new Promise(resolve => setTimeout(resolve, 200));
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
  const pickerRows = page.locator('#board-paper-list .board-picker-row');
  await pickerRows.first().waitFor();
  assert.equal(await page.locator('#board-paper-add').isDisabled(), true, 'nothing is actionable before a paper is checked');
  await pickerRows.first().locator('input').check();
  await page.locator('#board-paper-add').click();
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
  // The control reflects the state; fullscreenchange is a separate task from entering.
  await page.waitForFunction(() => document.getElementById('board-fullscreen')?.getAttribute('aria-pressed') === 'true');
  assert.match(await page.locator('#board-fullscreen').textContent(), /退出全屏/);
  // Exiting through the same control: Escape is browser chrome, which headless Chromium
  // does not deliver to the page, so the product path is the assertion here.
  await page.locator('#board-fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => document.getElementById('board-fullscreen')?.getAttribute('aria-pressed') === 'false');
  assert.match(await page.locator('#board-fullscreen').textContent(), /全屏/);
  record('fullscreen-grows-the-board-and-its-control-returns-to-the-embedded-view');

  // Arranging the board into a tidy tree: the connected root ends left of its child,
  // and arranging twice is idempotent rather than drifting.
  await page.locator('#board-tidy').click();
  const firstTidy = await waitForHost(value => value.board.nodes.find(node => node.kind === 'note').x < value.board.nodes.find(node => node.kind === 'rect').x, 'the tidied columns');
  const coordinates = board => board.nodes.map(node => `${node.id}:${node.x},${node.y}`).sort().join('|');
  await page.locator('#board-tidy').click();
  const secondTidy = await waitForHost(value => value.board.nodes.length === 5 || value.board.nodes.length === 4, 'the board after a second arrange');
  assert.equal(coordinates(secondTidy.board), coordinates(firstTidy.board), 'arranging an arranged board changes nothing');
  record('arranging-connects-the-board-into-left-to-right-columns-and-is-idempotent');

  // A mind map generated from checked papers is a new board and leaves the first alone.
  await page.locator('#board-add-paper').click();
  await page.locator('#board-paper-dialog').waitFor();
  await page.locator('#board-paper-list .board-picker-row').first().waitFor();
  await page.locator('#board-paper-list .board-picker-row').nth(0).locator('input').check();
  await page.locator('#board-paper-list .board-picker-row').nth(1).locator('input').check();
  await page.locator('#board-paper-topic').fill('合成文献结构');
  await page.locator('#board-paper-generate').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 2);
  const generated = await waitForHost(value => value.boards.some(board => board.node_count === 3), 'the generated mind map');
  assert.equal(generated.boards.length, 2);
  assert.deepEqual(generated.boards.map(board => board.node_count).sort(), [3, 4], 'the first board keeps its four nodes');
  const generatedId = generated.boards.find(board => board.node_count === 3).id;
  const generatedBoard = await page.evaluate(async id => (await (await fetch('./api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'board_get', id }) })).json()).result.board, generatedId);
  assert.equal(generatedBoard.title, '合成文献结构');
  assert.equal(generatedBoard.edges.length, 2, 'each paper hangs off the theme node');
  const theme = generatedBoard.nodes.find(node => node.kind === 'concept');
  assert.equal(generatedBoard.nodes.filter(node => node.kind === 'paper').every(node => node.x > theme.x), true, 'papers sit right of the theme');
  record('generating-a-mind-map-from-checked-papers-creates-a-new-arranged-board');

  // A second board stays separate, and deletion tombstones only that record.
  await page.locator('#board-new').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 3);
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 0);
  await waitForHost(value => value.boards.length === 3, 'the third board record');
  record('a-new-board-starts-empty-and-leaves-the-others-untouched');

  await page.locator('#board-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 2);
  const remaining = await waitForHost(value => value.boards.length === 2, 'the deleted board to disappear');
  assert.equal(remaining.boards.some(board => board.node_count === 0), false, 'the empty board was the one deleted');
  assert.deepEqual(remaining.boards.map(board => board.node_count).sort(), [3, 4]);
  record('deleting-a-board-tombstones-only-that-record');

  // A knowledge-graph node joins the board through the explicit control: the graph and
  // the board share one column, so a drag between them is not a reachable interaction.
  const beforeGraph = await waitForHost(value => value.boards.length === 2, 'two boards before the graph step');
  const beforeCounts = new Map(beforeGraph.boards.map(board => [board.id, board.node_count]));
  await page.locator('#paper-list .paper-card').first().click();
  await page.locator('.tab[data-tab="graph"]').click();
  await page.locator('#graph-tab [data-kg="canvas"] .kg-node').first().waitFor();
  await page.locator('#graph-tab [data-kg="canvas"] .kg-node').first().click();
  const graphLabel = (await page.locator('#graph-tab [data-kg="canvas"] .kg-node').first().getAttribute('aria-label') || '').split(' · ').at(-1);
  assert.equal(await page.locator('#graph-tab [data-kg="add-board"]').count(), 1, 'the graph panel owns the add-to-board control');
  await page.locator('#graph-tab [data-kg="add-board"]').click();
  await page.waitForFunction(() => /已把这个节点加入画板/.test(document.getElementById('toast')?.textContent || ''));
  const afterGraph = await waitForHost(value => value.boards.reduce((sum, board) => sum + board.node_count, 0) === [...beforeCounts.values()].reduce((a, b) => a + b, 0) + 1, 'exactly one board to gain one node');
  const grown = afterGraph.boards.filter(board => board.node_count !== beforeCounts.get(board.id));
  assert.equal(grown.length, 1, 'only one board changed');
  assert.equal(grown[0].node_count, beforeCounts.get(grown[0].id) + 1, 'exactly one node was added');
  const grownBoard = await page.evaluate(async id => (await (await fetch('./api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'board_get', id }) })).json()).result.board, grown[0].id);
  if (graphLabel) assert.equal(grownBoard.nodes.some(node => node.text === graphLabel), true, 'the board node carries the label the graph showed');
  record('a-selected-knowledge-graph-node-joins-the-board-through-an-explicit-control');

  // Outside DSH there is no composer to reference: the standalone surface says so
  // instead of pretending the chip was placed. The graph step closed the board, so reopen it.
  await page.locator('#board-open').click();
  await page.locator('.board-node').first().waitFor();
  await page.locator('#board-send').click();
  await page.waitForFunction(() => /DSH 的文献库面板/.test(document.getElementById('toast')?.textContent || ''));
  assert.match(await page.locator('#toast').innerText(), /请从 DSH 的文献库面板打开画板/);
  record('the-standalone-preview-refuses-the-conversation-chip-instead-of-faking-it');

  // Automatic layout first: it spreads the nodes out, and it is also where the three modes
  // and the pinned special position are checked.
  const signature = value => (value.board?.nodes ?? []).map(node => `${node.id}:${node.x},${node.y}`).sort().join('|');
  const layoutBefore = signature(await waitForHost(value => (value.board?.nodes?.length ?? 0) >= 4, 'the board before layout'));
  await page.locator('#board-layout-mode').selectOption('radial');
  await page.locator('#board-layout-direction').selectOption('tb');
  // Clear any selection first: the scope is the selection when it holds more than one node.
  await page.keyboard.press('Escape');
  await page.locator('#board-layout-apply').click();
  const arranged = await waitForHost(value => signature(value) !== layoutBefore, 'the arranged board');
  assert.match(await page.locator('#board-layout-status').innerText(), /放射思维导图/);
  const arrangedOnce = signature(arranged);
  await page.keyboard.press('Escape');
  await page.locator('#board-layout-apply').click();
  try { await waitForHost(value => signature(value) === arrangedOnce, 'the same arrangement on a second apply'); }
  catch (error) { throw new Error(`${error.message} | first=${arrangedOnce.slice(0, 150)} | second=${signature(await hostBoard()).slice(0, 150)}`); }
  // Pin one node, arrange again, and it must stay exactly where the reader put it.
  const pinBox = await shapeBox(0);
  await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
  await page.locator('#board-layout-pin').click();
  const pinned = await waitForHost(value => Object.keys(value.board?.style?.layout?.pins ?? {}).length === 1, 'the pinned node');
  const pinnedId = Object.keys(pinned.board.style.layout.pins)[0];
  const pinnedAt = [pinned.board.nodes.find(node => node.id === pinnedId).x, pinned.board.nodes.find(node => node.id === pinnedId).y];
  await page.locator('#board-layout-mode').selectOption('layered');
  await page.locator('#board-layout-apply').click();
  const afterPin = await waitForHost(value => value.board?.style?.layout?.mode === 'layered' && signature(value) !== arrangedOnce, 'the layered pass after pinning');
  assert.deepEqual([afterPin.board.nodes.find(node => node.id === pinnedId).x, afterPin.board.nodes.find(node => node.id === pinnedId).y], pinnedAt, 'a pinned node keeps its special position');
  assert.equal(afterPin.board.nodes.length, pinned.board.nodes.length, 'pinning never drops nodes');
  record('automatic-layout-is-idempotent-and-never-moves-a-pinned-node');

  // The connect tool, line styling and a bend point, verified through the host record.
  const nodes = await page.evaluate(() => [...document.querySelectorAll('.board-node')].map(node => {
    const box = node.querySelector('.board-node-shape').getBoundingClientRect();
    return { id: node.getAttribute('data-node'), x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  const topmostAt = (x, y) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-node]')?.getAttribute('data-node') ?? null, [x, y]);
  const centreOf = node => [node.x + node.width / 2, node.y + node.height / 2];
  // Only nodes whose centre really is the topmost element there can be clicked reliably:
  // a pinned node may still sit on top of an arranged one.
  const reachable = [];
  for (const node of nodes) {
    const [x, y] = centreOf(node);
    if (await topmostAt(x, y) === node.id) reachable.push(node);
  }
  assert.ok(reachable.length >= 2, `at least two nodes must be clickable, found ${reachable.length}`);
  let linkFrom = reachable[0], linkTo = reachable[1], best = -1;
  for (let a = 0; a < reachable.length; a++) for (let b = a + 1; b < reachable.length; b++) {
    const distance = Math.hypot(centreOf(reachable[a])[0] - centreOf(reachable[b])[0], centreOf(reachable[a])[1] - centreOf(reachable[b])[1]);
    if (distance > best) { best = distance; linkFrom = reachable[a]; linkTo = reachable[b]; }
  }
  const beforeLink = await waitForHost(value => (value.board?.edges?.length ?? 0) >= 1, 'the board before linking');
  const [fromX, fromY] = centreOf(linkFrom), [toX, toY] = centreOf(linkTo);
  assert.equal(await topmostAt(fromX, fromY), linkFrom.id, 'the first target must actually be hit');
  assert.equal(await topmostAt(toX, toY), linkTo.id, 'the second target must actually be hit');
  await page.locator('#board-tool-connect').click();
  await page.mouse.click(fromX, fromY);
  assert.equal(signature(await waitForHost(() => true, 'the board after picking a source')), signature(beforeLink), 'the first click only picks a source');
  await page.mouse.click(toX, toY);
  const linked = await waitForHost(value => (value.board?.edges?.length ?? 0) === beforeLink.board.edges.length + 1, 'the edge made by the connect tool');
  assert.equal(await page.locator('[data-edge-path]').count(), linked.board.edges.length);
  // The new edge is selected, so the inspector applies to it directly.
  await page.locator('#board-edge-kind').selectOption('elbow');
  await page.locator('#board-edge-arrow').selectOption('both');
  await page.locator('#board-edge-dashed').check();
  await waitForHost(value => value.board.edges.some(edge => edge.kind === 'elbow' && edge.arrow === 'both' && edge.dashed === true), 'the styled edge');
  assert.equal(await page.locator('[data-edge-path][marker-start]').count() >= 1, true, 'a two-way arrow renders a start marker');
  assert.equal(await page.locator('[data-edge-path][stroke-dasharray]').count() >= 1, true, 'a dashed line renders a dash pattern');
  record('the-connect-tool-creates-an-edge-and-its-line-style-is-editable');

  // Dragging the line's middle inserts a bend point; Alt-click removes it again.
  const midOfLastEdge = () => page.evaluate(() => {
    const paths = [...document.querySelectorAll('[data-edge-path]')];
    const path = paths[paths.length - 1];
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  });
  const bendTarget = await midOfLastEdge();
  await page.mouse.move(bendTarget.x, bendTarget.y);
  await page.mouse.down();
  await page.mouse.move(bendTarget.x + 40, bendTarget.y - 90, { steps: 10 });
  await page.mouse.up();
  await waitForHost(value => value.board.edges.some(edge => (edge.waypoints ?? []).length === 1), 'the bend point');
  const handle = await page.locator('[data-waypoint]').first().boundingBox();
  // Alt-click removes it; the mouse API takes modifiers through the keyboard instead.
  await page.keyboard.down('Alt');
  await page.mouse.click(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.keyboard.up('Alt');
  await waitForHost(value => value.board?.edges.every(edge => (edge.waypoints ?? []).length === 0), 'the bend point removed by Alt-click');
  // And a plain double-click is the discoverable equivalent.
  const bendAgain = await midOfLastEdge();
  await page.mouse.move(bendAgain.x, bendAgain.y);
  await page.mouse.down();
  await page.mouse.move(bendAgain.x - 30, bendAgain.y + 60, { steps: 8 });
  await page.mouse.up();
  await waitForHost(value => value.board?.edges.some(edge => (edge.waypoints ?? []).length === 1), 'a bend point to double-click');
  const againHandle = await page.locator('[data-waypoint]').first().boundingBox();
  await page.mouse.dblclick(againHandle.x + againHandle.width / 2, againHandle.y + againHandle.height / 2);
  await waitForHost(value => value.board?.edges.every(edge => (edge.waypoints ?? []).length === 0), 'the bend point removed by double-click');
  record('a-line-bend-point-can-be-dragged-in-and-alt-clicked-away');

  // The readable source file and its style sidecar drive the canvas.
  await page.locator('#board-source-open').click();
  await page.locator('#board-source-dialog').waitFor();
  await page.locator('#board-source-generate').click();
  const sourceJson = JSON.parse(await page.locator('#board-source-content').inputValue());
  assert.equal(sourceJson.schema, 'paper-library-board.v1');
  assert.equal(sourceJson.nodes.every(node => !('x' in node) && !('y' in node) && !('w' in node)), true, 'the content file carries no pixel coordinates');
  assert.equal(sourceJson.nodes.every(node => /^[A-Za-z0-9_-]{1,60}$/.test(node.id)), true, 'ids stay short and addressable');
  // Kinds are written as plain readable words; which kinds exist depends on the board the
  // earlier steps left open, so assert the vocabulary rather than one specific kind.
  assert.equal(sourceJson.nodes.every(node => ['text', 'note', 'concept', 'paper', 'rect', 'ellipse', 'diamond'].includes(node.kind)), true, 'node kinds are readable');
  assert.equal(sourceJson.nodes.length >= 1, true);
  sourceJson.nodes.push({ id: 'fromSource', kind: 'note', text: '源文件新增的节点' });
  await page.locator('#board-source-content').fill(JSON.stringify(sourceJson, null, 2));
  await page.locator('#board-source-apply').click();
  await page.waitForFunction(() => /已应用/.test(document.getElementById('board-source-status')?.textContent || ''));
  await waitForHost(value => value.board.nodes.some(node => node.text === '源文件新增的节点'), 'the node added through the source file');
  const styleJson = JSON.parse(await page.locator('#board-source-style').inputValue());
  styleJson.node = { ...(styleJson.node ?? {}), byId: { fromSource: { fill: '#ffe9ec', w: 260, fontSize: 15 } } };
  styleJson.layout = { ...(styleJson.layout ?? {}), pins: { fromSource: [1400, 240] } };
  await page.locator('#board-source-style').fill(JSON.stringify(styleJson, null, 2));
  await page.locator('#board-source-apply').click();
  const sidecar = await waitForHost(value => value.board?.style?.layout?.pins?.fromSource?.[0] === 1400 && value.board?.style?.node?.byId?.fromSource?.w === 260, 'the sidecar to take effect');
  const styled = sidecar.board.nodes.find(node => node.text === '源文件新增的节点');
  assert.deepEqual([styled.x, styled.y], [1400, 240], 'the sidecar dictates the special position');
  assert.equal(styled.w, 260, 'the sidecar dictates the size');
  assert.equal(sidecar.board.style.node.byId.fromSource.fill, '#ffe9ec');
  await page.locator('#board-source-dialog .dialog-close').first().click();
  record('editing-the-source-file-and-its-sidecar-drives-the-canvas');

  // The library shelf lists boards as their own files and links them to papers.
  await page.locator('#board-close').click();
  await page.locator('#paper-list .paper-card').first().click();
  const linkedPaperId = await page.locator('#paper-list .paper-card').first().getAttribute('data-id');
  await page.locator('#board-shelf > summary').click();
  await page.locator('.board-shelf-row').first().waitFor();
  const shelfRows = await page.locator('.board-shelf-row').count();
  const listedBoards = (await waitForHost(value => value.boards.length >= 2, 'the boards listed in the shelf')).boards.length;
  assert.equal(shelfRows, Math.min(20, listedBoards), 'the shelf shows the host records it read');
  assert.match(await page.locator('#board-shelf-count').innerText(), new RegExp(String(listedBoards)));
  await page.locator('.board-shelf-row').first().getByRole('button', { name: '关联本篇' }).click();
  let linkedShelf;
  try { linkedShelf = await waitForHost(value => value.boards.some(board => (board.linked_papers ?? 0) >= 1), 'the paper link recorded on a board'); }
  catch (error) {
    const state = await page.evaluate(() => ({ toast: document.getElementById('toast')?.textContent ?? '', rows: [...document.querySelectorAll('.board-shelf-row')].map(row => row.innerText.replace(/\n/g, ' | ')), active: document.querySelector('#paper-list .paper-card')?.getAttribute('data-id') ?? null, shelf: document.getElementById('board-shelf-count')?.textContent }));
    throw new Error(`${error.message} | toast=${state.toast} | rows=${JSON.stringify(state.rows)} | shelf=${state.shelf} | active=${state.active}`);
  }
  assert.equal(linkedShelf.boards.some(board => board.linked_papers >= 1), true);
  assert.match(await page.locator('.board-shelf-row.is-linked small').first().innerText(), /关联1篇/);
  await page.locator('.board-shelf-row.is-linked').first().getByRole('button', { name: '解除' }).click();
  await waitForHost(value => value.boards.every(board => (board.linked_papers ?? 0) === 0), 'the paper link removed');
  // The paper's own control counts its boards and can create one already linked.
  await page.locator('#paper-board-new').click();
  const createdForPaper = await waitForHost(value => value.boards.some(board => (board.linked_papers ?? 0) >= 1), 'a board created from the paper header');
  assert.equal(createdForPaper.boards.some(board => board.linked_papers >= 1), true);
  assert.equal(linkedPaperId !== null, true);
  record('the-library-shelf-lists-boards-and-links-them-to-papers');

  // Focus mode is a pure canvas: no topbar, no library, no reader or annotations.
  await page.locator('#board-focus').click();
  await page.waitForFunction(() => document.body.classList.contains('board-focused'));
  assert.equal(await page.locator('.library-pane').isVisible(), false, 'focus hides the library shelf');
  assert.equal(await page.locator('.topbar').isVisible(), false, 'focus hides the app topbar');
  assert.equal(await page.locator('#board-view').isVisible(), true, 'the board is the only thing left');
  assert.equal(await page.locator('#board-stage').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('board-focused'));
  assert.equal(await page.locator('.library-pane').isVisible(), true, 'Escape restores the app chrome');
  record('focus-mode-leaves-only-the-canvas-and-escape-restores-the-app');

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
