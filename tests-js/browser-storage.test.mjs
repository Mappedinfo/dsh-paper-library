import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { kindForPath, MAX_ASSET_BYTES, openBrowserLibrary } from '../site/library/storage.js';

globalThis.IDBKeyRange = IDBKeyRange;

function missing() { return new DOMException('Missing', 'NotFoundError'); }

class FileHandle {
  kind = 'file';
  blob = new Blob();
  lastModified = 0;
  constructor(name) { this.name = name; }
  async getFile() { return new File([this.blob], this.name, { lastModified: this.lastModified }); }
  async isSameEntry(other) { return other === this; }
  async createWritable() {
    let pending;
    return {
      write: async blob => { pending = blob; },
      close: async () => {
        if (this.rejectSave) throw new Error('磁盘空间不足');
        this.blob = pending;
        this.lastModified++;
      },
      abort: async () => {},
    };
  }
}

class Directory {
  kind = 'directory';
  grant = 'granted';
  children = new Map();
  constructor(name) { this.name = name; }
  queryPermission() { return this.grant; }
  requestPermission() { this.grant = 'granted'; return this.grant; }
  async *entries() { yield* this.children; }
  getFileHandle(name, options = {}) { return this.child(name, options.create, 'file'); }
  getDirectoryHandle(name, options = {}) { return this.child(name, options.create, 'directory'); }
  async child(name, create, kind) {
    if (!this.children.has(name)) {
      if (!create) throw missing();
      this.children.set(name, kind === 'file' ? new FileHandle(name) : new Directory(name));
      if (name === this.failFor) this.children.get(name).rejectSave = true;
    }
    const item = this.children.get(name);
    if (item.kind !== kind) throw new DOMException('Wrong entry type', 'TypeMismatchError');
    return item;
  }
  async removeEntry(name) { this.children.delete(name); }
}

function fixture(t) {
  const indexedDB = new IDBFactory();
  const dir = new Directory('Manuscripts');
  // Browsers structured-clone FileSystemDirectoryHandle as another reference to the same folder.
  const clone = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', (value, ...rest) => {
    if (value?.handle instanceof Directory) return { ...clone({ ...value, handle: null }), handle: value.handle };
    return clone(value, ...rest);
  });
  return { dir, open: () => openBrowserLibrary({ indexedDB }) };
}
async function contents(store) {
  const paths = {};
  for await (const { path, blob } of store.exportFiles()) paths[path] = await blob.text();
  return paths;
}

