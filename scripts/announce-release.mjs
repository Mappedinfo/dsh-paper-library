/** Announce one reviewed release on the existing community discussion.
 * Run without arguments for preflight; --publish posts the reviewed body only
 * when no comment with the same hash exists; --verify re-reads the saved comment.
 * The discussion is never recreated, and an existing comment is never rewritten.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const options = new Set(process.argv.slice(2));
assert.ok([...options].every(value => ['--publish', '--verify'].includes(value)), 'Unknown option');
const config = JSON.parse(await readFile('docs/community/showcase.json', 'utf8'));
const discussion = JSON.parse(await readFile('docs/community/discussion.json', 'utf8'));
const body = await readFile(config.releaseBodyFile, 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bodyHash = sha256(Buffer.from(body));
const graphql = (query, variables = {}) => {
  const result = JSON.parse(execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
};
const viewer = graphql('query { viewer { login } }').viewer.login;
assert.equal(discussion.author, viewer, 'The recorded discussion belongs to another account');
const receiptFile = config.releaseReceiptFile;
let receipt = null;
if (existsSync(receiptFile)) receipt = JSON.parse(await readFile(receiptFile, 'utf8'));

const read = () => graphql(`query($id:ID!) { node(id:$id) { ... on Discussion {
  id number url title
  comments(first:100) { totalCount nodes { id body url author { login } createdAt } }
} } }`, { id: discussion.id }).node;
const found = () => read().comments.nodes.find(comment => sha256(Buffer.from(comment.body.replace(/\r\n/g, '\n'))) === bodyHash);

if (options.has('--verify')) {
  assert.ok(receipt?.commentId, 'No recorded release comment to verify');
  const remote = read().comments.nodes.find(comment => comment.id === receipt.commentId);
  assert.ok(remote, 'The recorded release comment is missing');
  assert.equal(sha256(Buffer.from(remote.body.replace(/\r\n/g, '\n'))), bodyHash, 'Remote comment body changed');
  assert.equal(remote.author.login, viewer);
  const report = { ...receipt, verifiedAt: new Date().toISOString(), url: remote.url, author: remote.author.login, bodySha256: bodyHash };
  await writeFile(receiptFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exit(0);
}
const existing = found();
if (existing) {
  const report = { ok: true, mode: 'existing', commentId: existing.id, url: existing.url, author: existing.author.login, createdAt: existing.createdAt, discussion: discussion.url, verifiedAt: new Date().toISOString(), bodySha256: bodyHash };
  await writeFile(receiptFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exit(0);
}
if (!options.has('--publish')) {
  console.log(JSON.stringify({ ok: true, mode: 'preflight', author: viewer, discussion: discussion.url, releaseBody: config.releaseBodyFile, bodySha256: bodyHash, commentCount: read().comments.totalCount }));
  process.exit(0);
}
const created = graphql(`mutation($input:AddDiscussionCommentInput!) { addDiscussionComment(input:$input) { comment { id url createdAt } } }`,
  { input: { discussionId: discussion.id, body } }).addDiscussionComment.comment;
// Persist the returned identity before any further network call so an uncertain
// readback cannot post the same announcement twice on retry.
await writeFile(receiptFile, JSON.stringify({ status: 'created_pending_readback', commentId: created.id, url: created.url, bodySha256: bodyHash }, null, 2) + '\n');
const remote = read().comments.nodes.find(comment => comment.id === created.id);
assert.ok(remote, 'Created comment was not readable back');
assert.equal(sha256(Buffer.from(remote.body.replace(/\r\n/g, '\n'))), bodyHash, 'Readback body differs from the reviewed file');
assert.equal(remote.author.login, viewer);
const report = { ok: true, mode: 'published', commentId: remote.id, url: remote.url, author: remote.author.login, createdAt: remote.createdAt, discussion: discussion.url, verifiedAt: new Date().toISOString(), bodySha256: bodyHash };
await writeFile(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
