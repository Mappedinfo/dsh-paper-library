import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/reading-shell.js', import.meta.url), 'utf8');
const placement = source.slice(source.indexOf('  function placeMenu('), source.indexOf('  function create('));
const windows = await readFile(new URL('../web/floating-windows.js', import.meta.url), 'utf8');
const below = windows.slice(windows.indexOf('  function placeBelow('), windows.indexOf('  function attach('));

function fixture({ left = 120, bottom = 96, width = 320, viewportWidth = 1512, viewportHeight = 982, open = true } = {}) {
  const anchor = { left, bottom };
  const style = {};
  const panel = { style, getBoundingClientRect: () => ({ width }) };
  const disclosure = { open, querySelector: () => ({ getBoundingClientRect: () => anchor }) };
  const context = vm.createContext({ window: { innerWidth: viewportWidth, innerHeight: viewportHeight } });
  vm.runInContext(`${below}; window.PaperFloatingWindows = {placeBelow}; ${placement}`, context);
  return { anchor, panel, disclosure, context, place: () => context.placeMenu(disclosure, panel) };
}

test('small menu stays directly beneath its own trigger and follows a moved trigger', () => {
  const f = fixture(); f.place();
  assert.equal(f.panel.style.position, 'fixed');
  assert.equal(f.panel.style.top, '101px');
  assert.equal(f.panel.style.left, '120px');
  assert.equal(f.panel.style.right, 'auto');
  f.anchor.left = 470; f.anchor.bottom = 140; f.place();
  assert.equal(f.panel.style.top, '145px');
  assert.equal(f.panel.style.left, '470px');
});

test('right-edge menus remain on screen while preserving the trigger bottom edge', () => {
  const f = fixture({ left: 1450, bottom: 180 }); f.place();
  assert.equal(f.panel.style.left, '1184px');
  assert.equal(f.panel.style.top, '185px');
  assert.equal(f.panel.style.maxHeight, '789px');
  f.context.window.innerWidth = 800; f.place();
  assert.equal(f.panel.style.left, '472px');
  assert.equal(f.panel.style.maxWidth, '784px');
});

test('a clipped trigger and oversized menu retain horizontal gutters and a bounded scroll area', () => {
  const f = fixture({ left: -20, bottom: 770, width: 2000, viewportWidth: 1154, viewportHeight: 788 }); f.place();
  assert.equal(f.panel.style.left, '8px');
  assert.equal(f.panel.style.maxWidth, '1138px');
  assert.equal(f.panel.style.top, '775px');
  assert.equal(f.panel.style.maxHeight, '5px');
  f.disclosure.open = false; f.anchor.bottom = 100; f.place();
  assert.equal(f.panel.style.top, '775px', 'Closed menu positioning is left alone.');
});

test('opening a menu closes the previous menu, and geometry updates only open menus', () => {
  const start = source.indexOf('    const menus=[];');
  const end = source.indexOf("    let context=", start);
  const calls = [], context = vm.createContext({ placeMenu: (disclosure, panel) => { if (disclosure.open) calls.push(panel.id); } });
  vm.runInContext(`${source.slice(start, end)}; this.bind = bindMenu; this.place = placeMenus;`, context);
  const first = { open: true, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const second = { open: false, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  context.bind(first, { id: 'citation' }); context.bind(second, { id: 'pen' });
  second.open = true; second.events.toggle();
  assert.equal(first.open, false); assert.equal(second.open, true);
  context.place(); assert.deepEqual(calls, ['pen', 'pen']);
});

const require = createRequire(import.meta.url);
let JSDOM;
try { ({JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}

test('reading and drawing feedback stays in the active tools without a separate status row', {skip: !JSDOM}, async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {runScripts:'outside-only', url:'http://synthetic.invalid/'});
  const w = dom.window, doc = w.document;
  for (const id of ['metadata-enrich','catalog-archive']) {
    const button = doc.createElement('button'); button.id = id; doc.body.append(button);
  }
  w.eval(source);
  const ui = w.PaperReadingShell.create({
    state: {active:{id:'synthetic', pdf:true},page:1,tab:'reader'},
    workbench:()=>({isTable:()=>false}), panels:()=>({visible:()=>false}),
    reader:()=>({setTool(){}}), navigate(){}, toast(){},
  });
  try {
    ui.arrangeControls();
    const message = doc.getElementById('page-message'), draft = doc.getElementById('reader-ink-draft');
    assert.equal(doc.getElementById('reader-status-bar'), null);
    assert.equal(message.hidden, true);
    assert.equal(draft.hidden, true);
    ui.focusChanged({pending:true,canReturn:true});
    assert.equal(message.closest('#toolbar-reader')?.id, 'toolbar-reader');
    assert.equal(message.hidden, false);
    ui.focusChanged({pending:false,canReturn:true});
    assert.equal(message.hidden, true);
    ui.status('正在载入 PDF 首屏…', false, {scope:'page'});
    ui.status('', false, {scope:'page'});
    assert.equal(message.hidden, true);
    ui.setTool('ink');
    assert.equal(draft.closest('#paper-tools')?.id, 'paper-tools');
    assert.equal(draft.hidden, false);
    ui.status('笔迹尚未保存', true);
    assert.equal(message.closest('#toolbar-annotation')?.id, 'toolbar-annotation');
    assert.equal(message.classList.contains('error'), true);
    ui.focusChanged({pending:false,canReturn:true});
    ui.status('', false, {scope:'page'});
    assert.equal(message.textContent, '笔迹尚未保存');
    doc.body.classList.add('board-mode');
    ui.status('正在载入 PDF 首屏…');
    assert.equal(message.hidden, true);
    assert.equal(message.textContent, '');
    const css = await readFile(new URL('../web/reading-shell.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /--reader-status-height|\.reader-status-bar/);
    assert.match(css, /body\.board-mode \.reader-ink-draft/);
  } finally { ui.dispose(); w.close(); }
});
