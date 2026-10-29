import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../web/latex-writing-tools.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const { parseTable, tableLatex, figureLatex } = window.PaperLatexWritingTools;
const plain = value => JSON.parse(JSON.stringify(value));

test('Markdown imports header and alignment and preserves escaped pipes', () => {
  const result = plain(parseTable('| Name | Value |\n| :--- | ---: |\n| A \\| B | 0.25 |'));
  assert.deepEqual(result.rows, [['Name', 'Value'], ['A | B', '0.25']]);
  assert.deepEqual(result.alignments, ['l', 'r']); assert.equal(result.header, true);
});
test('Excel clipboard TSV handles quoted tabs, newlines, double quotes and empty leading cells', () => {
  const result = plain(parseTable('\tValue\n"A\tB"\t"Line 1\nLine 2"\n"Say ""hi"""\t2\n'));
  assert.deepEqual(result.rows, [['', 'Value'], ['A\tB', 'Line 1\nLine 2'], ['Say "hi"', '2']]);
  assert.throws(() => parseTable('"unclosed\tvalue'), /引号未闭合/);
});
test('LaTeX tables escape ordinary text rather than executing pasted commands', () => {
  const text = tableLatex({ rows: [['Name', 'Value'], ['A & B_1%', '\\input{private}']], alignments: ['l', 'r'], header: true, caption: 'A # $', label: 'tab:a bad' });
  assert.match(text, /\\begin\{tabular\}\{lr\}/);
  assert.match(text, /A \\& B\\_1\\%/);
  assert.match(text, /\\textbackslash\{\}input\\\{private\\\}/);
  assert.match(text, /\\caption\{A \\# \\\$\}/);
  assert.match(text, /\\label\{tab:a-bad\}/);
  assert.equal((text.match(/\\hline/g) || []).length, 3);
});
test('table bounds and image template remain explicit', () => {
  assert.throws(() => parseTable(Array.from({ length: 101 }, () => 'x').join('\n')), /100/);
  assert.throws(() => parseTable(Array.from({ length: 31 }, () => 'x').join('\t')), /30/);
  const text = figureLatex('figures/synthetic-123.png');
  assert.match(text, /\\includegraphics\[width=0\.9\\linewidth\]\{figures\/synthetic-123\.png\}/);
  assert.match(text, /\\label\{fig:synthetic-123\}/);
});

function fixture(api, insert = () => false) {
  const ids = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.value = ''; this.hidden = false; this.open = false; this.files = []; this.classList = { toggle() {} }; }
    set id(value) { this._id = value; ids.set(value, this); }
    set textContent(value) { this._text = value; this.children = []; } get textContent() { return this._text || this.children.map(node => node.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    setAttribute() {} addEventListener(type, handler) { this.events.set(type, handler); }
    showModal() { this.open = true; } close() { this.open = false; } focus() {} select() {} remove() {}
  }
  const document = { createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; } }, window = {};
  vm.runInNewContext(source, { window, document, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  const state = { id: 'first', title: 'Original project', path: 'one.tex', content: 'text', selectionStart: 1, selectionEnd: 1 };
  const ui = window.PaperLatexWritingTools.create({ root: new Element('section'), api, getContext: () => state, insert });
  return { ui, ids, state };
}
const settled = () => new Promise(done => setImmediate(done));

test('XLSX sheet switching reuses workbook bytes without dereferencing a missing file', async () => {
  const calls = [];
  const f = fixture(async (_action, value) => {
    calls.push(value);
    if (value.sheet === 'Uncached formula') throw new Error('公式没有缓存结果');
    return { sheets: ['Values', 'Uncached formula'], sheet: 'Values', rows: [['Name', 'Value'], ['A', '2']], warnings: [] };
  });
  f.ui.table();
  const file = f.ids.get('latex-table-file');
  file.files = [{ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }];
  file.events.get('change')(); await settled();
  assert.equal(calls.length, 1);
  const sheet = f.ids.get('latex-table-sheet'); sheet.value = 'Uncached formula'; sheet.events.get('change')(); await settled();
  assert.equal(calls.length, 2); assert.equal(calls[1].data_base64, calls[0].data_base64);
  assert.equal(calls[1].sheet, 'Uncached formula');
  assert.match(f.ids.get('latex-writing-status').textContent, /公式没有缓存结果/);
  assert.deepEqual(plain(f.ui.testHooks.rows()), [['Name', 'Value'], ['A', '2']]);
});

test('closed table draft keeps its original insertion target after project switch', () => {
  let target;
  const f = fixture(async () => ({}), (_text, expected) => { target = expected; return false; });
  f.ui.table(); const output = f.ids.get('latex-writing-output').value;
  f.ids.get('latex-writing-dialog').close();
  f.state.id = 'second'; f.state.title = 'Other project'; f.state.path = 'two.tex';
  f.ui.table();
  assert.match(f.ids.get('latex-writing-target').textContent, /Original project \/ one\.tex/);
  f.ids.get('latex-writing-insert').events.get('click')();
  assert.equal(target.id, 'first'); assert.equal(target.path, 'one.tex');
  assert.equal(f.ids.get('latex-writing-output').value, output); assert.equal(f.ui.hasDraft(), true);
  assert.match(f.ids.get('latex-writing-status').textContent, /已保留/);
});
