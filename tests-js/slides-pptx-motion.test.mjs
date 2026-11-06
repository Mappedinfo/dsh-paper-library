import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createDeckTemplate, assertDocument } from '../lib/plaindeck-core.mjs';
import { buildSlidesPptx } from '../src/slides-pptx.mjs';

const documentWith = (elements, camera) => {
  const d = createDeckTemplate('blank', { title: 'Synthetic motion' });
  d.slides[d.deck.slides[0]].elements = elements;
  if (camera) d.slides[d.deck.slides[0]].motion = { camera };
  return assertDocument(d);
};
const text = (id, enter = 'none', extras = {}) => ({ type: 'text', id, text: id, frame: { x: 100, y: 200, w: 400, h: 100 }, animation: { enter, delayFrames: 15, durationFrames: 30 }, ...extras });
const exportXml = async document => {
  const snapshot = JSON.stringify(document);
  const result = await buildSlidesPptx(document, () => assert.fail('Unexpected asset read'));
  assert.equal(JSON.stringify(document), snapshot, 'export must not change the source');
  assert.deepEqual(result.warnings, []);
  const zip = await JSZip.loadAsync(result.bytes);
  return zip.file('ppt/slides/slide1.xml').async('string');
};
const shapeId = (xml, name) => Number(new RegExp(`<p:cNvPr id="(\\d+)" name="${name}"`).exec(xml)?.[1]);
function tracks(xml, id) {
  return [...xml.matchAll(/<p:anim\b[^>]*>[\s\S]*?<\/p:anim>/g)].filter(m => m[0].includes(`spid="${id}"`)).map(m => ({
    property: /<p:attrName>(.*?)<\/p:attrName>/.exec(m[0])[1],
    duration: Number(/dur="(\d+)"/.exec(m[0])[1]),
    keys: [...m[0].matchAll(/<p:tav tm="(\d+)"><p:val><p:fltVal val="([^"]+)"/g)].map(k => ({ time: Number(k[1]), value: Number(k[2]) })),
  }));
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);

