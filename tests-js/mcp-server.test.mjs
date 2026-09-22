/** Our own MCP server (`mcp/server.mjs`): the stdio handshake, the tool surface, path confinement,
 *  the read-only default and revision-checked writes, spoken to over a real pipe the way an MCP
 *  client does — no SDK, no network, synthetic files in a temporary root. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { core } from '../src/bridge.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(project, 'mcp/server.mjs');

/** A minimal MCP client: newline-delimited JSON-RPC over the child's stdin/stdout. */
function connect(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  const notices = [];
  const waiters = [];
  const stderr = [];
  child.stdout.on('data', bytes => {
    buffer += bytes.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue }
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else notices.push(message);
    }
  });
  child.stderr.on('data', bytes => stderr.push(bytes.toString()));
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时；stderr: ${stderr.join('')}`)); }, 15000);
  });
  const notify = method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return {
    call,
    notify,
    notices,
    stderr,
    async open(clientInfo = { name: 'paper-library-mcp-test', version: '1.0.0' }) {
      const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo });
      notify('notifications/initialized');
      return initialized.result;
    },
    /** A tool call as a client sees it: the text, the structured payload, and the error flag. */
    async tool(name, args = {}) {
      const response = await call('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, `tools/call ${name} must answer, not fail the request: ${JSON.stringify(response.error)}`);
      const text = (response.result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      return { text, data: response.result?.structuredContent, isError: response.result?.isError === true };
    },
    close() { child.kill(); },
  };
}

const BOARD = {
  schema: 'paper-library-board.v1',
  title: '合成画板',
  nodes: [
    { id: 'a', kind: 'concept', text: '城市感知' },
    { id: 'b', kind: 'rect', text: '多源数据' },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'elbow', relation: 'explains' }],
};
const STYLE = { schema: 'paper-library-board-style.v1', layout: { mode: 'tree', direction: 'lr', pins: { a: [120, 80], b: [400, 240] } } };
const THEIR_FILE = '<mxfile host="app.diagrams.net"><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="城市感知" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="80" width="160" height="60" as="geometry"/></mxCell><mxCell id="3" value="多源数据" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="400" y="240" width="160" height="60" as="geometry"/></mxCell><mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';

async function fixture() {
  const run = await mkdtemp(join(tmpdir(), 'paper-library-mcp-'));
  const root = join(run, 'boards');
  const outside = join(run, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'board.json'), `${JSON.stringify(BOARD, null, 2)}\n`);
  await writeFile(join(root, 'board.style.json'), `${JSON.stringify(STYLE, null, 2)}\n`);
  await writeFile(join(root, 'diagram.drawio'), THEIR_FILE);
  await writeFile(join(root, 'notes.txt'), 'not a board');
  await writeFile(join(outside, 'secret.json'), JSON.stringify(BOARD));
  return { run, root, outside };
}

test('the handshake and tool list match what the server advertises', async () => {
  const { root } = await fixture();
  const client = connect(['--root', root]);
  try {
    const initialized = await client.open();
    assert.equal(initialized.serverInfo.name, 'paper-library-board-mcp');
    assert.equal(initialized.protocolVersion, '2025-06-18');
    assert.deepEqual(initialized.capabilities, { tools: { listChanged: false } });
    const listed = await client.call('tools/list', {});
    const names = listed.result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['list_boards', 'read_board', 'read_drawio'], 'read-only by default: no write tool is offered');
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema.type, 'object');
    }
    assert.deepEqual((await client.call('ping', {})).result, {});
    // An unknown method is refused as a protocol error, and the stream stays usable.
    const unknown = await client.call('resources/list', {});
    assert.equal(unknown.error.code, -32601);
    assert.equal((await client.call('tools/list', {})).result.tools.length, 3, 'the session survives an unknown method');
  } finally { client.close(); }
});

test('boards and .drawio files are read, validated and reported', async () => {
  const { root } = await fixture();
  const client = connect(['--root', root]);
  try {
    await client.open();
    const listed = await client.tool('list_boards');
    assert.equal(listed.isError, false);
    assert.deepEqual(listed.data.boards.map(board => board.path.split('/').pop()), ['board.json']);
    assert.equal(listed.data.boards[0].title, '合成画板');
    assert.equal(listed.data.boards[0].style_present, true, 'the sidecar beside it is reported');
    assert.match(listed.text, /1 节点|2 节点/);

    const read = await client.tool('read_board', { path: join(root, 'board.json') });
    assert.equal(read.isError, false);
    assert.deepEqual(read.data.counts, { nodes: 2, edges: 1 });
    assert.match(read.data.outline, /城市感知/);
    assert.match(read.data.outline, /explains|解释/, 'the outline carries the relation');
    assert.equal(read.data.revision, createHash('sha256').update(await readFile(join(root, 'board.json'))).digest('hex'));
    assert.equal((await client.tool('read_board', { path: join(root, 'board.json'), outline: false })).data.outline, '');

    // A board that the app would reject must not be reported as read.
    await writeFile(join(root, 'broken.json'), JSON.stringify({ ...BOARD, schema: 'paper-library-board.v2' }));
    const broken = await client.tool('read_board', { path: join(root, 'broken.json') });
    assert.equal(broken.isError, true);
    assert.match(broken.text, /paper-library-board\.v1/);

    // Their format, both the plain page their MCP server writes and the compressed one draw.io saves.
    const plain = await client.tool('read_drawio', { path: join(root, 'diagram.drawio') });
    assert.equal(plain.isError, false);
    assert.deepEqual(plain.data.counts, { nodes: 2, edges: 1, pages: 1 });
    assert.deepEqual(plain.data.source.nodes.map(node => [node.id, node.kind, node.pin]), [['2', 'concept', [120, 80]], ['3', 'rect', [400, 240]]]);
    assert.deepEqual(plain.data.warnings, []);
    const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="z" value="压缩" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="5" y="6" width="70" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
    await writeFile(join(root, 'zip.drawio'), `<mxfile><diagram id="p" name="压缩页">${Buffer.from(deflateRawSync(encodeURIComponent(model))).toString('base64')}</diagram></mxfile>`);
    const zipped = await client.tool('read_drawio', { path: join(root, 'zip.drawio') });
    assert.equal(zipped.isError, false);
    assert.equal(zipped.data.pages[0].compressed, true, 'the compressed page is named as compressed');
    assert.deepEqual(zipped.data.source.nodes[0], { id: 'z', kind: 'concept', text: '压缩', pin: [5, 6] });
  } finally { client.close(); }
});

test('a path outside the roots, or the wrong extension, is refused rather than resolved', async () => {
  const { root, outside } = await fixture();
  const client = connect(['--root', root]);
  try {
    await client.open();
    const escape = await client.tool('read_board', { path: join(outside, 'secret.json') });
    assert.equal(escape.isError, true);
    assert.match(escape.text, /不在允许的目录里/);
    const traversal = await client.tool('read_board', { path: join(root, '..', 'outside', 'secret.json') });
    assert.equal(traversal.isError, true);
    assert.match(traversal.text, /不在允许的目录里/);
    const wrongType = await client.tool('read_board', { path: join(root, 'notes.txt') });
    assert.equal(wrongType.isError, true);
    assert.match(wrongType.text, /只接受这些扩展名/);
    const missing = await client.tool('read_board', { path: join(root, 'absent.json') });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /文件不存在/);
    // A symlink inside the root must not become a door out of it.
    await symlink(join(outside, 'secret.json'), join(root, 'link.json'));
    const linked = await client.tool('read_board', { path: join(root, 'link.json') });
    assert.equal(linked.isError, true);
    assert.match(linked.text, /不在允许的目录里/);
    // The write tools are simply not part of a read-only session: the name does not exist, which
    // the protocol answers as an invalid parameter rather than as a failed tool run.
    const writing = await client.call('tools/call', { name: 'write_board', arguments: { path: join(root, 'new.json'), source: BOARD, expected_revision: null } });
    assert.equal(writing.error?.code, -32602);
    assert.match(writing.error.message, /没有这个工具：write_board/);
    await assert.rejects(() => readFile(join(root, 'new.json'), 'utf8'), 'a read-only session writes nothing');
  } finally { client.close(); }
});

test('with --write, writes are validated, revision-checked and atomic', async () => {
  const { root } = await fixture();
  const client = connect(['--root', root, '--write']);
  try {
    const initialized = await client.open();
    assert.equal(typeof initialized.instructions, 'string');
    const names = (await client.call('tools/list', {})).result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['list_boards', 'read_board', 'read_drawio', 'write_board', 'write_drawio']);

    // A new board: null revision, then the returned revision for the next write.
    const created = await client.tool('write_board', { path: join(root, 'fresh.json'), source: BOARD, style: STYLE, expected_revision: null });
    assert.equal(created.isError, false);
    assert.deepEqual(Object.keys(created.data).sort(), ['path', 'revision', 'style_path']);
    // macOS resolves `/var` through `/private/var`, and the server reports the path it really used.
    assert.equal(created.data.path, await realpath(join(root, 'fresh.json')));
    assert.equal(created.data.revision, createHash('sha256').update(await readFile(join(root, 'fresh.json'))).digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'fresh.style.json'), 'utf8')).layout.pins.a, [120, 80], 'the sidecar is written beside it');
    assert.equal((await client.tool('read_board', { path: join(root, 'fresh.json') })).data.counts.nodes, 2);

    // Writing again without the current revision is refused; the file is untouched.
    const stale = await client.tool('write_board', { path: join(root, 'fresh.json'), source: { ...BOARD, title: '改过' }, expected_revision: null });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /修订号不匹配/);
    assert.equal(JSON.parse(await readFile(join(root, 'fresh.json'), 'utf8')).title, '合成画板');
    const updated = await client.tool('write_board', { path: join(root, 'fresh.json'), source: { ...BOARD, title: '改过' }, style: STYLE, expected_revision: created.data.revision });
    assert.equal(updated.isError, false);
    assert.equal(JSON.parse(await readFile(join(root, 'fresh.json'), 'utf8')).title, '改过');

    // A file the app would reject never reaches the disk.
    const refused = await client.tool('write_board', { path: join(root, 'bad.json'), source: { ...BOARD, edges: [{ from: 'a', to: 'zzz' }] }, expected_revision: null });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /端点不在本次画板中|端点/);
    await assert.rejects(() => readFile(join(root, 'bad.json'), 'utf8'));

    // Out to .drawio and back: the round trip through their format keeps the board.
    const exported = await client.tool('write_drawio', { path: join(root, 'out.drawio'), source: BOARD, style: STYLE, expected_revision: null });
    assert.equal(exported.isError, false);
    assert.deepEqual(exported.data.counts, { nodes: 2, edges: 1 });
    const xml = await readFile(join(root, 'out.drawio'), 'utf8');
    assert.match(xml, /^<mxfile host="app\.diagrams\.net"/);
    assert.match(xml, /plbKind=concept/, 'our own round-trip markers are written');
    const back = await client.tool('read_drawio', { path: join(root, 'out.drawio') });
    assert.deepEqual(back.data.source.nodes.map(node => [node.id, node.kind]), [['a', 'concept'], ['b', 'rect']]);
    assert.deepEqual(back.data.source.edges.map(edge => [edge.from, edge.to, edge.relation]), [['a', 'b', 'explains']]);
    // Overwriting an existing drawing needs its revision too.
    const overwrite = await client.tool('write_drawio', { path: join(root, 'out.drawio'), source: BOARD, expected_revision: null });
    assert.equal(overwrite.isError, true);
    assert.match(overwrite.text, /修订号不匹配/);
    const rewritten = await client.tool('write_drawio', { path: join(root, 'out.drawio'), source: { ...BOARD, title: '第二版' }, expected_revision: exported.data.revision });
    assert.equal(rewritten.isError, false);
    assert.match(await readFile(join(root, 'out.drawio'), 'utf8'), /第二版/);
  } finally { client.close(); }
});

test('the library tools are read-only, opt-in, and answer with real records', async t => {
  const python = join(project, '.venv/bin/python');
  if (!existsSync(python)) { t.skip('需要本仓库的 .venv（与 python_tests 相同的前提）'); return }
  const run = await mkdtemp(join(tmpdir(), 'paper-library-mcp-lib-'));
  const library = join(run, 'library'), source = join(run, 'source');
  const generated = spawnSync(python, ['scripts/create-demo.py', '--output', source], { cwd: project, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const imported = await core({ action: 'import', path: join(source, 'zotero-export.json') }, { library });
  assert.ok(imported.items.length >= 1, '合成文献库至少有一篇文献');
  const paperId = imported.items[0].id;

  // Without --library the tools are absent; the library is not discovered.
  const bare = connect(['--root', run]);
  try {
    await bare.open();
    const names = (await bare.call('tools/list', {})).result.tools.map(tool => tool.name);
    assert.equal(names.includes('search_papers'), false);
  } finally { bare.close() }

  const client = connect(['--root', run, '--library', library]);
  try {
    const initialized = await client.open();
    assert.match(initialized.instructions, /文献库：只读/);
    const names = (await client.call('tools/list', {})).result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['list_boards', 'read_board', 'read_drawio', 'search_papers', 'read_paper', 'read_annotations']);
    const found = await client.tool('search_papers', { limit: 5 });
    assert.equal(found.isError, false, found.text);
    assert.ok(found.data.items.length >= 1);
    assert.match(found.text, /命中 \d+ 篇/);
    const paper = await client.tool('read_paper', { id: paperId });
    assert.equal(paper.isError, false, paper.text);
    assert.ok(paper.data.title);
    const annotations = await client.tool('read_annotations', { id: paperId });
    assert.equal(annotations.isError, false, annotations.text);
    assert.match(annotations.text, /共有 \d+ 条批注/);
    assert.ok(Array.isArray(annotations.data.annotations));
    // A missing paper is reported as a failed call, not as an empty answer.
    const absent = await client.tool('read_paper', { id: 'p-does-not-exist' });
    assert.equal(absent.isError, true);
    assert.match(absent.text, /失败|不存在/);
  } finally { client.close() }
});

test('a root that does not exist, or no root at all, is a startup error', async () => {
  const missing = spawn(process.execPath, [SERVER, '--root', '/nope/does/not/exist'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const missingErr = await new Promise(resolve => { let text = ''; missing.stderr.on('data', bytes => { text += bytes.toString(); }); missing.on('exit', code => resolve({ code, text })); });
  assert.equal(missingErr.code, 2);
  assert.match(missingErr.text, /根目录不存在/);
  const bare = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
  const bareErr = await new Promise(resolve => { let text = ''; bare.stderr.on('data', bytes => { text += bytes.toString(); }); bare.on('exit', code => resolve({ code, text })); });
  assert.equal(bareErr.code, 2);
  assert.match(bareErr.text, /至少需要一个 --root/);
  assert.match(bareErr.text, /用法/, 'the usage line is printed with the error');
  const badLibrary = spawn(process.execPath, [SERVER, '--library', '/nope/library'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const badLibraryErr = await new Promise(resolve => { let text = ''; badLibrary.stderr.on('data', bytes => { text += bytes.toString(); }); badLibrary.on('exit', code => resolve({ code, text })); });
  assert.equal(badLibraryErr.code, 2);
  assert.match(badLibraryErr.text, /文献库目录不存在/);
});
