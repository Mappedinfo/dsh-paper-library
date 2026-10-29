import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); let JSDOM;
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')); } catch {}
const source = await readFile(new URL('../web/floating-windows.js', import.meta.url), 'utf8');
function fixture(store) {
  const dom = new JSDOM('<!doctype html><aside id="panel" class="reading-side-panel"><header><strong>资料详情</strong><button id="close">关闭</button></header><input id="draft" value="synthetic draft"><dialog id="embedded"><header>嵌入的表单</header></dialog></aside>', { runScripts: 'outside-only' });
  const { window: w } = dom, panel = w.document.getElementById('panel');
  Object.defineProperties(w, { innerWidth: { value: 1512, writable: true }, innerHeight: { value: 982, writable: true } });
  panel.getBoundingClientRect = () => { const left = parseFloat(panel.style.left) || 30, top = parseFloat(panel.style.top) || 120, width = parseFloat(panel.style.width) || 300, height = parseFloat(panel.style.height) || 500; return { left, top, width, height, right: left + width, bottom: top + height }; };
  panel.getClientRects = () => panel.hidden ? [] : [panel.getBoundingClientRect()];
  let captured; panel.setPointerCapture = id => captured = id; panel.hasPointerCapture = id => captured === id; panel.releasePointerCapture = () => captured = null;
  w.eval(source); const api = w.PaperFloatingWindows.attach(panel, { persistence: store });
  const pointer = (target, type, x, y) => { const event = new w.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y }); target.dispatchEvent(event); return event; };
  return { dom, w, panel, api, pointer };
}

test('shared title dragging clamps windows and leaves form controls and closing to their owner', { skip: !JSDOM }, async () => {
  const writes = [], f = fixture({ get: async () => null, put: async (...args) => writes.push(args) }); await f.api.restore();
  const close = f.panel.querySelector('#close'); let clicked = 0; close.onclick = () => clicked++;
  assert.equal(f.pointer(close, 'pointerdown', 100, 130).defaultPrevented, false); close.click(); assert.equal(clicked, 1);
  const title = f.panel.querySelector('strong'); assert.equal(f.pointer(title, 'pointerdown', 80, 140).defaultPrevented, true);
  f.pointer(f.panel, 'pointermove', 280, 240); f.pointer(f.panel, 'pointerup', 280, 240);
  assert.equal(f.panel.style.left, '230px'); assert.equal(f.panel.style.top, '220px'); assert.equal(f.panel.querySelector('#draft').value, 'synthetic draft');
  f.pointer(title, 'pointerdown', 280, 240); f.pointer(f.panel, 'pointermove', -900, -900); f.pointer(f.panel, 'pointercancel', -900, -900);
  assert.equal(f.panel.style.left, '8px'); assert.equal(f.panel.style.top, '8px');
  await new Promise(r => setTimeout(r, 210)); assert.equal(writes.length, 1); assert.equal(writes[0][0], 'reader:floating-panel');
  f.api.dispose(); f.dom.window.close();
});

test('late saved geometry cannot overwrite a drag, and embedded forms are not a second floating window', { skip: !JSDOM }, async () => {
  let resolve; const f = fixture({ get: () => new Promise(r => resolve = r), put: async () => {} });
  assert.equal(f.w.PaperFloatingWindows.attach(f.panel.querySelector('#embedded')), null);
  f.pointer(f.panel.querySelector('strong'), 'pointerdown', 50, 140); f.pointer(f.panel, 'pointermove', 100, 180); f.pointer(f.panel, 'pointerup', 100, 180);
  resolve({ x: 800, y: 400, width: 200, height: 200 }); await new Promise(r => setImmediate(r));
  assert.equal(f.panel.style.left, '80px'); assert.equal(f.panel.style.top, '160px');
  f.api.dispose(); f.dom.window.close();
});

test('keyboard movement, redocking and fullscreen expansion preserve independent geometry', { skip: !JSDOM }, async () => {
  const f = fixture({ get: async () => null, put: async () => {} }); await f.api.restore();
  const grip = f.panel.querySelector('.paper-floating-grip'); grip.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(f.panel.style.left, '70px');
  f.panel.classList.add('is-expanded'); f.api.refresh(); assert.equal(f.panel.style.width, ''); assert.equal(grip.disabled, true);
  f.panel.classList.remove('is-expanded'); f.api.refresh(); assert.equal(f.panel.style.left, '70px');
  f.w.PaperFloatingWindows.reset(f.panel); assert.equal(f.panel.style.position, ''); assert.equal(f.panel.classList.contains('paper-floating-positioned'), false);
  f.api.dispose(); f.dom.window.close();
});
