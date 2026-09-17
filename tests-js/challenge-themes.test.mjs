import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, projectRoot } from '../src/bridge.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'challenge-themes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const generated = spawnSync(join(projectRoot, '.venv/bin/python'), ['scripts/create-demo.py', '--output', join(directory, 'source')], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const imported = await dispatch({ action: 'import', path: join(directory, 'source/zotero-export.json') }, { library });
  const source = await dispatch({ action: 'knowledge_source_put', entity: { kind: 'paper', id: imported.items[0].id },
    kind: 'user-text', text: 'Synthetic corpora lack a shared evaluation protocol.', locator: { page: 3 } }, { library });
  let draft = await dispatch({ action: 'knowledge_draft_put', entity: { kind: 'paper', id: imported.items[0].id },
    source_ids: [source.id], request_id: 'themes-fixture',
    nodes: [{ id: 'difficulty-1', type: 'gap', label: 'No shared synthetic evaluation protocol', source_status: 'author-stated' },
            { id: 'evidence-1', type: 'evidence', label: 'Synthetic excerpt', source_id: source.id, quote: 'Synthetic corpora lack a shared evaluation protocol.' }],
    assertions: [{ subject: 'evidence:evidence-1', object: 'gap:difficulty-1', relation: 'identifies' }] }, { library });
  draft = await dispatch({ action: 'knowledge_draft_review', id: draft.id, reviewed_by: 'user', decision: 'accepted',
    expected_revision: draft.revision }, { library });
  return { directory, library, paper: imported.items[0], draft };
}

test('challenge_themes aggregates reviewed drafts through the shared bridge', async t => {
  const f = await fixture(t);
  const result = await dispatch({ action: 'challenge_themes', ids: [f.paper.id] }, { library: f.library });
  assert.equal(result.schema, 'paper-library-challenge-themes.v1');
  assert.equal(result.model_calls, 0);
  assert.equal(result.totals.records, 1);
  assert.equal(result.totals.themes, 1);
  const theme = result.themes[0];
  assert.equal(theme.paper_count, 1);
  assert.equal(theme.papers[0].citekey, f.paper.citekey);
  assert.deepEqual(theme.quotes, [{ page: 3, quote: 'Synthetic corpora lack a shared evaluation protocol.' }]);
  const listed = await dispatch({ action: 'challenge_theme_list', scope: result.scope.hash }, { library: f.library });
  assert.equal(listed.total, 1);
  assert.equal((await dispatch({ action: 'challenge_theme_get', id: theme.id }, { library: f.library })).theme.id, theme.id);
});

test('theme review, merge and export reject unsupervised or stale writes', async t => {
  const f = await fixture(t);
  const first = (await dispatch({ action: 'challenge_themes', ids: [f.paper.id] }, { library: f.library })).themes[0];
  await assert.rejects(dispatch({ action: 'challenge_theme_review', id: first.id, reviewed_by: 'llm', decision: 'accepted', expected_revision: 1 }, { library: f.library }), /CHALLENGE_REVIEW_REQUIRED/);
  await assert.rejects(dispatch({ action: 'challenge_theme_review', id: first.id, reviewed_by: 'user', decision: 'accepted', expected_revision: 7 }, { library: f.library }), /CHALLENGE_CONFLICT/);
  await assert.rejects(dispatch({ action: 'challenge_theme_merge', theme_ids: [first.id], expected_revisions: { [first.id]: 1 }, reviewed_by: 'user' }, { library: f.library }), /CHALLENGE_SCOPE/);
  const accepted = await dispatch({ action: 'challenge_theme_review', id: first.id, reviewed_by: 'user', decision: 'accepted', expected_revision: first.revision }, { library: f.library });
  assert.equal(accepted.status, 'accepted');
  await assert.rejects(dispatch({ action: 'challenge_export', ids: [f.paper.id], scope: 'f'.repeat(64) }, { library: f.library }), /CHALLENGE_MISSING/);
  const exported = await dispatch({ action: 'challenge_export', ids: [f.paper.id], scope: accepted.scope }, { library: f.library });
  assert.equal(exported.model_calls, 0);
  assert.deepEqual(exported.citekeys, [f.paper.citekey]);
  assert.match(await readFile(join(f.library, 'exports/challenges.md'), 'utf8'), /待审阅的合并建议/);
  assert.match(await readFile(join(f.library, 'exports/challenges.bib'), 'utf8'), new RegExp(`@\\w+\\{${f.paper.citekey},`));
});

test('challenge_scan and challenge_themes share one admission guard', async t => {
  const f = await fixture(t);
  await assert.rejects(dispatch({ action: 'challenge_themes', ids: Array.from({ length: 201 }, (_, i) => `p${i}`) }, { library: f.library }), /CHALLENGE_SCOPE/);
  await assert.rejects(dispatch({ action: 'challenge_export', ids: [] }, { library: f.library }), /CHALLENGE_SCOPE/);
});