test('all six entrances retain their delay, duration, direction, scale and independent targets', async () => {
  const kinds = ['fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'scale'];
  const xml = await exportXml(documentWith(kinds.map(k => text(k, k))));
  assert.equal((xml.match(/<p:animEffect transition="in" filter="fade">/g) || []).length, 6);
  assert.equal((xml.match(/<p:cond delay="500"/g) || []).length, 11);
  for (const kind of kinds) {
    const id = shapeId(xml, kind), t = tracks(xml, id);
    assert.ok(id);
    for (const track of t) {
      assert.equal(track.duration, 1000);
      assert.equal(track.keys[0].time, 0); assert.equal(track.keys.at(-1).time, 100000);
      assert.ok(track.keys.every((k, i) => !i || k.time > track.keys[i - 1].time));
    }
    if (kind === 'fade') assert.equal(t.length, 0);
    else if (kind === 'scale') {
      assert.deepEqual(t.map(t => t.property), ['ppt_w', 'ppt_h']);
      close(t[0].keys[0].value, 400 / 1600 * .94); close(t[0].keys.at(-1).value, 400 / 1600);
    } else {
      assert.equal(t.length, 1);
      const y = kind === 'fade-up' || kind === 'fade-down';
      const sign = kind === 'fade-up' || kind === 'fade-left' ? 1 : -1;
      assert.equal(t[0].property, y ? 'ppt_y' : 'ppt_x');
      close(t[0].keys[0].value - t[0].keys.at(-1).value, sign * 34 / (y ? 900 : 1600));
    }
  }
  const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('camera and entrance compose in one geometric track, including background and footer', async () => {
  const doc = documentWith([text('entry', 'scale')], { fromScale: .8, toScale: 1.2, delayFrames: 30, durationFrames: 90 });
  doc.deck.footer = { left: { type: 'text', text: 'Synthetic footer' }, center: { type: 'none' }, right: { type: 'none' } };
  const xml = await exportXml(doc), t = tracks(xml, shapeId(xml, 'entry'));
  assert.doesNotMatch(xml, /<p:grpSp>/, 'nested group animation freezes children in some players');
  assert.equal(t.length, 4);
  close(t.find(t => t.property === 'ppt_x').keys[0].value, .5 + (300 / 1600 - .5) * .8);
  close(t.find(t => t.property === 'ppt_y').keys.at(-1).value, .5 + (250 / 900 - .5) * 1.2);
  const width = t.find(t => t.property === 'ppt_w');
  close(width.keys[0].value, 400 / 1600 * .8 * .94);
  close(width.keys.at(-1).value, 400 / 1600 * 1.2);
  assert.equal(width.duration, 4000);
  assert.ok(width.keys.some(k => k.time === 12500), 'entrance delay boundary');
  assert.ok(width.keys.some(k => k.time === 25000), 'camera delay boundary');
  assert.ok(width.keys.some(k => k.time === 37500), 'entrance end boundary');
  const bg = shapeId(xml, 'PlainDeck camera background');
  assert.equal(Number(/<p:spTgt spid="(\d+)"/.exec(xml)[1]), bg, 'animated background must stay beneath content');
  close(tracks(xml, bg).find(t => t.property === 'ppt_w').keys[0].value, .8);
  close(tracks(xml, bg).find(t => t.property === 'ppt_w').keys.at(-1).value, 1.2);
  assert.equal((xml.match(/<p:anim calcmode=/g) || []).length, 12, 'element, footer and background each have four tracks');
});

test('renumbered text, table, line and placeholder picture IDs survive z-order and hidden objects', async () => {
  const elements = [
    text('hidden', 'fade', { opacity: 0 }),
    text('text', 'fade', { zIndex: 3, rotation: 30 }),
    { type: 'table', id: 'table', cells: [['Synthetic']], frame: { x: 200, y: 200, w: 300, h: 100 }, animation: { enter: 'fade-up' } },
    { type: 'line', id: 'line', frame: { x: 200, y: 400, w: 200, h: 10 }, animation: { enter: 'scale' } },
    { type: 'image', id: 'picture', src: 'placeholder:image', frame: { x: 200, y: 600, w: 200, h: 100 }, animation: { enter: 'fade' } },
  ];
  const xml = await exportXml(documentWith(elements, { fromScale: 1.2, toScale: .9 }));
  assert.doesNotMatch(xml, /name="hidden"/); assert.match(xml, /<a:tbl>/);
  const ids = new Set([...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m => m[1]));
  for (const target of xml.matchAll(/<p:spTgt spid="(\d+)"/g)) assert.ok(ids.has(target[1]));
  for (const name of ['text', 'table', 'picture']) assert.equal(tracks(xml, shapeId(xml, name)).length, 4);
  assert.deepEqual(tracks(xml, shapeId(xml, 'line')).map(t => t.property), ['ppt_x', 'ppt_y', 'ppt_w']);
});

test('static slides remain static; unsupported timing/scale fails explicitly', async () => {
  assert.doesNotMatch(await exportXml(documentWith([text('static')])), /<p:timing>/);
  for (const doc of [
    documentWith([text('too-long', 'fade', { animation: { enter: 'fade', durationFrames: Number.MAX_SAFE_INTEGER } })]),
    documentWith([], { fromScale: 1, toScale: 1e20 }),
  ]) await assert.rejects(exportXml(doc), { code: 'SLIDES_PPTX_EXPORT', status: 422 });
});

test('PowerPoint-native timing hierarchy and distinct effect builds survive camera plus entrance', async () => {
  const xml = await exportXml(documentWith([text('entry', 'fade')], { fromScale: .8, toScale: 1.2 }));
  // 与 PowerPoint 16.113.3 原生创建的 with-previous 淡入时间轴对照。
  // 缺少延迟分组时 PowerPoint 会把各 behavior 当作独立效果；
  // 相同对象复用 grpId 会把入场和镜头合并，破坏动画窗格与对象模型。
  assert.match(xml, /<p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"\/><p:cond evt="onBegin" delay="0"><p:tn val="2"\/><\/p:cond><\/p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold">/);
  const builds = [...xml.matchAll(/<p:bldP spid="(\d+)" grpId="(\d+)"\/>/g)];
  const effects = [...xml.matchAll(/<p:cTn[^>]+presetID="[^>]+grpId="(\d+)"[^>]*>/g)];
  assert.equal(effects.length, 3, 'background camera, entrance and element camera');
  assert.equal(builds.length, effects.length);
  assert.equal(new Set(builds.map(m => `${m[1]}:${m[2]}`)).size, builds.length);
  assert.deepEqual(effects.map(m => m[1]), builds.map(m => m[2]));
  assert.equal(builds.filter(m => Number(m[1]) === shapeId(xml, 'entry')).length, 2);
  const ids = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(ids, ids.map((_, i) => i + 1));
});
