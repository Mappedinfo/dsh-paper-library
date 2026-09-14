/** Publish the reviewed community showcase once; read back before recording success.
 * Run without arguments for preflight, then --publish only with maintainer authorization.
 * Images must already be public at the exact bytes inspected locally.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const options = new Set(process.argv.slice(2));
assert.ok([...options].every(value => ['--publish', '--verify'].includes(value)), 'Unknown option');
const config = JSON.parse(await readFile('docs/community/showcase.json', 'utf8'));
const body = await readFile(config.bodyFile, 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const graphql = (query, variables = {}) => {
  const result = JSON.parse(execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }));
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
};
assert.match(config.title, /^DSH \| Paper Library \| .+/);
assert.ok(body.includes('非官方项目'));
const viewer = graphql('query { viewer { login } }').viewer.login;
const search = graphql(`query($query:String!) { search(query:$query,type:DISCUSSION,first:100) {
  discussionCount nodes { ... on Discussion { id title url } }
} }`, { query: `repo:${config.repository} author:${viewer} "Paper Library" in:title` }).search;
assert.ok(search.discussionCount <= 100, 'Search exceeded the bounded duplicate check');
const matches = search.nodes.filter(item => item.title?.startsWith('DSH | Paper Library |'));
assert.ok(matches.length <= 1, 'Multiple existing project discussions; inspect before proceeding');
let receipt;
try { receipt = JSON.parse(await readFile('docs/community/discussion.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (receipt) assert.equal(receipt.author, viewer, 'Existing receipt belongs to another account');
for (const path of config.images) {
  const remote = JSON.parse(execFileSync('gh', ['api', `repos/Mappedinfo/dsh-paper-library/contents/${path}?ref=main`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(remote.encoding, 'base64');
  const local = await readFile(path);
  assert.equal(sha256(Buffer.from(remote.content, 'base64')), sha256(local), `Public screenshot differs: ${path}`);
  assert.ok(body.includes(`main/${path}`));
}
let id = receipt?.id ?? matches[0]?.id;
if (options.has('--verify')) assert.ok(id, 'No published discussion to verify');
if (!id && options.has('--publish')) {
  const result = graphql(`mutation($input:CreateDiscussionInput!) {
    createDiscussion(input:$input) { discussion { id } }
  }`, { input: { repositoryId: config.repositoryId, categoryId: config.categoryId, title: config.title, body } });
  id = result.createDiscussion.discussion.id;
  // Save the returned id before another network call, so an uncertain readback
  // cannot cause an accidental duplicate submission on retry.
  await writeFile('docs/community/discussion.json', JSON.stringify({ id, author: viewer, status: 'created_pending_readback' }, null, 2) + '\n');
}
if (!id) {
  console.log(JSON.stringify({ ok: true, mode: 'preflight', author: viewer, duplicateFound: false, title: config.title, screenshotCount: config.images.length }));
  process.exit(0);
}
const result = graphql(`query($id:ID!) { node(id:$id) { ... on Discussion {
  id number title body url author { login } category { id name } repository { nameWithOwner } createdAt
} } }`, { id }).node;
assert.equal(result.repository.nameWithOwner.toLowerCase(), config.repository.toLowerCase());
assert.equal(result.category.id, config.categoryId);
assert.equal(result.author.login, viewer);
assert.equal(result.title, config.title);
assert.equal(result.body.replace(/\r\n/g, '\n').trimEnd(), body.trimEnd());
const report = { ok: true, id: result.id, number: result.number, url: result.url, title: result.title, author: viewer, category: result.category.name, createdAt: result.createdAt, verifiedAt: new Date().toISOString(), bodySha256: sha256(body) };
await writeFile('docs/community/discussion.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
