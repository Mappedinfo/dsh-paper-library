/** Isolated reading-project UI flow: synthetic catalog only, no model or network access.
 * Verifies what the catalog stores, not what the DOM paints: every assertion reads the
 * host through its own API and the DOM is used only to drive the interface.
 * The paper-to-project relation is deliberately many-to-many, so the fixture links one
 * paper into several projects and then checks a project-scoped library list, archiving
 * without deleting papers, and the board-to-project link. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(project, '.local'), { recursive: true });
const run = await mkdtemp(join(project, '.local/project-ui-'));
const library = join(run, 'library'), source = join(run, 'source'), checks = [];
const record = label => { checks.push(label); console.log(`PASS ${label}`); };
const generated = spawnSync(join(project, '.venv/bin/python'), ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library });
assert.ok(imported.items.length >= 2, 'The demo import provides at least two papers');

let server, browser, startTimer;
const errors = [], external = [];
try {
  // An isolated state home: the fixture reads and writes no real DSH state.
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
  await page.goto(origin);

  /** Host truth. The server admits only a few concurrent JSON calls, so an explicit 429 is
   *  retried rather than reported as a missing record; other failures surface as errors. */
  const call = async (action, args = {}) => page.evaluate(async ({ action, args }) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch('./api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
      if (response.status === 429) { await response.text(); await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); continue; }
      const data = await response.json();
      return data.ok ? { ok: true, result: data.result } : { ok: false, error: String(data.error) };
    }
    return { ok: false, error: 'the server kept rejecting requests' };
  }, { action, args });
  const projects = async (includeArchived = false) => {
    const answer = await call('project_list', { include_archived: includeArchived, limit: 200 });
    assert.equal(answer.ok, true, `project_list failed: ${answer.error}`);
    return answer.result.projects;
  };
  const memberships = async paperId => {
    const answer = await call('project_for_paper', { paper_id: paperId });
    assert.equal(answer.ok, true, `project_for_paper failed: ${answer.error}`);
    return answer.result.projects;
  };
  const settledTitle = () => page.waitForFunction(() => { const node = document.getElementById('paper-title'); return node && node.textContent && node.textContent !== '正在打开文献…'; });
  const cardCount = () => page.locator('#paper-list .paper-card').count();
  const waitForCards = count => page.waitForFunction(value => document.querySelectorAll('#paper-list .paper-card').length === value, count);
  /** Membership changes go through the catalog; poll it instead of trusting one paint. */
  const waitForMemberships = async (paperId, count) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const list = await memberships(paperId);
      if (list.length === count) return list;
      await page.waitForTimeout(150);
    }
    throw new Error(`the catalog kept ${(await memberships(paperId)).length} memberships, expected ${count}`);
  };

  await page.waitForFunction(() => document.getElementById('paper-projects')?.hidden === false);
  assert.equal(await page.locator('#paper-projects').isVisible(), true, 'the ribbon shows the project control when the catalog supports projects');
  assert.equal((await projects()).length, 0, 'a fresh catalog holds no projects');

  // Create two projects from the toolbar dialog; the second is what makes the relation many-to-many.
  const createProject = async title => {
    await page.locator('#project-new').click();
    await page.locator('#project-title').fill(title);
    await page.locator('#project-save').click();
    await page.waitForFunction(name => document.getElementById('project-select')?.textContent.includes(name), title);
  };
  await createProject('城市感知综述');
  await createProject('方法复现');
  const created = await projects();
  assert.equal(created.length, 2, 'both projects were created in the catalog');
  assert.equal(created.every(entry => /^p-[0-9a-f]{12}$/.test(entry.id)), true, 'project ids are the catalog\'s own');
  record('the-toolbar-creates-reading-projects-in-the-catalog');

  // A selected project scopes the library list, and a brand-new project is empty.
  await waitForCards(0);
  assert.match(await page.locator('#project-status').innerText(), /项目内 0 篇/);
  await page.locator('#project-select').selectOption('');
  await waitForCards(imported.items.length);
  await page.waitForFunction(() => /共 2 个项目/.test(document.getElementById('project-status')?.textContent || ''));
  assert.match(await page.locator('#project-status').innerText(), /共 2 个项目/);
  record('selecting-a-project-scopes-the-library-list');

  // The regression this fixture exists for: openPaper clears state.active while it awaits the
  // record, so a project button pressed in that same tick used to be a silent no-op.
  const opened = await page.evaluate(() => {
    document.querySelector('#paper-list .paper-card').click();
    document.getElementById('paper-projects').click();
    return document.getElementById('project-membership-dialog').open;
  });
  assert.equal(opened, true, 'the membership dialog opens even when pressed while the paper is still loading');
  const paperId = await page.evaluate(() => document.querySelector('#paper-list .paper-card')?.getAttribute('data-id') ?? null);
  assert.equal(typeof paperId, 'string', 'the card carries the catalog paper id');
  await page.waitForFunction(() => document.querySelectorAll('#project-membership-list .board-picker-row input').length === 2);
  record('the-ribbon-opens-membership-while-the-paper-is-still-loading');

  // Tick both boxes: one paper, two projects. Then untick one.
  await page.locator('#project-membership-list .board-picker-row input').nth(0).check();
  await page.locator('#project-membership-list .board-picker-row input').nth(1).check();
  await page.waitForFunction(() => /已加入项目/.test(document.getElementById('project-membership-status')?.textContent || ''));
  assert.equal((await waitForMemberships(paperId, 2)).length, 2, 'the catalog records both memberships');
  await settledTitle();
  assert.equal(await page.locator('#paper-project-count').innerText(), '2', 'the ribbon badge counts the memberships');
  await page.locator('#project-membership-list .board-picker-row input').nth(1).uncheck();
  await page.waitForFunction(() => /已移出项目/.test(document.getElementById('project-membership-status')?.textContent || ''));
  const afterUnlink = (await waitForMemberships(paperId, 1)).map(entry => entry.id);
  assert.equal(afterUnlink.length, 1, 'unticking removed exactly one membership');
  const stillThere = await call('get', { id: paperId });
  assert.equal(stillThere.ok, true, 'unlinking a project never touches the paper itself');
  assert.equal(await page.locator('#paper-project-count').innerText(), '1', 'the badge follows the unlink');
  record('one-paper-joins-several-projects-and-unlinking-leaves-the-paper-intact');

  // The membership dialog can create and join in one step, for a paper that has no project yet.
  await page.locator('#project-membership-new').fill('临时专题');
  await page.locator('#project-membership-new').press('Enter');
  await page.waitForFunction(() => /已新建项目并加入/.test(document.getElementById('project-membership-status')?.textContent || ''));
  assert.equal((await projects()).length, 3, 'the inline create added a third project');
  assert.equal((await memberships(paperId)).length, 2, 'the new project joined the open paper immediately');
  record('the-membership-dialog-creates-a-project-and-joins-it');

  // Editing renames in place without disturbing memberships or papers.
  await page.locator('#project-membership-dialog .dialog-close').first().click();
  const first = (await projects()).find(entry => entry.paper_count === 1);
  assert.ok(first, 'one project now holds the paper');
  await page.locator('#project-select').selectOption(first.id);
  await waitForCards(1);
  await page.locator('#project-edit').click();
  await page.locator('#project-title').fill('城市感知综述（改）');
  await page.locator('#project-save').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#project-select option')].some(option => option.textContent.includes('（改）')), null);
  const renamed = (await projects()).find(entry => entry.id === first.id);
  assert.equal(renamed.title, '城市感知综述（改）', 'the catalog stores the new title');
  assert.equal(renamed.paper_count, 1, 'renaming keeps the membership');
  assert.equal(await cardCount(), 1, 'the scoped list survives the edit');
  record('editing-a-project-renames-it-without-losing-memberships');

  // Archiving hides the project but never deletes its papers.
  await page.locator('#project-archive').click();
  await page.waitForFunction(() => /共 2 个项目/.test(document.getElementById('project-status')?.textContent || ''));
  assert.equal((await projects()).some(entry => entry.id === first.id), false, 'an archived project leaves the active list');
  assert.equal((await projects(true)).some(entry => entry.id === first.id), true, 'the record is retained for restoration');
  assert.equal((await memberships(paperId)).length, 1, 'the remaining membership is unaffected by the archive');
  assert.equal(await cardCount(), imported.items.length, 'the list falls back to every paper');
  record('archiving-a-project-hides-it-and-keeps-its-papers');

  // A board can name a reading project, which is how a canvas joins a project without owning it.
  assert.equal(await page.evaluate(() => document.querySelector('#paper-list .paper-card')?.getAttribute('data-id') ?? null), paperId, 'the list order held, so the board is created for the same paper');
  await page.locator('#paper-board-new').click();
  await page.waitForFunction(() => document.body.classList.contains('board-mode'));
  const listed = await call('board_list', {});
  assert.equal(listed.ok, true, `board_list failed: ${listed.error}`);
  const board = listed.result.boards[0];
  assert.ok(board, 'the paper ribbon created a board');
  const target = (await projects())[0];
  if (await page.locator('#board-project-open').getAttribute('aria-expanded') !== 'true') await page.locator('#board-project-open').click();
  assert.ok(await page.locator('#board-project-select').isVisible(), 'the project menu holds the picker once the catalog offers projects');
  assert.ok(await page.locator('#board-project-select option').count() >= 2, 'the picker lists the active projects');
  const boardLinks = async id => { const answer = await call('board_get', { id }); assert.equal(answer.ok, true, `board_get failed: ${answer.error}`); return answer.result.board.links ?? {}; };
  await page.locator('#board-project-select').selectOption(target.id);
  await page.locator('#board-link-project').click();
  // The chip updates at once; the record is written on a debounce. Poll slowly so the
  // reads cannot crowd out the save the server is still admitting.
  await page.waitForFunction(() => /关联项目 1/.test(document.getElementById('board-links')?.textContent || ''));
  let links = {};
  for (let attempt = 0; attempt < 24; attempt += 1) {
    links = await boardLinks(board.id);
    if ((links.projects ?? []).includes(target.id)) break;
    await page.waitForTimeout(500);
  }
  assert.deepEqual(links.projects, [target.id], 'the host stores the project link on the board record');
  assert.deepEqual(links.papers, [paperId], "linking a project leaves the board's paper link alone");
  record('a-board-links-to-a-reading-project');

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  record('no-browser-runtime-errors-and-no-external-requests');
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
await writeFile(join(project, 'docs/validation/project-ui.json'), JSON.stringify({
  verified_at: new Date().toISOString(),
  scope: 'Synthetic catalog in an isolated standalone server; reading-project creation, project-scoped library lists, many-to-many paper membership with create-and-join, rename and archive without deleting papers, and the board-to-project link. Zero model calls and zero external requests.',
  checks, errors, externalRequests: external.length, modelRequests: 0,
}, null, 2) + '\n');
console.log(JSON.stringify({ run: relative(project, run), checks: checks.length, errors }));
