/** Model-free challenge stages through an actual isolated DSH profile.
 *
 * P1 (scan), P3 (aggregate/review/merge/export) and P4 (check/comparison/packet)
 * never call a model, so this smoke asserts the authenticated host wiring, the
 * delivered panel assets and the written exports without spending model quota.
 * The model stages (P2 extraction, model merge suggestions) need a real route
 * and are covered by the stubbed host tests instead of being simulated here.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../src/bridge.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = resolve(process.env.DSH_CHECKOUT ?? join(project, '../../deepseek-ai/deepseek-harness'));
const templateHome = resolve(process.env.DSH_TEST_HOME ?? join(project, '.local/paper-chat-test-home'));
const profile = process.env.DSH_TEST_PROFILE ?? 'paper-chat-test';
assert.ok(relative(join(project, '.local'), templateHome) && !relative(join(project, '.local'), templateHome).startsWith('..'));
assert.match(profile, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const run = join(templateHome, 'runs', `challenge-${randomUUID()}`), home = join(run, 'home'), library = join(run, 'library'), python = join(project, '.venv/bin/python');
const checks = [];
let child, startupTimer, logs = '';
const record = value => { checks.push(value); console.log(`PASS ${value}`); };

async function stopHost() {
  if (!child || child.exitCode !== null) return;
  await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGINT'); });
}

async function startHost() {
  let output = '';
  const env = Object.fromEntries(['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { DSH_HOME: home, DSH_PAPER_LIBRARY_DIR: library });
  child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', join(project, 'tests-js/fixtures/harness-chat/cordis.patch.yml'), '--port', '0', '--no-open'], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const authenticatedUrl = await new Promise((accept, reject) => {
    startupTimer = setTimeout(() => reject(new Error('Synthetic Harness did not start within 60 seconds')), 60000);
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-24000); logs += bytes.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) accept(match[1]); });
    child.stderr.on('data', bytes => { logs += bytes.toString(); });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Synthetic Harness exited ${code}`)));
  });
  clearTimeout(startupTimer);
  const origin = new URL(authenticatedUrl).origin, exchange = await fetch(authenticatedUrl, { redirect: 'manual' });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  return {
    origin, headers,
    async api(input) {
      const response = await fetch(`${origin}/api/paper-library/api`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.equal(value.ok, true, JSON.stringify(value));
      return value.result;
    },
    async asset(name) {
      const response = await fetch(`${origin}/api/paper-library/${name}`, { headers, signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.text() };
    },
  };
}

try {
  await access(join(templateHome, 'profiles', profile, 'package.json'));
  const fixtureProfile = join(home, 'profiles', profile);
  await mkdir(fixtureProfile, { recursive: true });
  for (const filename of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(templateHome, 'profiles', profile, filename), join(fixtureProfile, filename));
  await symlink(join(templateHome, 'profiles', profile, 'node_modules'), join(fixtureProfile, 'node_modules'), 'dir');
  await mkdir(library, { recursive: true });

  // Synthetic paper with a real (generated) PDF plus one accepted difficulty
  // draft, both built without a model.
  const sourcePdf = join(run, 'synthetic-challenge.pdf');
  const generated = spawnSync(python, ['-c', 'import pymupdf,sys\ndoc=pymupdf.open()\nfor text in ["Synthetic Challenge Paper","1 Introduction","However, they fail to generalise to noisy synthetic settings.","5 Discussion","A key limitation is that our synthetic evaluation covers only one city.","References","A limitation keyword inside a cited synthetic title."]:\n page=doc.new_page();page.insert_text((50,70),text)\ndoc.save(sys.argv[1]);doc.close()', sourcePdf], { cwd: project, encoding: 'utf8', env: { ...process.env, UV_CACHE_DIR: '/private/tmp/codex-uv' } });
  assert.equal(generated.status, 0, generated.stderr);
  const [paper] = (await core({ action: 'import', items: [{ id: 'SyntheticChallengeHost', title: 'Synthetic challenge host paper', author: [{ family: 'Fixture' }], issued: { 'date-parts': [[2026]] }, attachments: [{ path: sourcePdf }] }] }, { library, python })).items;
  const source = await core({ action: 'knowledge_source_put', entity: { kind: 'paper', id: paper.id }, kind: 'user-text', text: 'A key limitation is that our synthetic evaluation covers only one city.', locator: { page: 2 } }, { library, python });
  let draft = await core({
    action: 'knowledge_draft_put', entity: { kind: 'paper', id: paper.id }, mode: 'graph', origin: 'llm', request_id: 'host-fixture',
    title: 'Synthetic difficulty fixture', body: 'Synthetic fixture body.', source_ids: [source.id],
    nodes: [{ id: 'single-city', type: 'gap', label: 'Synthetic evaluation covers only one city', source_status: 'author-stated' },
            { id: 'evidence-one', type: 'evidence', label: 'Synthetic limitation quote', source_id: source.id, quote: 'A key limitation is that our synthetic evaluation covers only one city.' }],
    assertions: [{ subject: 'evidence:evidence-one', object: 'gap:single-city', relation: 'identifies' }],
  }, { library, python });
  draft = await core({ action: 'knowledge_draft_review', id: draft.id, reviewed_by: 'user', decision: 'accepted', expected_revision: draft.revision }, { library, python });
  assert.equal(draft.status, 'accepted');

  const host = await startHost();
  const unauthenticated = await fetch(`${host.origin}/api/paper-library/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'challenge_themes', ids: [paper.id] }) });
  assert.equal(unauthenticated.status, 401, 'Challenge routes stay behind the host authentication');
  record('challenge-routes-require-the-authenticated-host');

  const status = await host.api({ action: 'status' });
  assert.equal(status.challenge_mining, true, 'The host subagent route is wired');
  assert.equal(status.challenge_scan, true);
  assert.equal(status.challenge_themes, true);
  assert.equal(status.challenge_export, true);
  assert.equal(status.challenge_comparison, true);
  assert.equal(status.challenge_review_packet, true);
  record('status-advertises-the-scan-theme-export-comparison-and-packet-routes');

  const js = await host.asset('challenge-mining.js'), css = await host.asset('challenge-mining.css');
  assert.equal(js.status, 200);
  assert.equal(css.status, 200);
  assert.match(js.body, /window\.ChallengeMining/);
  assert.match(js.body, /challenge_review_packet/);
  assert.match(css.body, /\.challenge-panel/);
  record('authenticated-host-delivers-the-panel-assets');

  const scan = await host.api({ action: 'challenge_scan', ids: [paper.id] });
  assert.equal(scan.schema, 'paper-library-challenge-candidates.v1');
  assert.equal(scan.model_calls, 0);
  assert.equal(scan.scope.scanned, 1);
  assert.ok(scan.papers[0].candidates.length >= 1, 'The synthetic PDF yields trigger candidates');
  assert.ok(scan.papers[0].candidates.every(candidate => Number.isInteger(candidate.page) && candidate.page >= 1));
  record('p1-scan-reads-the-managed-pdf-in-the-real-host-with-zero-model-calls');

  const themes = await host.api({ action: 'challenge_themes', ids: [paper.id] });
  assert.equal(themes.model_calls, 0);
  assert.equal(themes.totals.records, 1);
  const theme = themes.themes[0];
  assert.equal(theme.paper_count, 1);
  assert.deepEqual(theme.quotes, [{ page: 2, quote: 'A key limitation is that our synthetic evaluation covers only one city.' }]);
  const reviewed = await host.api({ action: 'challenge_theme_review', id: theme.id, decision: 'accepted', reviewed_by: 'user', expected_revision: theme.revision });
  assert.equal(reviewed.status, 'accepted');
  record('p3-aggregation-and-the-user-review-gate-run-in-the-real-host');

  const checked = await host.api({ action: 'challenge_theme_check', scope: themes.scope.hash });
  assert.equal(checked.model_calls, 0);
  assert.ok(checked.findings.some(finding => finding.code === 'theme-single-paper'));
  const compared = await host.api({ action: 'challenge_comparison', ids: [paper.id], scope: themes.scope.hash, checklist_text: '# 清单\n- synthetic evaluation covers only one city\n- 未覆盖的方向\n', checklist_label: '合成清单' });
  assert.deepEqual([compared.counts.covered, compared.counts.gaps], [1, 1]);
  record('p4-check-and-checklist-comparison-run-in-the-real-host');

  const packet = await host.api({ action: 'challenge_review_packet', ids: [paper.id], scope: themes.scope.hash, comparison_id: compared.id });
  assert.equal(packet.model_calls, 0);
  const exported = await host.api({ action: 'challenge_export', ids: [paper.id], scope: themes.scope.hash });
  assert.equal(exported.model_calls, 0);
  const files = await readdir(join(library, 'exports'));
  for (const expected of ['challenges.csv', 'challenges.md', 'challenges.bib', 'challenges-review-packet.md', 'challenges-review-packet.json']) {
    assert.ok(files.includes(expected), `${expected} was written under exports/`);
  }
  const markdown = await readFile(join(library, 'exports/challenges-review-packet.md'), 'utf8');
  assert.match(markdown, /研究难点人工评审包/);
  assert.match(markdown, /κ/);
  record('p4-packet-and-exports-are-written-by-the-real-host');

  await stopHost();
  await mkdir(join(project, 'docs/validation'), { recursive: true });
  await writeFile(join(project, 'docs/validation/challenge-mining-harness.json'), JSON.stringify({
    verified_at: new Date().toISOString(),
    scope: 'Actual isolated DSH profile with a synthetic library: authenticated challenge routes, delivered panel assets, P1 scan, P3 aggregation with the review gate, P4 check/comparison/packet and the exports files. All exercised stages are model-free; the model stages (P2 extraction, model merge suggestions) are not simulated here and are covered by stubbed host tests plus the browser receipt.',
    checks, modelRequests: 0, externalRequests: 0,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ run: relative(project, run), checks: checks.length }));
} catch (error) {
  await stopHost();
  await writeFile(join(project, '.local/challenge-harness-smoke.log'), `${logs}\n${error?.stack || error}\n`.replace(/token=[^\s&]+/g, 'token=<redacted>'), { mode: 0o600 });
  throw error;
} finally {
  await stopHost();
}
