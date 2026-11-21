import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { core } from '../src/bridge.mjs';
import { handlePdf } from '../src/pages-pdf.mjs';

const base = 'http://127.0.0.1:43120/api/pages/pdf/';
const readJson = request => request.json();
const request = (name, data) => new Request(base + name, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
});

test('本机导入、分页阅读、写入及版本检查使用同一份原生 PDF，并保留第三方批注', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pages-pdf-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  const source = join(root, 'exercise.pdf'), library = join(root, 'library');
  execFileSync(python, ['-c', `import pymupdf, sys
with pymupdf.open() as d:
    p = d.new_page()
    p.insert_text((40, 60), "Synthetic reading exercise")
    p.add_text_annot((80, 100), "Existing source annotation").update()
    p = d.new_page()
    p.insert_text((40, 90), "Second page evidence")
    p.set_rotation(90)
    d.set_metadata({"title": "Synthetic reading exercise"})
    d.save(sys.argv[1])`, source]);
  const bytes = await readFile(source);
  const actions = [];
  const ctx = { readJson, run: (action, payload) => {
    actions.push(action);
    return core({ ...payload, action }, { library, python });
  } };
  const post = async (name, value) => (await handlePdf(request(name, value), ctx)).json();
  const imported = await (await handlePdf(new Request(base + 'import?filename=exercise.pdf', {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: bytes
  }), ctx)).json();
  const [{ id }] = imported.items;
  assert.equal(imported.duplicates, 0);
  const list = await post('list', { query: 'Synthetic' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, id);
  const first = await post('page', { id, page: 1, render_width: 400, include_layout: true });
  assert.equal(first.page_count, 2);
  assert.equal(first.annotations[0].comment, 'Existing source annotation');
  const second = await post('page', { id, page: 2, render_width: 400 });
  assert.equal(second.rotation, 90);
  const annotation_id = randomUUID();
  const payload = { id, annotation_id, page: 2, rects: [second.words[0].slice(0, 4)], text: second.words[0][4], type: 'highlight', comment: 'Draft' };
  const saved = await post('annotate', payload);
  assert.equal((await post('annotate', payload)).duplicate, true);
  const edit = { id, annotation_id, comment: 'After review', version: saved.annotation.edit_version };
  await post('comment', edit);
  await assert.rejects(post('comment', { ...edit, comment: 'Stale' }), /ANNOTATION_STALE/);
  const updated = await post('page', { id, page: 2 });
  assert.equal(updated.annotations.length, 1);
  assert.equal(updated.annotations[0].comment, 'After review');
  const download = await handlePdf(new Request(base + 'download?id=' + id), ctx);
  assert.equal(download.headers.get('Content-Type'), 'application/pdf');
  const exported = join(root, 'annotated.pdf');
  await writeFile(exported, Buffer.from(await download.arrayBuffer()));
  const readback = execFileSync(python, ['-c', `import json, pymupdf, sys
with pymupdf.open(sys.argv[1]) as d:
    print(json.dumps([[p.number, a.type[1], a.info["content"]] for p in d for a in p.annots()]))`, exported], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readback), [[0, 'Text', 'Existing source annotation'], [1, 'Highlight', 'After review']]);
  assert.deepEqual(await readFile(source), bytes);
  assert.ok((await readdir(join(library, 'backups'))).length);
  assert.deepEqual(new Set(actions), new Set(['import', 'list', 'page', 'annotate', 'annotation_update', 'export_pdf']));
});

test('网页导入只接受选中的 PDF 字节，公开路由不能接收工作目录、任意内核操作或大文件', async () => {
  const ctx = { readJson, run() { throw new Error('意外调用内核'); } };
  const upload = (name, size) => new Request(base + 'import?filename=' + encodeURIComponent(name), {
    method: 'POST', headers: { 'content-type': 'application/pdf', 'content-length': String(size) }, body: 'test'
  });
  for (const name of ['../example.pdf', 'page.json', 'foo\\example.pdf']) {
    await assert.rejects(handlePdf(upload(name, 4), ctx), /文件名无效/);
  }
  await assert.rejects(handlePdf(upload('x.pdf', 65 * 1024 * 1024), ctx), error => error.status === 413);
  assert.equal(await handlePdf(request('inspect_pdf', { path: '/tmp/external' }), ctx), null);
  await assert.rejects(handlePdf(request('page', { id: 'x', page: 1 }), ctx), /标识无效/);
  await assert.rejects(handlePdf(request('comment', { id: 'a'.repeat(32), annotation_id: 'note', comment: '' }), ctx), /版本/);
});
