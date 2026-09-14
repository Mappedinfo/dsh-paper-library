import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute production event handlers and queue code. Network and DOM are doubles;
// filesystem persistence and actual browser rendering have separate integration checks.
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
assert.match(source, /\ninitialize\(\);\s*$/);
const testSource = source.replace(/\ninitialize\(\);\s*$/, '\n') + `
globalThis.testUI = { state, intake, enqueueFiles, enqueueImports, enqueueLink,
  handleDrop, handlePaste, linkArguments, executeImport, importOutcome };
`;

function environment(onRequest) {
  const elements = new Map(), labels = new Map(), requests = [], documentListeners = new Map();
  let readerCalls = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false; this.listeners = new Map();
      const classes = new Set(); this.classList = { add: key => classes.add(key), remove: key => classes.delete(key), toggle: (key, value) => value ? classes.add(key) : classes.delete(key) };
    }
    set id(value) { this._id = value; elements.set(value, this); } get id() { return this._id; }
    set value(value) { this._value = String(value); } get value() { return this._value ?? (this.tagName === 'SELECT' ? this.firstElementChild?.value || '' : this.tagName === 'OPTION' ? this.textContent : ''); }
    get firstElementChild() { return this.children[0]; }
    append(...nodes) { for (const node of nodes) { if (node.tagName === 'FRAGMENT') this.append(...node.children); else { this.children.push(node); node.parentElement = this; } } }
    replaceChildren(...nodes) { this.children = []; this._value = undefined; this.append(...nodes); }
    closest(selector) {
      if (selector === 'label') { if (!labels.has(this)) labels.set(this, new Element('label')); return labels.get(this); }
      if (selector.includes('input') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName)) return this;
      return null;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    before() {} after() {} setAttribute() {} removeAttribute() {} focus() {} select() {} close() { this.open = false; } showModal() { this.open = true; }
    querySelectorAll() { return []; }
  }
  function element(id) {
    if (!elements.has(id)) { const tag = id === 'feedback-model' ? 'select' : ['quick-import-source', 'import-source', 'search'].includes(id) ? 'input' : id === 'annotation-comment' ? 'textarea' : 'div'; const node = new Element(tag); node.id = id; }
    return elements.get(id);
  }
  const document = { getElementById: element, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), querySelectorAll: () => [], querySelector: () => new Element(), addEventListener: (type, listener) => documentListeners.set(type, listener), body: new Element('body') };
  const window = { location: { origin: 'http://localhost:3080' }, addEventListener() {}, getSelection: () => ({ removeAllRanges() {} }) }; window.parent = window;
  const fetch = async (url, options) => {
    const raw = String(url).startsWith('./upload?'); const request = raw ? { action: 'upload', filename: new URL(url, window.location.origin).searchParams.get('filename') } : JSON.parse(options.body);
    const call = { request, url, options }; requests.push(call);
    const supplied = await onRequest?.(call);
    if (supplied?.error) return { ok: false, status: 400, json: async () => ({ ok: false, error: supplied.error }) };
    let result = supplied;
    if (result === undefined) {
      if (request.action === 'list') result = { items: [], total: 0 };
      else if (request.action === 'status') result = { count: 0, library: '/synthetic/library' };
      else throw new Error(`Unexpected request: ${request.action}`);
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  class FileReader {
    readAsDataURL(file) { readerCalls++; this.result = `data:application/json;base64,${Buffer.from(file.testContents || '[]').toString('base64')}`; this.onload(); }
  }
  const context = vm.createContext({ document, window, fetch, FileReader, URL, console, ResizeObserver: class { observe() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 1, clearTimeout() {}, structuredClone });
  vm.runInContext(testSource, context, { filename: 'web/app.js' });
  const ui = context.testUI; ui.state.active = { id: 'already-reading', pdf: false };
  const imports = () => requests.filter(call => ['upload', 'import'].includes(call.request.action));
  return { ui, element, requests, imports, documentListeners, readerCalls: () => readerCalls };
}
function pdfResult(name) { return { imported: 1, duplicates: 0, items: [{ id: name, title: `Parsed ${name}`, pdf: true, pdf_filename: `2026-Wang-${name}`, parse: { status: 'parsed', needs_review: true } }], warnings: [] }; }
function event(target, data = {}) { let prevented = false; return { target, ...data, preventDefault() { prevented = true; }, get prevented() { return prevented; } }; }
function pasteEvent(target, text) { return event(target, { clipboardData: { getData: () => text } }); }

test('dropping multiple PDFs anywhere starts a sequential raw File upload without a confirmation dialog', async () => {
  let releaseFirst;
  const firstPending = new Promise(resolve => { releaseFirst = resolve; });
  const fixture = environment(call => call.request.action === 'upload' ? call.request.filename === 'first.pdf' ? firstPending : pdfResult(call.request.filename) : undefined);
  const first = new File(['%PDF first'], 'first.pdf', { type: 'application/pdf' });
  const second = new File(['%PDF second'], 'second.pdf', { type: 'application/pdf' });
  const dropped = event(fixture.element('paper-title'), { dataTransfer: { files: [first, second] } });
  fixture.documentListeners.get('drop')(dropped);
  assert.equal(dropped.prevented, true);
  assert.equal(fixture.imports().length, 1, 'the second upload waits for the first result');
  assert.equal(fixture.ui.intake.pending.length, 1);
  assert.equal(fixture.element('import-dialog').open, false);
  assert.equal(fixture.imports()[0].options.body, first, 'send the File object, without a byte/base64 copy');
  assert.equal(fixture.imports()[0].options.headers['Content-Type'], 'application/pdf');
  releaseFirst(pdfResult('first.pdf'));
  await fixture.ui.intake.promise;
  assert.equal(fixture.imports().length, 2);
  assert.equal(fixture.imports()[1].options.body, second);
  assert.equal(fixture.readerCalls(), 0, 'PDFs never pass through FileReader');
  assert.equal(fixture.ui.intake.completed, 2);
  assert.ok(fixture.ui.intake.records.every(job => job.file === null));
  assert.equal(fixture.ui.intake.records[0].summary.filenames[0], '2026-Wang-first.pdf');
  assert.match(fixture.ui.intake.records[0].message, /待核对/);
});

test('one failed PDF is isolated and following files continue; failed File references are released', async () => {
  const fixture = environment(call => call.request.action === 'upload' ? call.request.filename === 'broken.pdf' ? { error: 'PDF is damaged' } : pdfResult(call.request.filename) : undefined);
  fixture.ui.enqueueFiles([new File(['broken'], 'broken.pdf'), new File(['%PDF'], 'good.pdf')]);
  await fixture.ui.intake.promise;
  assert.equal(fixture.ui.intake.failed, 1);
  assert.equal(fixture.ui.intake.completed, 1);
  assert.equal(fixture.ui.intake.records[0].status, 'failed');
  assert.match(fixture.ui.intake.records[0].message, /damaged/);
  assert.equal(fixture.ui.intake.records[1].status, 'done');
  assert.ok(fixture.ui.intake.records.every(job => job.file === null));
});

test('pasting links preserves annotation editing and auto-imports from quick input with honest metadata-only status', async () => {
  const fixture = environment(call => call.request.action === 'import' ? { imported: 1, items: [{ id: 'metadata-only', title: 'Metadata only', pdf: false }], acquisition: { status: 'metadata_only', warnings: ['Open PDF unavailable'] } } : undefined);
  const url = 'https://arxiv.org/abs/2601.01234';
  const annotationPaste = pasteEvent(fixture.element('annotation-comment'), url);
  fixture.documentListeners.get('paste')(annotationPaste);
  assert.equal(annotationPaste.prevented, false);
  assert.equal(fixture.imports().length, 0);
  const quickPaste = pasteEvent(fixture.element('quick-import-source'), url);
  fixture.documentListeners.get('paste')(quickPaste);
  await fixture.ui.intake.promise;
  assert.equal(quickPaste.prevented, true);
  assert.equal(fixture.imports()[0].request.url, url);
  assert.equal(fixture.element('quick-import-source').value, '');
  assert.equal(fixture.ui.intake.records[0].status, 'review');
  assert.match(fixture.ui.intake.records[0].message, /仅保存文献资料，尚未取得 PDF/);
  assert.equal(fixture.ui.intake.metadataOnly, 1);
  assert.equal(fixture.ui.intake.records[0].summary.warnings[0], 'Open PDF unavailable');
});

test('plain-link drop and DOI paste use acquisition arguments while prose and unsafe schemes remain ordinary input', async () => {
  const fixture = environment(call => call.request.action === 'import' ? pdfResult('linked.pdf') : undefined);
  const prose = pasteEvent(fixture.element('paper-title'), 'Read this: https://example.com/paper');
  fixture.documentListeners.get('paste')(prose);
  assert.equal(prose.prevented, false);
  assert.equal(fixture.ui.linkArguments('javascript:alert(1)'), null);
  assert.equal(fixture.ui.linkArguments('https://user:secret@example.com/paper.pdf'), null);
  const dropped = event(fixture.element('paper-title'), { dataTransfer: { files: [], getData: type => type === 'text/uri-list' ? '# comment\nhttps://example.com/paper.pdf' : '' } });
  fixture.documentListeners.get('drop')(dropped);
  await fixture.ui.intake.promise;
  assert.equal(dropped.prevented, true);
  assert.equal(fixture.imports()[0].request.url, 'https://example.com/paper.pdf');
  const doiPaste = pasteEvent(fixture.element('paper-title'), '10.1234/example');
  fixture.documentListeners.get('paste')(doiPaste);
  await fixture.ui.intake.promise;
  assert.equal(fixture.imports()[1].request.doi, '10.1234/example');
});

test('queue capacity is bounded at 50 and oversize PDF validation does not block subsequent files', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const fixture = environment(call => call.request.action === 'upload' ? call.request.filename === '0.pdf' ? held : pdfResult(call.request.filename) : undefined);
  const files = Array.from({ length: 51 }, (_, index) => new File(['%PDF'], `${index}.pdf`));
  assert.equal(fixture.ui.enqueueFiles(files), 50);
  assert.equal(fixture.ui.intake.pending.length, 49);
  assert.equal(fixture.ui.intake.records.length, 50);
  assert.match(fixture.element('toast').textContent, /还有 1 项尚未加入/);
  release(pdfResult('0.pdf')); await fixture.ui.intake.promise;
  assert.equal(fixture.imports().length, 50);
  fixture.ui.enqueueFiles([{ name: 'too-large.pdf', size: 250 * 1024 * 1024 + 1 }, new File(['%PDF'], 'small.pdf')]);
  await fixture.ui.intake.promise;
  assert.equal(fixture.imports().length, 51, 'oversize PDF is rejected before network upload');
  assert.equal(fixture.ui.intake.records.at(-2).status, 'failed');
  assert.equal(fixture.ui.intake.records.at(-1).status, 'done');
  assert.equal(fixture.ui.intake.records.length, 50, 'completed history is bounded too');
});

test('metadata file uploads retain 100-record continuation and read the file only once', async () => {
  const fixture = environment(call => call.request.action === 'import' ? { imported: call.request.offset ? 1 : 100, items: [{ id: `record-${call.request.offset}`, title: 'Record', pdf: false }], total_records: 101, done: Boolean(call.request.offset), next_offset: call.request.offset ? null : 100 } : undefined);
  fixture.ui.enqueueFiles([{ name: 'library.json', size: 2, testContents: '[]' }]);
  await fixture.ui.intake.promise;
  assert.equal(fixture.readerCalls(), 1);
  assert.deepEqual(fixture.imports().map(call => call.request.offset), [0, 100]);
  assert.ok(fixture.imports().every(call => call.request.limit === 100));
  assert.equal(fixture.ui.intake.records[0].summary.imported, 101);
  assert.equal(fixture.ui.intake.records[0].file, null);
});

test('a failed pasted link keeps its input and retry source instead of clearing unhandled work', async () => {
  const fixture = environment(call => call.request.action === 'import' ? { error: 'Download timed out' } : undefined);
  const url = 'https://example.com/paper.pdf';
  fixture.ui.handlePaste(pasteEvent(fixture.element('quick-import-source'), url));
  await fixture.ui.intake.promise;
  assert.equal(fixture.element('quick-import-source').value, url);
  assert.equal(fixture.ui.intake.records[0].args.url, url);
  assert.equal(fixture.ui.intake.records[0].status, 'failed');
});