test('browser library persists, compares revisions across tabs and keeps native PDF backups', async t => {
  const { open } = fixture(t);
  const first = await open();
  const pdf = 'papers/reading.pdf';
  assert.equal(first.mode, 'browser');
  assert.deepEqual(await first.list(), []);
  const original = await first.write(pdf, new Blob(['synthetic PDF bytes']), null);
  const second = await open();
  assert.equal((await second.read(pdf)).revision, original.revision);
  const changes = await Promise.allSettled([
    first.write(pdf, new Blob(['annotated bytes A']), original.revision),
    second.write(pdf, new Blob(['annotated bytes B']), original.revision),
  ]);
  assert.deepEqual(changes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  const files = await contents(second);
  assert.equal(files['.paper-library-backups/' + pdf + '/' + original.revision + '.pdf'], 'synthetic PDF bytes');
  assert.equal((await first.list()).length, 1);
  await assert.rejects(second.write(pdf, new Blob(['new']), null), /修改/);
  await assert.rejects(first.write('../other.tex', new Blob(), null), /路径/);
  await assert.rejects(first.write(pdf + '/impossible.tex', new Blob(), null), /目录路径冲突/);
  await first.write('chapter.tex/intro.tex', new Blob(), null);
  await assert.rejects(first.write('chapter.tex', new Blob(), null), /目录路径冲突/);
  assert.equal(kindForPath('refs/references.bib'), 'tex');
});

test('migration preflights conflicts, tolerates matching files, restores the folder and preserves browser data', async t => {
  const { open, dir } = fixture(t);
  const store = await open();
  await store.write('a.pdf', new Blob(['first']), null);
  await store.write('z.tex', new Blob(['manuscript']), null);
  await store.write('figures/plot.JPEG', new Blob(['synthetic illustration']), null);
  await assert.rejects(store.write('large.png', new Blob([new Uint8Array(MAX_ASSET_BYTES + 1)]), null), /16 MiB/);
  const other = await dir.getFileHandle('z.tex', { create: true });
  other.blob = new Blob(['other source']);
  await assert.rejects(store.migrateTo(dir), /同名/);
  assert.equal(store.mode, 'browser');
  assert.deepEqual([...dir.children.keys()], ['z.tex']);
  assert.equal(await other.blob.text(), 'other source');
  other.blob = new Blob(['manuscript']);
  await dir.getFileHandle('private.csv', { create: true });
  const stale = await open();
  await store.migrateTo(dir);
  assert.equal(store.mode, 'folder');
  const again = await open();
  assert.equal(again.name, 'Manuscripts');
  assert.deepEqual((await again.list()).map(f => [f.path, f.kind]), [['a.pdf', 'pdf'], ['figures/plot.JPEG', 'asset'], ['z.tex', 'tex']]);
  assert.equal(await (await again.read('figures/plot.JPEG')).blob.text(), 'synthetic illustration');
  assert.equal((await contents(again))['figures/plot.JPEG'], 'synthetic illustration');
  const read = await again.read('z.tex');
  await again.write('z.tex', new Blob(['revised in folder']), read.revision);
  assert.equal(await other.blob.text(), 'revised in folder');
  await assert.rejects(stale.write('late.tex', new Blob(), null), /其他标签页/);
  dir.grant = 'prompt';
  const paused = await open();
  assert.equal(paused.mode, 'folder');
  assert.equal(paused.needsPermission, true);
  await assert.rejects(paused.list(), /授权/);
  await paused.reconnect();
  assert.equal((await paused.read('z.tex')).revision, (await again.read('z.tex')).revision);
  await paused.useBrowser();
  assert.equal(await (await paused.read('z.tex')).blob.text(), 'manuscript');
});

test('ordinary folders retain existing files, local PDF edits save backups and a failed commit keeps original bytes', async t => {
  const { open, dir } = fixture(t);
  const docs = await dir.getDirectoryHandle('sources', { create: true });
  const pdf = await docs.getFileHandle('paper.pdf', { create: true });
  pdf.blob = new Blob(['synthetic original bytes']);
  const store = await open();
  await store.openFolder(dir);
  const path = 'sources/paper.pdf';
  const before = await store.read(path);
  pdf.rejectSave = true;
  await assert.rejects(store.write(path, new Blob(['synthetic annotation']), before.revision), /空间/);
  assert.equal(await pdf.blob.text(), 'synthetic original bytes');
  pdf.rejectSave = false;
  await store.write(path, new Blob(['synthetic annotation']), before.revision);
  assert.equal(await pdf.blob.text(), 'synthetic annotation');
  assert.equal((await contents(store))['.paper-library-backups/' + path + '/' + before.revision + '.pdf'], 'synthetic original bytes');
  const prior = await store.read(path);
  pdf.blob = new Blob(['different native file']);
  await assert.rejects(store.write(path, new Blob(['attempt']), prior.revision), /修改/);
  assert.equal(await pdf.blob.text(), 'different native file');
});

test('an interrupted migration resumes after verified copies and includes the original PDF backup', async t => {
  const { open, dir } = fixture(t);
  const store = await open();
  const first = await store.write('a.pdf', new Blob(['synthetic PDF']), null);
  await store.write('a.pdf', new Blob(['with notes']), first.revision);
  await store.write('z.tex', new Blob(['source']), null);
  const expected = await contents(store);
  dir.failFor = 'z.tex';
  await assert.rejects(store.migrateTo(dir), /空间/);
  assert.equal(store.mode, 'browser');
  assert.deepEqual(await contents(store), expected);
  assert.equal(await (await dir.getFileHandle('a.pdf')).blob.text(), 'with notes');
  assert.equal(dir.children.has('z.tex'), false);
  dir.failFor = undefined;
  await store.migrateTo(dir);
  assert.deepEqual(await contents(store), expected);
  assert.deepEqual(await contents(await open()), expected);
});
