import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { askModel } from '../site/library/assistant.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const artifact = process.env.PAGES_ARTIFACT && resolve(process.env.PAGES_ARTIFACT);
const site = artifact || join(project, 'site'), library = join(site, 'library');
const html = await readFile(join(library, 'index.html'), 'utf8');
const base = 'https://mappedinfo.github.io/dsh-paper-library/';

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), '待执行的页面操作完成');
}

test('Pages opens the library directly; previous board sharing URLs keep their source and fragment', async () => {
  const home = await readFile(join(site, 'home.js'), 'utf8');
  const redirect = url => {
    const source = new URL(url, base);
    let target;
    vm.runInNewContext(home, { URL, URLSearchParams, location: {
      href: source.href, search: source.search, hash: source.hash, replace: next => { target = next; },
    } });
    return target;
  };
  assert.equal(redirect(''), base + 'library/');
  assert.equal(redirect('?src=boards%2Fexample.json#item'), base + 'board.html?src=boards%2Fexample.json#item');
  const landing = await readFile(join(site, artifact ? 'index.html' : 'home.html'), 'utf8');
  assert.match(landing, /src="\.\/home\.js"/);
  assert.match(landing, /href="\.\/library\/"/);
});

test('the shelf opens with IndexedDB, imports files and restores them on refresh; folder access is user-initiated', async t => {
  let pickerCalls = 0, selectFolder = false;
  const doms = [];
  const file = new File(['synthetic source'], 'new-folder.tex');
  const folder = {
    kind: 'directory', name: 'Synthetic folder', queryPermission: async () => 'granted',
    async *entries() { yield [file.name, { kind: 'file', getFile: async () => file }]; },
  };
  // Browser FileSystemHandles implement structured cloning and retain their directory identity.
  const clone = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', (value, ...rest) => value?.handle === folder ? { ...value } : clone(value, ...rest));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(() => { for (const dom of doms) dom.window.close(); for (const key of ['window', 'document', 'indexedDB', 'IDBKeyRange']) delete globalThis[key]; });
  async function openShelf(hasPicker = true) {
    const dom = new JSDOM(html, { url: base + 'library/' });
    doms.push(dom);
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    if (hasPicker) dom.window.showDirectoryPicker = async options => {
      pickerCalls++;
      assert.equal(options.mode, 'readwrite');
      if (!selectFolder) throw new DOMException('Reader cancelled', 'AbortError');
      return folder;
    };
    const module = pathToFileURL(join(library, 'app.js'));
    module.searchParams.set('startup', String(doms.length));
    await import(module.href);
    return id => dom.window.document.getElementById(id);
  }
  let el = await openShelf();
  assert.equal(el('shelf').hidden, false);
  assert.equal(el('empty').hidden, false);
  assert.equal(el('import').disabled, false);
  assert.equal(el('new').disabled, false);
  assert.match(el('location').textContent, /浏览器/);
  assert.equal(pickerCalls, 0);
  const files = [new File(['%PDF-1.4\nsynthetic'], 'reading.pdf'), new File(['Synthetic source'], 'draft.tex'),
    new File(['Synthetic illustration'], 'figure.png')];
  Object.defineProperty(el('file-input'), 'files', { value: files });
  el('file-input').dispatchEvent(new window.Event('change'));
  await waitFor(() => !el('import').disabled);
  assert.match(el('files').textContent, /reading\.pdf/);
  assert.match(el('files').textContent, /draft\.tex/);
  assert.match(el('files').textContent, /figure\.png图片/);
  assert.equal(el('paper-list').querySelectorAll('.paper-card').length, 3);
  el('root-latex').click();
  await waitFor(() => !el('root-latex').disabled);
  assert.equal(el('catalog-table').hidden, false);
  assert.equal(el('files').tBodies[0].rows.length, 1);
  el('files').querySelector('button.table-title').click();
  await waitFor(() => el('latex-view') && !el('back').disabled);
  const sourceEditor = el('latex-view').querySelector('textarea');
  assert.equal(sourceEditor.value, 'Synthetic source');
  el('latex-view').querySelector('button[data-layout="source"]').click();
  assert.equal(el('latex-view').querySelector('[data-id="pdf-pane"]').hidden, true);
  sourceEditor.value = 'Updated synthetic draft';
  sourceEditor.dispatchEvent(new window.Event('input'));
  el('latex-view').querySelector('[data-id="save"]').click();
  await waitFor(() => el('latex-view').querySelector('[data-id="status"]').textContent.includes('已保存'));
  el('back').click();
  await waitFor(() => el('document').hidden && !el('back').disabled);
  el = await openShelf();
  assert.equal(el('empty').hidden, true);
  assert.match(el('count').textContent, /3 份/);
  el('location').click();
  assert.equal(el('migrate-row').hidden, false);
  assert.equal(el('open-folder-row').hidden, false);
  assert.equal(pickerCalls, 0);
  el('migrate').click();
  await waitFor(() => !el('migrate').disabled);
  assert.equal(pickerCalls, 1);
  assert.match(el('location').textContent, /浏览器/);
  selectFolder = true;
  el('open-folder').click();
  await waitFor(() => !el('location').disabled);
  assert.match(el('location').textContent, /Synthetic folder/);
  assert.match(el('files').textContent, /new-folder\.tex/);
  assert.doesNotMatch(el('files').textContent, /reading\.pdf/);
  el('location').click(); el('use-browser').click();
  await waitFor(() => !el('location').disabled);
  assert.match(el('files').textContent, /reading\.pdf/);
  el = await openShelf(false);
  el('location').click();
  assert.equal(el('migrate-row').hidden, true);
  assert.equal(el('import-folder-row').hidden, false);
  assert.equal(el('archive').disabled, false);
  assert.equal(pickerCalls, 2);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('the optional model receives only the submitted excerpt and question at the chosen endpoint', async () => {
  const explicit = { endpoint: 'https://example.org/v1/chat/completions', model: 'example-model',
    key: 'fixture-key', excerpt: 'a fictional passage', question: 'Summarize', privateFile: '/private/document.pdf' };
  const reply = await askModel(explicit, async (url, options) => {
    assert.equal(url.href, explicit.endpoint);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer fixture-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, explicit.model);
    assert.deepEqual(JSON.parse(body.messages[1].content), { question: explicit.question, excerpt: explicit.excerpt });
    return Response.json({ choices: [{ message: { content: 'Synthetic answer' }, finish_reason: 'stop' }] });
  });
  assert.equal(reply, 'Synthetic answer');
  await assert.rejects(askModel({ ...explicit, endpoint: 'http://example.org/model' }, assert.fail), /HTTPS/);
});

test('a downloaded ZIP opens with the original filenames, subdirectories and PDF backup bytes', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: base + 'library/' });
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  let downloaded, filename;
  t.mock.method(URL, 'createObjectURL', blob => { downloaded = blob; return 'blob:fixture'; });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function () { filename = this.download; });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => ms === 60000 ? undefined : timeout(fn, ms, ...args));
  const expected = { 'drafts/paper.tex': 'Synthetic source', 'reading.pdf': 'Synthetic annotation',
    '.paper-library-backups/reading.pdf/sample.pdf': 'Synthetic source PDF' };
  const store = { async *exportFiles() {
    for (const [path, bytes] of Object.entries(expected)) yield { path, blob: new Blob([bytes]) };
  } };
  const { exportArchive } = await import(pathToFileURL(join(library, 'archive.js')));
  await exportArchive(store);
  assert.equal(filename, 'Paper-Library.zip');
  const zip = await JSZip.loadAsync(await downloaded.arrayBuffer());
  for (const [path, bytes] of Object.entries(expected)) assert.equal(await zip.file(path).async('string'), bytes);
});

