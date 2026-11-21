import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, degrees } from 'pdf-lib';
import { writeNativeMark } from '../site/library/pdf-annotations.js';

const quad = [30,90,70,90,30,78,70,78];
async function fixture(signed = false) {
  const doc = await PDFDocument.create(), page = doc.addPage([220, 180]), ctx = doc.context;
  page.setRotation(degrees(90));
  const original = ctx.register(ctx.obj({
    Type:'Annot',Subtype:'Text',Rect:[12,85,28,101],Contents:PDFHexString.fromText('第三方备注'),T:PDFString.of('External'),
  }));
  page.node.set(PDFName.of('Annots'), ctx.obj([original]));
  if (signed) doc.catalog.set(PDFName.of('Perms'), ctx.register(ctx.obj({Type:'Sig',ByteRange:[0,10,20,30]})));
  return { original: original.objectNumber + 'R', blob: new Blob([await doc.save()], { type:'application/pdf' }) };
}
test('browser PDF annotations survive reload, retain third-party objects and preserve page rotation', async () => {
  const { blob, original } = await fixture();
  const originalBytes = new Uint8Array(await blob.arrayBuffer());
  let current = blob;
  for (const type of ['Highlight', 'Underline', 'StrikeOut', 'Square', 'Text']) {
    const saved = await writeNativeMark(current, { pageNumber:1, type, quads:[quad], note:'初稿' });
    const edit = await writeNativeMark(saved.blob, { pageNumber:1, annotationId:saved.id, note:type + ' 中文备注' });
    assert.equal(edit.id, saved.id);
    current = edit.blob;
  }
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), originalBytes);
  const result = await PDFDocument.load(await current.arrayBuffer()), page = result.getPage(0);
  assert.equal(page.getRotation().angle, 90);
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  assert.equal(annots.size(), 6);
  for (let index=0; index<annots.size(); index++) {
    const annot = annots.lookup(index, PDFDict), value = key => annot.lookup(PDFName.of(key));
    if (!index) { assert.equal(value('Contents').decodeText(), '第三方备注'); continue; }
    const type = value('Subtype').decodeText();
    assert.equal(value('Contents').decodeText(), type + ' 中文备注');
    assert.ok(value('AP').lookup(PDFName.of('N')));
    if (['Highlight','Underline','StrikeOut'].includes(type)) assert.deepEqual(value('QuadPoints').asArray().map(n => n.asNumber()), quad);
  }
  await assert.rejects(writeNativeMark(current,{ pageNumber:1,annotationId:original,note:'replacement' }), /已变化/);
});
test('read-only signed PDF and invalid selections abort before writing', async () => {
  const { blob } = await fixture(true), args = { pageNumber:1, type:'Highlight', quads:[quad], note:'test' };
  await assert.rejects(writeNativeMark(blob,args), /数字签名/);
  await assert.rejects(writeNativeMark((await fixture()).blob,{...args,quads:[[0,0]]}), /请选择/);
});
