import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import Color from 'colorjs.io';
import sharp from 'sharp';
import {
  PLACEHOLDER_IMAGE_SRC, footerPresentation, resolveSlideBackground, shapeLabelStyle,
  tableCellStyle, tableColumnWidths, tableContentStyle, textContentStyle,
} from '../lib/plaindeck-core.mjs';

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MiB = 1024 * 1024;
const clean = value => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/gu, '\ufffd');
const exportError = (message, status = 422) => Object.assign(new Error(message), { code: 'SLIDES_PPTX_EXPORT', status });
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const eastAsianFace = /PingFang|Songti|Heiti|Kaiti|Hiragino|Noto.*(?:CJK|SC|TC|JP|KR)|Source (?:Han|Han Sans)|Microsoft YaHei|SimSun|DengXian|Yu (?:Gothic|Mincho)|Meiryo|Malgun|[\p{Script=Han}\p{Script=Hangul}]/iu;
function fontFace(value, text = '') {
  const fonts = value.split(',').map(font => font.trim().replace(/^['"]|['"]$/g, ''));
  if (!eastAsian.test(text)) return fonts[0] || 'Arial';
  // DrawingML uses one face per script. Choose an East Asian face from the
  // source stack instead of repeating the first Latin-only face.
  const supplied = fonts.find(font => eastAsianFace.test(font));
  if (supplied) return supplied;
  if (process.platform === 'darwin') return 'PingFang SC';
  if (process.platform === 'win32') return 'Microsoft YaHei';
  return 'Noto Sans CJK SC';
}
const transparency = opacity => Math.round((1 - opacity) * 100);

function paint(value, opacity, fallback, warnings) {
  // Standalone files have no CSS variables. Use an explicit fallback when present.
  const variable = /^var\(--[\w-]+(?:,\s*([^)]*))?\)$/i.exec(value);
  let color;
  try { color = new Color(variable ? variable[1] : value); }
  catch {
    warnings.add('color_fallback');
    color = new Color(fallback);
  }
  const [r, g, b] = color.to('srgb').toGamut({ method: 'clip' }).coords;
  const hex = [r, g, b].map(channel => Math.round((channel ?? 0) * 255).toString(16).padStart(2, '0')).join('');
  return { color: hex.toUpperCase(), transparency: transparency((color.alpha ?? 1) * opacity) };
}

async function picture(src, readAsset, warnings) {
  try {
    if (src === PLACEHOLDER_IMAGE_SRC) {
      const bytes = await sharp(Buffer.from(decodeURIComponent(src.split(',')[1]))).png().toBuffer();
      return { bytes, format: 'png', width: 1200, height: 800 };
    }
    const bytes = await readAsset(src);
    const image = sharp(bytes, { limitInputPixels: 16_000_000 });
    const { width, height, pageHeight, format, orientation, pages } = await image.metadata();
    const frameHeight = pageHeight || height;
    if (!width || !frameHeight || width * frameHeight > 16_000_000) {
      throw exportError('PPTX 导出图片单帧最多 1600 万像素。', 413);
    }
    if (format === 'webp' || (orientation && orientation > 1)) {
      if (pages > 1) warnings.add('image_first_frame');
      const { data, info } = await image.autoOrient().png().toBuffer({ resolveWithObject: true });
      return { bytes: data, format: 'png', width: info.width, height: info.height };
    }
    return { bytes, format, width, height: frameHeight };
  } catch (error) {
    if (error.status) throw error;
    throw exportError('无法读取 PPTX 使用的图片。请检查项目素材是否存在且可解码。');
  }
}

/** Convert a validated managed snapshot. readAsset supplies bytes only from that project. */
export async function buildSlidesPptx(document, readAsset, { signal } = {}) {
  const { deck, theme } = document;
  const { width, height } = deck.canvas;
  const scale = (40 / 3) / Math.max(width, height);
  const inches = pixels => pixels * scale;
  const points = pixels => Math.max(-1584, Math.min(1584, inches(pixels) * 72));
  const fontSize = pixels => Math.min(400, Math.max(1, points(pixels)));
  // Use percentages for frames: PptxGenJS treats numeric values >=100 as EMUs.
  const frameOf = ({ x, y, w, h }) => ({ x: `${x / width * 100}%`, y: `${y / height * 100}%`, w: `${w / width * 100}%`, h: `${h / height * 100}%` });
  const pptx = new PptxGenJS();
  if (inches(Math.min(width, height)) < 1) throw exportError('PPTX 导出要求画布长边不超过短边的 13.33 倍。');
  pptx.defineLayout({ name: 'PlainDeck', width: inches(width), height: inches(height) });
  pptx.layout = 'PlainDeck';
  pptx.title = clean(deck.title);

  const warnings = new Set();
  const colors = new Map();
  const color = (value, opacity = 1, fallback = '#000000') => {
    const key = `${value}|${opacity}|${fallback}`;
    if (!colors.has(key)) colors.set(key, paint(value, opacity, fallback, warnings));
    return colors.get(key);
  };
  const textStyle = (style, opacity, text) => ({
    fontFace: fontFace(style.fontFamily, text), fontSize: fontSize(style.fontSize), bold: style.fontWeight >= 700,
    align: style.textAlign, margin: points(style.padding ?? 0), ...color(style.color, opacity),
  });
  const pictures = new Map();
  let imageBudget = 32 * MiB;
  let cellBudget = 20000;

  for (const path of deck.slides) {
    signal?.throwIfAborted();
    const source = document.slides[path];
    const slide = pptx.addSlide();
    slide.background = color(resolveSlideBackground(document, path), 1, '#FFFFFF');
    if (source.motion?.camera) warnings.add('static_motion');

    for (const element of [...source.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
      signal?.throwIfAborted();
      const opacity = element.opacity ?? 1;
      if (opacity === 0) continue;
      if (element.animation?.enter && element.animation.enter !== 'none') warnings.add('static_motion');
      const rotate = ((element.rotation ?? 0) % 360 + 360) % 360;
      const frame = { ...frameOf(element.frame), rotate, objectName: clean(element.id) };

      if (element.type === 'text') {
        // Bound the source size before the browser's fit helper searches for
        // a whole pixel size. Very large numbers cannot be incremented by 1.
        const defaultSize = element.styleRef === 'slide-title' ? theme.fontSizes.title : theme.fontSizes.body;
        const bounded = { ...element, fontSize: Math.min(element.fontSize ?? defaultSize, 400 / (scale * 72)) };
        const style = textContentStyle(bounded, theme);
        slide.addText(clean(element.text), {
          ...frame, ...textStyle(style, opacity, element.text), valign: element.verticalAlign ?? 'top',
          lineSpacing: points(style.fontSize * style.lineHeight), charSpacing: points(style.letterSpacing ?? 0),
        });
      } else if (element.type === 'shape') {
        const { radius, stroke, strokeWidth, fill } = element;
        const rounded = radius > 0;
        const shape = element.shape === 'ellipse' ? pptx.ShapeType.ellipse : rounded ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
        const options = {
          ...frame, fill: color(fill, opacity),
          line: stroke && strokeWidth ? { ...color(stroke, opacity), width: points(strokeWidth) } : { color: 'FFFFFF', transparency: 100 },
          ...(shape === pptx.ShapeType.roundRect && { rectRadius: inches(Math.min(radius, element.frame.w / 2, element.frame.h / 2)) }),
        };
        if (element.text) {
          const style = shapeLabelStyle(element, theme);
          slide.addText(clean(element.text), { ...options, shape, ...textStyle(style, opacity, element.text), valign: element.verticalAlign ?? 'middle', lineSpacing: points(style.fontSize * style.lineHeight) });
        } else slide.addShape(shape, options);
      } else if (element.type === 'line') {
        slide.addShape(pptx.ShapeType.line, {
          ...frame, ...frameOf({ ...element.frame, y: element.frame.y + element.frame.h / 2, h: 0 }),
          line: { ...color(element.color, opacity), width: points(element.strokeWidth), ...(element.dash && { dashType: 'dash' }), ...(element.arrowEnd && { endArrowType: 'triangle' }) },
        });
      } else if (element.type === 'image') {
        if (element.src === 'placeholder:image') {
          slide.addText('IMAGE', { ...frame, align: 'center', valign: 'middle', color: '8A9088', line: { color: '8A9088', dashType: 'dash' } });
          continue;
        }
        if (!pictures.has(element.src)) {
          const { bytes, format, width, height } = await picture(element.src, readAsset, warnings);
          pictures.set(element.src, { size: bytes.length, data: `image/${format};base64,${bytes.toString('base64')}`, width, height });
        }
        const image = pictures.get(element.src);
        imageBudget -= image.size;
        if (imageBudget < 0) throw exportError('PPTX 导出的图片总量超过 32 MiB。', 413);
        const { x, y, w, h } = element.frame;
        const ratio = Math.min(w / image.width, h / image.height);
        const fittedW = image.width * ratio, fittedH = image.height * ratio;
        const sizing = element.fit === 'contain' ? frameOf({ x: x + (w - fittedW) / 2, y: y + (h - fittedH) / 2, w: fittedW, h: fittedH })
          : element.fit === 'cover' ? { ...frameOf({ x, y, w: fittedW, h: fittedH }), sizing: { type: 'cover', w: inches(w), h: inches(h) } }
            : {};
        slide.addImage({ ...frame, ...sizing, data: image.data, altText: clean(element.alt ?? 'PlainDeck image'), transparency: transparency(opacity) });
      } else if (element.type === 'table') {
        cellBudget -= element.cells.length * element.cells[0].length;
        if (cellBudget < 0) throw exportError('PPTX 导出最多支持 20,000 个表格单元格。', 413);
        if (rotate) warnings.add('table_rotation');
        const style = tableContentStyle(element, theme);
        const ruleWidth = element.ruleWidth ?? 2;
        const rule = { type: 'solid', pt: points(ruleWidth), ...color(element.ruleColor ?? theme.colors.muted) };
        const accent = { type: 'solid', pt: points(ruleWidth * 1.5), ...color(element.accentColor ?? theme.colors.accent) };
        const none = { type: 'none' };
        const rows = element.cells.map((row, rowIndex) => row.map((text, columnIndex) => {
          const cell = tableCellStyle(element, theme, rowIndex, columnIndex);
          const top = rowIndex === 0 ? accent : none;
          const left = element.highlightRows?.includes(rowIndex) && columnIndex === 0 ? accent : none;
          const bottom = rowIndex === element.headerRows - 1 ? accent : rowIndex === element.cells.length - 1
            ? { ...rule, pt: points(ruleWidth * 1.5) } : { ...rule, pt: points(Math.max(1, ruleWidth * 0.5)) };
          const fill = color(cell.background, opacity);
          return { text: clean(text), options: {
            align: cell.textAlign, bold: cell.fontWeight >= 700, fontFace: fontFace(style.fontFamily, text), ...color(cell.color, opacity),
            ...(fill.transparency < 100 && { fill }), border: element.style === 'grid' ? rule : [top, none, bottom, left],
          } };
        }));
        const padding = points(element.cellPadding ?? 18);
        slide.addTable(rows, {
          ...frame, autoPage: false, fontFace: fontFace(style.fontFamily), fontSize: fontSize(style.fontSize), valign: 'middle',
          // PptxGenJS interprets table margins below one as inches.
          margin: padding < 1 ? padding / 72 : padding,
          rowH: inches(element.frame.h) / rows.length,
          colW: tableColumnWidths(element).map(pct => inches(element.frame.w) * parseFloat(pct) / 100),
        });
      }
    }
    const footer = footerPresentation(document, path);
    if (footer) {
      const { left, right, bottom, gap, fontSize: px } = footer.style;
      const w = (width - left - right - gap * 2) / 3;
      if (w <= 0) warnings.add('footer_space');
      else footer.values.forEach((value, index) => {
        if (!value) return;
        const position = { x: left + index * (w + gap), y: height - bottom - px, w, h: px };
        slide.addText(clean(value), { ...frameOf(position), ...textStyle(footer.style, 1, value), align: ['left', 'center', 'right'][index], valign: 'middle' });
      });
    }
  }
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  // PptxGenJS numbers tables separately from the other objects. PowerPoint
  // requires unique shape IDs within each slide, including native tables.
  for (let index = 1; index <= deck.slides.length; index++) {
    signal?.throwIfAborted();
    const path = `ppt/slides/slide${index}.xml`;
    let shapeId = 0;
    const xml = await zip.file(path).async('string');
    zip.file(path, xml.replace(/<p:cNvPr id="\d+"/g, () => `<p:cNvPr id="${++shapeId}"`));
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  signal?.throwIfAborted();
  if (bytes.length > 40 * MiB) throw exportError('PPTX 文件超过 40 MiB。', 413);
  return { bytes, warnings: [...warnings] };
}