test('published app, lazy editors, archive, fonts and their license notices are present under the Pages base', { skip: !artifact }, async () => {
  const dom = new JSDOM(html, { url: base + 'library/' });
  const licensePage = await readFile(join(library, 'licenses.html'), 'utf8');
  const notices = new JSDOM(licensePage, { url: base + 'library/licenses.html' });
  const urls = [
    ...[...dom.window.document.querySelectorAll('link[href],script[src]')].map(el => el.href || el.src),
    ...[...notices.window.document.querySelectorAll('a[href]')].map(el => el.href),
  ];
  for (const value of urls) {
    if (value.startsWith('data:')) continue;
    assert.ok(value.startsWith(base), value);
    assert.ok(await stat(join(artifact, new URL(value).pathname.slice(new URL(base).pathname.length))), value);
  }
  for (const file of ['board.html','library/archive.js','library/pdf.js','library/latex.js','library/latex-worker.js',
    'library/pdf-assets/pdf.worker.mjs','library/pdf-assets/standard_fonts/LICENSE_LIBERATION',
    'library/tex-engine/dist/index.js','library/tex-engine/LICENSES.txt', 'library/tex-engine/NotoSansSC-Regular.otf']) {
    assert.ok((await stat(join(artifact, file))).size > 0, file);
  }
  assert.equal(await readFile(join(artifact, 'licenses/project-MIT.txt'), 'utf8'), await readFile(join(project, 'LICENSE'), 'utf8'));
  await assert.rejects(stat(join(artifact, 'library-local')), { code:'ENOENT' });
  await assert.rejects(stat(join(library, 'connect.js')), { code:'ENOENT' });
  dom.window.close(); notices.window.close();
});

test('Pages loads the DSH workbench styles in their original order and shares its palette with the board', { skip: !artifact }, async () => {
  const app = new JSDOM(html, { url: base + 'library/', runScripts: 'outside-only' });
  const { window } = app;
  try {
    const links = doc => [...doc.querySelectorAll('link[rel="stylesheet"]')].map(el => el.getAttribute('href'));
    const native = new JSDOM(await readFile(join(project, 'web/index.html'), 'utf8'));
    const shared = links(window.document).filter(path => path.startsWith('./ui/')).map(path => path.slice(5));
    try {
      assert.deepEqual(shared, links(native.window.document).map(path => path.slice(2)).filter(name => shared.includes(name)));
      for (const name of ['workbench.css', 'workspace-navigation.css', 'pdf-reader.css', 'reading-shell.css', 'theme.css', 'icons.css', 'latex-workspace.css']) {
        assert.ok(shared.includes(name), name);
      }
    } finally { native.window.close(); }
    for (const name of [...shared, 'theme.js', 'icons.js', 'fonts/silkscreen-regular.ttf']) {
      assert.deepEqual(await readFile(join(library, 'ui', name)), await readFile(join(project, 'web', name)), name);
    }
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.eval(await readFile(join(library, 'ui/theme.js'), 'utf8'));
    const appearance = await readFile(join(library, 'appearance.js'), 'utf8');
    window.eval(appearance);
    assert.equal(window.document.documentElement.dataset.palette, 'jade');
    window.PaperLibraryAppearance.apply('navy');
    window.PaperLibraryTheme.setPalette('jade');
    window.eval(appearance);
    assert.equal(window.document.documentElement.dataset.palette, 'navy');
    const board = new JSDOM(await readFile(join(artifact, 'board.html'), 'utf8'));
    try {
      assert.ok(board.window.document.querySelector('script[src="./library/appearance.js"]'));
      assert.ok(board.window.document.querySelector('header.topbar.site-header'));
    } finally { board.window.close(); }
  } finally { window.close(); }
});
