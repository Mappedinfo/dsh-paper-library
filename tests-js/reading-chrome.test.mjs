import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
