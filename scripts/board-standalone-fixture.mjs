/** Standalone whiteboard browser flow: the GitHub Pages build served by a local static
 * server, with no plugin host, no library and no model. It proves the parts that only
 * exist in the independent build: browser-local persistence, JSON round-trip, PNG export,
 * hidden host-only controls, and that nothing leaves the page. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(project, '_site');
const checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json;charset=utf-8' };

await stat(join(site, 'index.html'));

let server, browser;
const errors = [], external = [];
try {
  // A deliberately dumb static server: the point is that the page needs nothing else.
  server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    const file = join(site, path === '/' ? 'index.html' : path.replace(/^\//, ''));
    if (!file.startsWith(site)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404).end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  /** The toolbar is menus: open the one that owns a control before using it. */
  const openMenu = async (trigger, panel) => {
    if (await page.locator(trigger).getAttribute('aria-expanded') !== 'true') await page.locator(trigger).click();
    await page.waitForFunction(id => document.getElementById(id)?.classList.contains('is-open'), panel);
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) external.push(request.url()); });
  // Deleting a board asks first; Playwright dismisses dialogs unless told otherwise.
  page.on('dialog', dialog => void dialog.accept());

  const stored = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1') ?? '{"records":[]}'));
  const stage = async () => page.locator('#board-stage').boundingBox();
  const download = async action => {
    const [task] = await Promise.all([page.waitForEvent('download'), action()]);
    const path = await task.path();
    return { name: task.suggestedFilename(), body: await readFile(path) };
  };

  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  await page.locator('#board-stage').waitFor();
  assert.equal(await page.locator('#board-view').isVisible(), true, 'the standalone page opens straight onto a board');
  assert.equal(await page.locator('#board-add-paper').isVisible(), false, 'there is no library here, so its control is hidden rather than faked');
  assert.equal(await page.locator('#board-send').isVisible(), false, 'there is no composer here, so the reference control is hidden');
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 1);
  record('the-independent-page-opens-a-board-and-hides-host-only-controls');

  // Draw, type, then connect two nodes.
  const box = await stage();
  await page.locator('#board-tool-note').click();
  await page.mouse.click(box.x + 240, box.y + 180);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill('独立画板节点 A');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 1);
  await page.locator('#board-tool-rect').click();
  await page.mouse.click(box.x + 620, box.y + 360);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill('独立画板节点 B');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 2);
  const a = await page.locator('.board-node').nth(0).locator('.board-node-shape').boundingBox();
  const b = await page.locator('.board-node').nth(1).locator('.board-node-shape').boundingBox();
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.move(a.x + a.width + 4, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('[data-edge-path]').length === 1);
  await page.waitForFunction(() => /已保存/.test(document.getElementById('board-status')?.textContent || ''));
  const saved = await stored();
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].board.nodes.length, 2);
  assert.equal(saved.records[0].board.edges.length, 1);
  assert.match(saved.records[0].revision, /^[a-f0-9]{64}$|[a-f0-9]{64}$/, 'the local store keeps a content revision');
  record('drawing-and-connecting-persist-into-browser-storage-with-a-revision');

  // A reload restores exactly what was drawn, from the browser store alone.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 2);
  assert.equal(await page.locator('[data-edge-path]').count(), 1);
  assert.equal(await page.locator('.board-node-text').first().textContent(), '独立画板节点 A');
  record('a-reload-restores-the-board-from-browser-storage-alone');

  // Arranging works with no host: same deterministic layout as the plugin.
  await openMenu('#board-layout-open', 'board-layout-panel');
  await page.locator('#board-tidy').click();
  await page.waitForFunction(() => /已把 2 个节点整理成树/.test(document.getElementById('toast')?.textContent || ''));
  const tidied = await stored();
  const root = tidied.records[0].board.nodes.find(node => node.text === '独立画板节点 A');
  const child = tidied.records[0].board.nodes.find(node => node.text === '独立画板节点 B');
  assert.equal(root.x < child.x, true, 'the connected root moves left of its child');
  record('tidy-tree-arranging-runs-in-the-independent-build');

  // JSON export is the real backup, and it round-trips into a second browser profile.
  const exported = await download(() => page.locator('#site-export-json').click());
  assert.match(exported.name, /^paper-library-boards-\d{4}-\d{2}-\d{2}\.json$/);
  const payload = JSON.parse(exported.body.toString('utf8'));
  assert.equal(payload.schema, 'paper-library-whiteboard.v1');
  assert.equal(payload.boards.length, 1);
  assert.equal(payload.boards[0].nodes.length, 2);
  assert.equal(payload.boards[0].edges.length, 1);
  record('json-export-writes-every-board-with-its-drawn-content');

  const second = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const other = await second.newPage();
  other.on('pageerror', error => errors.push(error.message));
  other.on('dialog', dialog => void dialog.accept());
  await other.goto(origin);
  await other.locator('#board-stage').waitFor();
  await other.waitForFunction(() => document.querySelectorAll('#board-select option').length === 1);
  assert.equal((await other.evaluate(() => document.querySelectorAll('.board-node').length)), 0, 'a fresh profile starts empty');
  await other.setInputFiles('#site-import-file', { name: 'boards.json', mimeType: 'application/json', buffer: exported.body });
  await other.waitForFunction(() => document.querySelectorAll('.board-node').length === 2);
  assert.equal((await other.evaluate(() => document.querySelectorAll('[data-edge-path]').length)), 1);
  assert.match(await other.locator('#toast').innerText(), /已导入 1 张画板/);
  // Importing the same file again cannot overwrite: the duplicate identity becomes a new board.
  await other.setInputFiles('#site-import-file', { name: 'boards.json', mimeType: 'application/json', buffer: exported.body });
  // The empty board that the page created on arrival plus the two imports.
  await other.waitForFunction(() => document.querySelectorAll('#board-select option').length === 3);
  assert.match(await other.locator('#toast').innerText(), /另存为新画板/);
  assert.equal((await other.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.length)), 3, 'the duplicate became its own record');
  record('json-import-restores-a-board-in-another-profile-without-overwriting-identity');
  await second.close();

  // PNG export paints from the model, so it works with no stylesheet and no server.
  const png = await download(() => page.locator('#site-export-png').click());
  assert.match(png.name, /\.png$/);
  assert.equal(png.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the file is a real PNG');
  assert.ok(png.body.length > 4000, `the PNG carries the drawing (${png.body.length} bytes)`);
  record('png-export-produces-a-real-image-with-the-drawn-content');

  // The independent build carries the same edge, layout and source capabilities.
  const sourceBox = await stage();
  await page.locator('#board-tool-note').click();
  await page.mouse.click(sourceBox.x + 260, sourceBox.y + 180);
  await page.locator('.board-text-editor').waitFor();
  await page.locator('.board-text-editor').fill('独立连线节点');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 3);
  const linkBoxes = await page.evaluate(() => [...document.querySelectorAll('.board-node')].map(node => {
    const box = node.querySelector('.board-node-shape').getBoundingClientRect();
    return { id: node.getAttribute('data-node'), x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }));
  const topmost = (x, y) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-node]')?.getAttribute('data-node') ?? null, [x, y]);
  const clickable = [];
  for (const node of linkBoxes) if (await topmost(node.x, node.y) === node.id) clickable.push(node);
  assert.ok(clickable.length >= 2);
  const storedEdges = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.edges);
  const edgesBefore = (await storedEdges()).length;
  await page.locator('#board-tool-connect').click();
  await page.mouse.click(clickable[0].x, clickable[0].y);
  await page.mouse.click(clickable[1].x, clickable[1].y);
  await page.waitForFunction(count => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.edges.length === count + 1, edgesBefore);
  await page.locator('#board-edge-kind').selectOption('elbow');
  await page.locator('#board-edge-dashed').check();
  await page.waitForFunction(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.edges.some(edge => edge.kind === 'elbow' && edge.dashed === true));
  record('the-standalone-build-creates-and-styles-an-edge-with-the-connect-tool');

  await page.locator('#board-tool-select').click();
  await page.keyboard.press('Escape');
  await openMenu('#board-layout-open', 'board-layout-panel');
  await page.locator('#board-layout-mode').selectOption('layered');
  await page.locator('#board-layout-direction').selectOption('tb');
  await page.locator('#board-layout-apply').click();
  await page.waitForFunction(() => /分层图/.test(document.getElementById('board-layout-status')?.textContent || ''));
  const laidOut = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.nodes.map(node => `${node.id}:${node.x},${node.y}`).sort().join('|'));
  const onceSignature = await laidOut();
  await page.locator('#board-layout-apply').click();
  await page.waitForFunction(signature => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.nodes.map(node => `${node.id}:${node.x},${node.y}`).sort().join('|') === signature, onceSignature);
  record('automatic-layout-is-available-and-idempotent-in-the-standalone-build');

  await openMenu('#board-menu-open', 'board-menu');
  await page.locator('#board-source-open').click();
  await page.locator('#board-source-dialog').waitFor();
  await page.locator('#board-source-generate').click();
  const independentSource = JSON.parse(await page.locator('#board-source-content').inputValue());
  assert.equal(independentSource.schema, 'paper-library-board.v1');
  assert.equal(independentSource.nodes.every(node => !('x' in node) && !('y' in node)), true, 'the independent build writes the same coordinate-free source');
  const independentStyle = JSON.parse(await page.locator('#board-source-style').inputValue());
  independentStyle.layout = { ...(independentStyle.layout ?? {}), pins: { [independentSource.nodes[0].id]: [1200, 600] } };
  await page.locator('#board-source-style').fill(JSON.stringify(independentStyle, null, 2));
  await page.locator('#board-source-apply').click();
  await page.waitForFunction(id => {
    const board = JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board;
    return board.style?.layout?.pins?.[id]?.[0] === 1200;
  }, independentSource.nodes[0].id);
  const pinnedNode = await page.evaluate(id => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board.nodes.find(node => node.id === id), independentSource.nodes[0].id);
  assert.deepEqual([pinnedNode.x, pinnedNode.y], [1200, 600], 'the sidecar parks a node at an exact position');
  await page.locator('#board-source-dialog .dialog-close').first().click();
  record('the-standalone-build-reads-and-applies-the-source-and-style-files');

  // Boards are separate, and deletion hides only the deleted one.
  const nodesInFirstBoard = await page.locator('.board-node').count();
  await openMenu('#board-files-open', 'board-files');
  await page.locator('#board-new').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 2);
  try { await page.waitForFunction(() => document.querySelectorAll('.board-node').length === 0); }
  catch (error) {
    const state = await page.evaluate(() => ({ nodes: document.querySelectorAll('.board-node').length, options: document.querySelectorAll('#board-select option').length, title: document.getElementById('board-title')?.value, status: document.getElementById('board-status')?.textContent, records: (JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1') ?? '{"records":[]}').records ?? []).map(record => [record.board?.id, record.board?.title, record.board?.nodes?.length ?? record.board?.deleted]) }));
    throw new Error(`A new board did not become the drawing surface: ${JSON.stringify(state)}`);
  }
  await openMenu('#board-menu-open', 'board-menu');
  await page.locator('#board-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('#board-select option').length === 1);
  await page.waitForFunction(count => document.querySelectorAll('.board-node').length === count, nodesInFirstBoard);
  const afterDelete = await stored();
  assert.equal(afterDelete.records.filter(record => record.board.deleted !== true).length, 1, 'the deleted board is tombstoned locally');
  record('a-second-board-is-separate-and-deletion-tombstones-only-that-record');

  // A repository-hosted source file renders on its own: `?src=boards/example.json`.
  const linked = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
  const visitor = await linked.newPage();
  visitor.on('pageerror', error => errors.push(error.message));
  await visitor.goto(`${origin}/?src=boards/example.json`);
  await visitor.locator('#board-stage').waitFor();
  await visitor.waitForFunction(() => document.querySelectorAll('.board-node').length === 5);
  const fromFile = await visitor.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true)[0].board);
  assert.equal(fromFile.title, '城市感知的技术路线（示例源文件）');
  assert.equal(fromFile.nodes.length, 5);
  assert.equal(fromFile.edges.length, 4);
  assert.deepEqual(fromFile.nodes.filter(node => node.text.startsWith('这个节点被固定')).map(node => [node.x, node.y]), [[1240, 120]], 'the sidecar pin from the repository file is honoured');
  assert.equal(await visitor.locator('#board-edge-kind').count(), 1);
  assert.match(await visitor.locator('#site-storage-status').innerText(), /已从源文件导入/);
  // Visiting again reuses the local copy instead of duplicating it.
  await visitor.reload();
  await visitor.waitForFunction(() => document.querySelectorAll('.board-node').length === 5);
  const again = await visitor.evaluate(() => JSON.parse(window.localStorage.getItem('paper-library-whiteboard.v1')).records.filter(record => record.board?.deleted !== true).length);
  assert.equal(again, 1, 'a second visit reuses the imported copy');
  assert.match(await visitor.locator('#site-storage-status').innerText(), /已打开本地副本/);
  await linked.close();
  record('a-repository-source-file-renders-from-a-url-without-duplicating-itself');

  // Focus mode is a pure canvas here too, and this host has no library or reader at all.
  assert.equal(await page.locator('#board-shelf').count(), 0, 'the standalone page carries no library shelf');
  assert.equal(await page.locator('#paper-board-new').count(), 0, 'and no per-paper controls');
  await page.locator('#board-focus').click();
  await page.waitForFunction(() => document.body.classList.contains('board-focused'));
  assert.equal(await page.locator('#board-stage').isVisible(), true);
  assert.equal(await page.locator('.site-header').isVisible(), false, 'focus also hides the standalone header');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.body.classList.contains('board-focused'));
  assert.equal(await page.locator('.site-header').isVisible(), true);
  record('focus-mode-is-a-pure-canvas-and-the-standalone-host-has-no-library-chrome');

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}

await writeFile(join(project, 'docs/validation/board-standalone.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'The GitHub Pages build served by a local static server: browser-local persistence with a content revision, reload restore, tidy-tree arranging, JSON export/import across profiles including duplicate-identity handling, PNG export, hidden host-only controls, tombstoned deletion, and zero external requests or page errors. No plugin host, library, model or network service is involved, and browser storage is convenience rather than a durable store — the exported JSON is the backup.',
  checks, checks_count: checks.length, modelRequests: 0, externalRequests: external.length,
}, null, 2) + '\n');
console.log(JSON.stringify({ checks: checks.length, errors, external }));
