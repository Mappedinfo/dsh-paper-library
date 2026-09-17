import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, projectRoot } from '../src/bridge.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'challenges-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const library = join(directory, 'library');
  const generated = spawnSync(join(projectRoot, '.venv/bin/python'), ['scripts/create-demo.py', '--output', join(directory, 'source')], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const imported = await dispatch({ action: 'import', path: join(directory, 'source/zotero-export.json') }, { library });
  const paper = imported.items[0];
  return { directory, library, paper };
}

test('challenge_scan routes through the shared bridge without a model call', async t => {
  const f = await fixture(t);
  const result = await dispatch({ action: 'challenge_scan', ids: [f.paper.id] }, { library: f.library });
  assert.equal(result.schema, 'paper-library-challenge-candidates.v1');
  assert.equal(result.model_calls, 0);
  assert.equal(result.scope.requested, 1);
  assert.equal(result.scope.scanned, 1);
  assert.equal(result.papers[0].id, f.paper.id);
  assert.ok(Array.isArray(result.papers[0].candidates));
  assert.ok(result.budgets.papers === 50 && result.budgets.sections_per_paper === 6);
  assert.deepEqual(Object.keys(result.rules).length, 10);
});

test('challenge_scan rejects oversized or malformed scopes before any read', async t => {
  const f = await fixture(t);
  await assert.rejects(dispatch({ action: 'challenge_scan', ids: [] }, { library: f.library }), /CHALLENGE_SCOPE/);
  await assert.rejects(dispatch({ action: 'challenge_scan', ids: ['a', 'a'] }, { library: f.library }), /CHALLENGE_SCOPE/);
  await assert.rejects(dispatch({ action: 'challenge_scan', ids: Array.from({ length: 51 }, (_, i) => `p${i}`) }, { library: f.library }), /CHALLENGE_SCOPE/);
  await assert.rejects(dispatch({ action: 'challenge_scan', ids: [f.paper.id], sections: ['nope'] }, { library: f.library }), /CHALLENGE_SCOPE/);
});

test('challenge_scan reports unreadable records instead of failing the run', async t => {
  const f = await fixture(t);
  const metadataOnly = await dispatch({ action: 'create', metadata: { title: 'Metadata only record', citekey: 'metaOnly2026' } }, { library: f.library });
  const result = await dispatch({ action: 'challenge_scan', ids: [metadataOnly.id, 'missing-record'] }, { library: f.library });
  assert.equal(result.scope.scanned, 0);
  assert.equal(result.scope.skipped.length, 2);
  assert.match(result.scope.skipped[0].reason, /PDF/);
});
