/** Reading projects: the catalog tables, the HTTP/bridge surface and the agent tool.
 *
 * These assertions are about what the catalog stores. A project is a queryable scope over
 * the same papers — never a copy of them — so every check that links, renames or archives
 * also verifies the papers themselves are untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';
import { dispatch } from '../src/bridge.mjs';
import { PROJECT_TOOL_SPECS, projectToolRequest } from '../src/harness/project-tools.mjs';
import { registerLibraryTools, requestFromTool, TOOL_SPECS } from '../src/harness/tools.mjs';
import { resolveConfig } from '../src/harness/config.mjs';

const papers = [
  { id: 'p-one', citekey: 'One2024', title: '城市感知的第一篇证据', type: 'article-journal', author: [{ family: 'One' }], issued: { 'date-parts': [[2024]] } },
  { id: 'p-two', citekey: 'Two2025', title: 'Synthetic sensor calibration', type: 'article-journal', author: [{ family: 'Two' }], issued: { 'date-parts': [[2025]] } },
  { id: 'p-three', citekey: 'Three2025', title: 'Unrelated methodology', type: 'article-journal', author: [{ family: 'Three' }], issued: { 'date-parts': [[2025]] } },
];

async function fixture(t) {
  const library = await mkdtemp(join(tmpdir(), 'paper-projects-'));
  t.after(() => rm(library, { recursive: true, force: true }));
  const handler = createFetchHandler({ library });
  const call = async request => {
    const response = await handler(new Request('http://127.0.0.1/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
    const body = await response.json();
    assert.equal(body.ok, true, `${request.action}: ${JSON.stringify(body)}`);
    return body.result;
  };
  const imported = await call({ action: 'import', items: papers });
  // Catalog ids are the catalog's own, so the tests address papers the way the UI does.
  const byTitle = new Map(imported.items.map(item => [item.title, item.id]));
  const ids = { one: byTitle.get(papers[0].title), two: byTitle.get(papers[1].title), three: byTitle.get(papers[2].title) };
  assert.equal(Object.values(ids).every(id => typeof id === 'string' && id.length > 0), true, 'the import returned ids for every paper');
  return { library, handler, call, ids };
}

test('the catalog creates, scopes, links, renames and archives reading projects', async t => {
  const f = await fixture(t);
  const status = await f.call({ action: 'status' });
  assert.equal(status.projects, true, 'the panel can detect projects without probing');
  assert.equal(status.schema, 3);

  const first = await f.call({ action: 'project_create', title: '城市感知综述', description: '城市感知方向的阅读清单', tags: ['urban', 'sensing'] });
  assert.match(first.project.id, /^p-[0-9a-f]{12}$/);
  assert.equal(first.project.paper_count, 0);
  assert.deepEqual(first.project.tags, ['urban', 'sensing']);
  const second = await f.call({ action: 'project_create', title: '方法复现' });
  assert.equal((await f.call({ action: 'project_list' })).total, 2);

  const linked = await f.call({ action: 'project_link', id: first.project.id, paper_id: f.ids.one });
  assert.equal(linked.linked, true);
  assert.equal((await f.call({ action: 'project_get', id: first.project.id })).project.paper_count, 1);
  assert.equal((await f.call({ action: 'project_link', id: first.project.id, paper_id: f.ids.one })).linked, false, 'linking twice is not an error and changes nothing');

  // The project is a scope over the same catalog, so it composes with search, paging and sort.
  const scoped = await f.call({ action: 'resource_list', kind: 'paper', project: first.project.id });
  assert.deepEqual(scoped.items.map(item => item.id), [f.ids.one]);
  assert.equal(scoped.total, 1);
  const searched = await f.call({ action: 'resource_list', kind: 'paper', project: first.project.id, query: 'sensor' });
  assert.equal(searched.total, 0, 'the project scope composes with the search query');
  const matched = await f.call({ action: 'resource_list', kind: 'paper', project: first.project.id, query: '城市感知' });
  assert.equal(matched.total, 1, 'the project scope composes with a search that does match');
  await assert.rejects(dispatch({ action: 'resource_list', project: 'p-000000000000' }, { library: f.library }), /不存在/);

  const renamed = await f.call({ action: 'project_update', id: first.project.id, title: '城市感知综述（改）' });
  assert.equal(renamed.project.title, '城市感知综述（改）');
  assert.equal(renamed.project.paper_count, 1, 'editing keeps the membership');

  const archived = await f.call({ action: 'project_archive', id: first.project.id });
  assert.equal(archived.project.archived, true);
  assert.equal((await f.call({ action: 'project_list' })).total, 1);
  assert.equal((await f.call({ action: 'project_list', include_archived: true })).total, 2);
  assert.equal((await f.call({ action: 'project_for_paper', paper_id: f.ids.one })).total, 0, 'an archived project stops claiming the paper');
  await assert.rejects(dispatch({ action: 'project_link', id: first.project.id, paper_id: f.ids.two }, { library: f.library }), /归档/);
  const restored = await f.call({ action: 'project_restore', id: first.project.id });
  assert.equal(restored.project.archived, false);
  assert.equal((await f.call({ action: 'project_for_paper', paper_id: f.ids.one })).total, 1);

  const removed = await f.call({ action: 'project_archive', id: second.project.id });
  assert.equal(removed.project.archived, true);
  for (const id of [f.ids.one, f.ids.two, f.ids.three]) assert.equal((await f.call({ action: 'get', id })).title.length > 0, true, `${id} survived the project changes`);
});

test('one paper joins several projects and no project change touches the paper', async t => {
  const f = await fixture(t);
  const urban = (await f.call({ action: 'project_create', title: '城市感知' })).project.id;
  const methods = (await f.call({ action: 'project_create', title: '方法' })).project.id;
  const readings = (await f.call({ action: 'project_create', title: '组会' })).project.id;
  for (const id of [urban, methods, readings]) await f.call({ action: 'project_link', id, paper_id: f.ids.one });
  await f.call({ action: 'project_link', id: methods, paper_id: f.ids.two });

  const memberships = await f.call({ action: 'project_for_paper', paper_id: f.ids.one });
  assert.equal(memberships.total, 3, 'one paper belongs to three projects');
  assert.deepEqual(memberships.projects.map(project => project.id).sort(), [urban, methods, readings].sort());
  assert.equal((await f.call({ action: 'project_get', id: methods })).project.paper_count, 2, 'a project holds many papers');
  assert.equal((await f.call({ action: 'resource_list', kind: 'paper', project: methods })).total, 2);
  assert.equal((await f.call({ action: 'resource_list', kind: 'paper', project: readings })).total, 1);
  assert.equal((await f.call({ action: 'resource_list', kind: 'paper' })).total, 3, 'the unscoped library still lists every paper');

  const unlinked = await f.call({ action: 'project_unlink', id: methods, paper_id: f.ids.one });
  assert.equal(unlinked.unlinked, true);
  assert.equal((await f.call({ action: 'project_for_paper', paper_id: f.ids.one })).total, 2);
  assert.equal((await f.call({ action: 'project_get', id: methods })).project.paper_count, 1, 'unlinking removes exactly one edge');
  const again = await f.call({ action: 'project_unlink', id: methods, paper_id: f.ids.one });
  assert.equal(again.unlinked, false, 'unlinking twice is a no-op rather than a failure');
  assert.equal(again.project.paper_count, 1, 'and it changes nothing');
  await assert.rejects(dispatch({ action: 'project_link', id: methods, paper_id: 'p-000000000000' }, { library: f.library }), /文献/);
  assert.equal((await f.call({ action: 'get', id: f.ids.one })).citekey, 'One2024', 'the paper record is intact');

  // Archiving a project is not deleting a paper, and it is not unlinking one either: the
  // project stops being offered, while its edges are kept so a restore brings them back.
  await f.call({ action: 'project_archive', id: readings });
  assert.deepEqual((await f.call({ action: 'project_for_paper', paper_id: f.ids.one })).projects.map(project => project.id).sort(), [urban].sort(), 'an archived project stops claiming the paper');
  assert.equal((await f.call({ action: 'project_list' })).total, 2);
  assert.equal((await f.call({ action: 'resource_list', kind: 'paper', project: readings })).total, 1, 'its edges survive for a restore');
  await assert.rejects(dispatch({ action: 'project_unlink', id: readings, paper_id: f.ids.one }, { library: f.library }), /已归档/);
  await f.call({ action: 'project_restore', id: readings });
  assert.equal((await f.call({ action: 'project_for_paper', paper_id: f.ids.one })).total, 2, 'restoring returns the paper to the project');
  assert.equal((await f.call({ action: 'get', id: f.ids.one })).citekey, 'One2024', 'the paper was never touched');
});

test('the project tool maps operations onto catalog actions and refuses host-owned fields', async t => {
  const f = await fixture(t);
  const spec = TOOL_SPECS.find(entry => entry.name === 'library_projects');
  assert.ok(spec, 'library_projects is part of the shared tool list');
  assert.equal(spec.action, 'project_tool');
  assert.equal(spec.mutate, true);
  assert.deepEqual(Object.keys(spec.parameters).sort(), ['input_json', 'operation']);

  const mapped = projectToolRequest(spec, { operation: 'link', input_json: JSON.stringify({ id: 'p-one', paper_id: 'p-two' }) });
  assert.deepEqual(mapped, { id: 'p-one', paper_id: 'p-two', action: 'project_link' });
  assert.equal(projectToolRequest(spec, { operation: 'for_paper', input_json: JSON.stringify({ paper_id: 'p-one' }) }).action, 'project_for_paper');

  assert.throws(() => projectToolRequest(spec, { operation: 'delete', input_json: '{}' }), /Unsupported project operation/);
  assert.throws(() => projectToolRequest(spec, { operation: 'create', input_json: 'not json' }), /valid JSON/);
  assert.throws(() => projectToolRequest(spec, { operation: 'create', input_json: '[]' }), /must be an object/);
  assert.throws(() => projectToolRequest(spec, { operation: 'create', input_json: `{"title":"${'x'.repeat(65 * 1024)}"}` }), /64 KiB/);
  for (const payload of [{ action: 'project_archive' }, { library: '/tmp/other' }, { python: '/tmp/python' }]) {
    assert.throws(() => projectToolRequest(spec, { operation: 'create', input_json: JSON.stringify(payload) }), /owned by the host/);
  }
  assert.deepEqual(requestFromTool(spec, { operation: 'create', input_json: '{"title":"x"}' }, {}), { title: 'x', action: 'project_create' });

  // The registered tool reaches the real catalog, so the mapping is not merely structural.
  const tools = new Map();
  const ctx = { on: () => () => {}, tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } };
  const dispose = registerLibraryTools(ctx, value => value, (request, options) => dispatch(request, options), { library: f.library }, resolveConfig({ library: f.library }));
  t.after(dispose);
  const tool = tools.get('library_projects');
  assert.ok(tool, 'the host offers library_projects');
  const exec = args => tool.execute(args, { signal: new AbortController().signal });
  const created = await exec({ operation: 'create', input_json: JSON.stringify({ title: 'AI 建的项目' }) });
  assert.equal(typeof created.project.id, 'string');
  const listed = await exec({ operation: 'list', input_json: '{}' });
  assert.equal(listed.total, 1);
  assert.equal((await exec({ operation: 'get', input_json: JSON.stringify({ id: created.project.id }) })).project.title, 'AI 建的项目');
});

test('the bridge admits project actions and still refuses unknown ones', async () => {
  await assert.rejects(dispatch({ action: 'project_list_missing' }, {}), /未知文献操作/);
  // A malformed project request reaches the catalog's own validation rather than the allowlist.
  await assert.rejects(dispatch({ action: 'project_get' }, { library: '/tmp/paper-projects-unused' }), error => !/未知文献操作/.test(error.message));
  const spec = PROJECT_TOOL_SPECS[0];
  assert.equal(spec.name, 'library_projects');
  assert.ok(spec.parameters.operation.enum.includes('for_paper'));
});
