/** Publish the reviewed community showcase once; read back before recording success.
 * Run without arguments for preflight. Authorized --publish creates a missing
 * discussion; --update changes only the discussion in a verified local receipt.
 * --verify never mutates GitHub. Modes are mutually exclusive.
 * Images must already be public at the exact bytes inspected locally.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const options = new Set(process.argv.slice(2));
assert.ok([...options].every(value => ['--publish', '--verify', '--update'].includes(value)), 'Unknown option');
assert.ok(options.size <= 1, 'Choose only one of --publish, --verify or --update');
const config = JSON.parse(await readFile('docs/community/showcase.json', 'utf8'));
const body = await readFile(config.bodyFile, 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeBody = value => value.replace(/\r\n?/g, '\n').trimEnd();
const bodyHash = sha256(normalizeBody(body));
const receiptFile = 'docs/community/discussion.json';
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
try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (receipt) assert.equal(receipt.author, viewer, 'Existing receipt belongs to another account');
if (receipt?.id) assert.ok(matches.every(item => item.id === receipt.id), 'Search conflicts with the recorded discussion identity');
if (options.has('--update')) {
  assert.ok(receipt?.ok === true && receipt.id && receipt.title && receipt.verifiedAt && /^[a-f0-9]{64}$/.test(receipt.bodySha256), 'Updating requires an existing verified discussion receipt');
  assert.ok(!receipt.bodyHashNormalization || receipt.bodyHashNormalization === 'lf-trim-end', 'Unknown receipt body hash normalization');
}
for (const path of config.images) {
  const remote = JSON.parse(execFileSync('gh', ['api', `repos/Mappedinfo/dsh-paper-library/contents/${path}?ref=main`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(remote.encoding, 'base64');
  const local = await readFile(path);
  assert.equal(sha256(Buffer.from(remote.content, 'base64')), sha256(local), `Public screenshot differs: ${path}`);
  assert.ok(body.includes(`main/${path}`));
}
let id = receipt?.id ?? matches[0]?.id;
let created = false;
if (options.has('--verify')) assert.ok(id, 'No published discussion to verify');
if (!id && options.has('--publish')) {
  const result = graphql(`mutation($input:CreateDiscussionInput!) {
    createDiscussion(input:$input) { discussion { id } }
  }`, { input: { repositoryId: config.repositoryId, categoryId: config.categoryId, title: config.title, body } });
  id = result.createDiscussion.discussion.id;
  created = true;
  // Save the returned id before another network call, so an uncertain readback
  // cannot cause an accidental duplicate submission on retry.
  await writeFile(receiptFile, JSON.stringify({ id, author: viewer, status: 'created_pending_readback' }, null, 2) + '\n');
}
if (!id) {
  console.log(JSON.stringify({ ok: true, mode: 'preflight', author: viewer, duplicateFound: false, title: config.title, screenshotCount: config.images.length }));
  process.exit(0);
}
const read = () => graphql(`query($id:ID!) { node(id:$id) { ... on Discussion {
  id number title body url author { login } category { id name } repository { id nameWithOwner } createdAt updatedAt
} } }`, { id }).node;
const verifyIdentity = result => {
  assert.ok(result, 'The recorded discussion is missing or inaccessible');
  assert.equal(result.id, id, 'Discussion identity changed');
  assert.equal(result.repository?.id, config.repositoryId, 'Discussion repository ID changed');
  assert.equal(result.repository?.nameWithOwner.toLowerCase(), config.repository.toLowerCase(), 'Discussion repository changed');
  assert.equal(result.category?.id, config.categoryId, 'Discussion category changed');
  assert.equal(result.author?.login, viewer, 'Discussion author changed');
  if (receipt?.number) assert.equal(result.number, receipt.number, 'Recorded discussion number changed');
};
let result = read();
verifyIdentity(result);
let mode = created ? 'published' : options.has('--verify') ? 'verified' : 'existing';
if (options.has('--update') && (result.title !== config.title || normalizeBody(result.body) !== normalizeBody(body))) {
  assert.equal(result.title, receipt.title, 'Remote title changed since the last verified receipt; review before updating');
  const normalized = normalizeBody(result.body);
  // Older receipts hashed the file bytes, conventionally ending in one LF.
  // Accept only equivalent line-ending/end-whitespace forms, never changed text.
  const hashes = receipt.bodyHashNormalization ? [sha256(normalized)] : [sha256(normalized), sha256(normalized + '\n'), sha256(result.body.replace(/\r\n?/g, '\n'))];
  assert.ok(hashes.includes(receipt.bodySha256), 'Remote body changed since the last verified receipt; review before updating');
  // GitHub offers no conditional revision field for updateDiscussion. Check the
  // latest read immediately before the mutation; this is not a server-side CAS.
  const updated = graphql(`mutation($input:UpdateDiscussionInput!) {
    updateDiscussion(input:$input) { discussion { id } }
  }`, { input: { discussionId: id, title: config.title, body } });
  assert.equal(updated.updateDiscussion?.discussion?.id, id, 'Update returned a different discussion');
  // Keep the old verified receipt if this request or readback fails. A retry
  // already matching the desired text skips the mutation and completes readback.
  result = read();
  verifyIdentity(result);
  mode = 'updated';
}
assert.equal(result.title, config.title, 'Remote title differs from the reviewed title');
assert.equal(normalizeBody(result.body), normalizeBody(body), 'Remote body differs from the reviewed body');
const report = { ok: true, mode, id: result.id, number: result.number, url: result.url, title: result.title, author: viewer, repository: result.repository.nameWithOwner, repositoryId: result.repository.id, category: result.category.name, categoryId: result.category.id, createdAt: result.createdAt, updatedAt: result.updatedAt, verifiedAt: new Date().toISOString(), bodySha256: bodyHash, bodyHashNormalization: 'lf-trim-end' };
await writeFile(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
