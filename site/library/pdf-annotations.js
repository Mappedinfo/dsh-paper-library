import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';

export const maxPdfBytes = 64 * 1024 * 1024;
export const markNames = { Highlight: '高亮', Underline: '下划线', StrikeOut: '删除线', Square: '矩形框', Text: '便笺' };
export const webAuthor = 'Paper Library (Web)';
const key = PDFName.of;
const textOf = value => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
const ownerPrefix = 'paper-library-web:';

function pageArray(page) {
  const { context } = page.doc;
  let array = page.node.lookupMaybe(key('Annots'), PDFArray);
  if (!array) {
    array = context.obj([]);
    page.node.set(key('Annots'), array);
  }
  return array;
}
function findMark(doc, page, id) {
  const list = pageArray(page);
  for (const ref of list.asArray()) {
    if (!(ref instanceof PDFRef) || ref.objectNumber + 'R' + (ref.generationNumber || '') !== id) continue;
    const dict = doc.context.lookup(ref, PDFDict);
    if (textOf(dict.get(key('NM'))).startsWith(ownerPrefix) && textOf(dict.get(key('T'))) === webAuthor) return dict;
  }
  throw new Error('这条批注已变化，请重新打开 PDF。');
}

function coordinates(quads) {
  if (!Array.isArray(quads) || !quads.length || quads.length > 200 ||
      !quads.every(q => Array.isArray(q) && q.length === 8 && q.every(n => Number.isFinite(n) && Math.abs(n) < 1e8))) {
    throw new Error('请选择本页的文字或区域。');
  }
  const values = quads.flat(), xs = [], ys = [];
  for (let i = 0; i < values.length; i += 2) { xs.push(values[i]); ys.push(values[i + 1]); }
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (box[2] <= box[0] || box[3] <= box[1]) throw new Error('标记区域太小。');
  return box;
}

// An explicit appearance stream keeps the mark visible when printed or opened in another viewer.
function appearance(doc, type, box, quads) {
  const ctx = doc.context, w = box[2] - box[0], h = box[3] - box[1];
  const num = n => Number(n.toFixed(4)).toString();
  const point = (q, i) => num(q[i] - box[0]) + ' ' + num(q[i + 1] - box[1]);
  const commands = ['q'];
  const resources = {};
  if (type === 'Highlight') {
    resources.ExtGState = { GS: { Type: 'ExtGState', BM: 'Multiply', ca: 0.48 } };
    commands.push('/GS gs', '1 0.85 0.12 rg');
    for (const q of quads) commands.push(point(q, 0) + ' m ' + point(q, 2) + ' l ' + point(q, 6) + ' l ' + point(q, 4) + ' l h f');
  } else if (type === 'Text') {
    commands.push('1 0.86 0.25 rg', '0.36 0.27 0.08 RG 1 w', '0.5 0.5 ' + num(Math.max(1, w - 1)) + ' ' + num(Math.max(1, h - 1)) + ' re B');
    for (const y of [.35, .6]) commands.push(num(w * .2) + ' ' + num(h * y) + ' m ' + num(w * .8) + ' ' + num(h * y) + ' l S');
  } else {
    commands.push('0.05 0.43 0.36 RG 1.2 w');
    for (const q of quads) {
      if (type === 'Square') commands.push(point(q, 0) + ' m ' + point(q, 2) + ' l ' + point(q, 6) + ' l ' + point(q, 4) + ' l h S');
      else {
        const ratio = type === 'Underline' ? .90 : .50;
        const line = [0,1,2,3].map(i => q[i] + (q[i + 4] - q[i]) * ratio);
        commands.push(point(line, 0) + ' m ' + point(line, 2) + ' l S');
      }
    }
  }
  commands.push('Q');
  return ctx.register(ctx.flateStream(commands.join('\n'), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: resources,
  }));
}

export async function writeNativeMark(blob, { pageNumber, type, quads, note, annotationId }) {
  if (blob.size > maxPdfBytes || !Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('PDF 或页码超出处理范围。');
  if (typeof note !== 'string' || note.length > 10000) throw new Error('批注备注最多 10,000 字。');
  const doc = await PDFDocument.load(await blob.arrayBuffer(), { updateMetadata: false });
  if (doc.context.enumerateIndirectObjects().some(([, obj]) => obj instanceof PDFDict && obj.has(key('ByteRange')))) {
    throw new Error('此 PDF 包含数字签名；修改会使签名失效，请选择未签名的副本。');
  }
  const page = doc.getPage(pageNumber - 1);
  const { context } = doc;
  let dict, id = annotationId;
  if (id) dict = findMark(doc, page, id);
  else {
    if (!Object.hasOwn(markNames, type)) throw new Error('不支持的批注类型。');
    const box = coordinates(quads);
    const date = PDFString.fromDate(new Date());
    dict = context.obj({
      Type: 'Annot', Subtype: type, P: page.ref, Rect: box, T: PDFHexString.fromText(webAuthor),
      NM: PDFString.of(ownerPrefix + crypto.randomUUID()), CreationDate: date, F: 4,
      C: type === 'Highlight' || type === 'Text' ? [1, .85, .12] : [.05, .43, .36],
      AP: { N: appearance(doc, type, box, quads) },
    });
    if (['Highlight', 'Underline', 'StrikeOut'].includes(type)) dict.set(key('QuadPoints'), context.obj(quads.flat()));
    if (type === 'Text') dict.set(key('Name'), key('Note'));
    const ref = context.register(dict);
    pageArray(page).push(ref);
    id = ref.objectNumber + 'R' + (ref.generationNumber || '');
  }
  dict.set(key('Contents'), PDFHexString.fromText(note));
  dict.set(key('M'), PDFString.fromDate(new Date()));
  const bytes = await doc.save({ updateFieldAppearances: false });
  if (bytes.byteLength > maxPdfBytes) throw new Error('批注后的 PDF 超过 64 MiB，未替换原文件。');
  const checked = await PDFDocument.load(bytes, { updateMetadata: false });
  const saved = findMark(checked, checked.getPage(pageNumber - 1), id);
  if (textOf(saved.get(key('Contents'))) !== note) throw new Error('批注写回核验失败。');
  return { blob: new Blob([bytes], { type: 'application/pdf' }), id };
}
