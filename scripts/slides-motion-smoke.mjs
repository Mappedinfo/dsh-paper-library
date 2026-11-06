/** 合成动态 PPTX：node scripts/slides-motion-smoke.mjs [output-directory]
 * 不访问资料库、不调用模型。保留 JSON 便于通过真实 DSH 流程复用同一项目。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createDeckTemplate, assertDocument } from '../lib/plaindeck-core.mjs';
import { buildSlidesPptx } from '../src/slides-pptx.mjs';

const output = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'pd-motion-'));
await mkdir(output, { recursive: true });
const document = createDeckTemplate('blank', { title: 'PlainDeck 动态导出｜合成验收', lang: 'zh' });
const first = document.deck.slides[0], second = './slides/002-camera.json';
const heading = text => ({ type: 'text', id: 'title', text, fontSize: 50, frame: { x: 100, y: 80, w: 1400, h: 100 } });
document.slides[first].elements = [heading('六种入场动画，与镜头同时播放'),
  ...['fade', 'fade-up', 'fade-down', 'fade-left', 'fade-right', 'scale'].map((enter, i) => ({
    type: 'shape', id: enter, text: enter, shape: 'rounded-rectangle', radius: 18,
    fill: ['#CCE4DD', '#EBD6C3', '#CEDCEC'][i % 3], fontSize: 36,
    frame: { x: 120 + i % 3 * 480, y: 220 + Math.floor(i / 3) * 250, w: 400, h: 180 },
    animation: { enter, delayFrames: i * 15, durationFrames: 60 },
  })),
];
document.slides[first].motion = { camera: { fromScale: .85, toScale: 1.05, delayFrames: 60, durationFrames: 180 } };
const image = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#256356' } }).png().toBuffer();
const src = `data:image/png;base64,${image.toString('base64')}`;
document.deck.slides.push(second);
document.slides[second] = { id: 'camera-out', name: '镜头缩小与混合对象', background: { color: '#E4EBE8' },
  motion: { camera: { fromScale: 1.1, toScale: .9, delayFrames: 0, durationFrames: 180 } }, elements: [
    heading('镜头缩小：保留原生表格、文字和图片'),
    { type: 'table', id: 'table', cells: [['合成方案', '完成率'], ['A', '68%'], ['B', '92%']], headerRows: 1, style: 'grid', frame: { x: 100, y: 260, w: 760, h: 330 }, animation: { enter: 'fade-up', delayFrames: 30, durationFrames: 60 } },
    { type: 'image', id: 'image', src, alt: '合成色块', fit: 'contain', frame: { x: 1020, y: 280, w: 400, h: 250 }, animation: { enter: 'scale', delayFrames: 45, durationFrames: 45 } },
    { type: 'line', id: 'arrow', color: '#256356', strokeWidth: 5, arrowEnd: true, frame: { x: 880, y: 410, w: 110, h: 4 }, animation: { enter: 'fade-right', delayFrames: 30, durationFrames: 60 } },
    { type: 'text', id: 'note', text: '所有数据与图像均为合成示例。', fontSize: 32, frame: { x: 100, y: 700, w: 1400, h: 70 }, animation: { enter: 'fade', delayFrames: 60, durationFrames: 30 } },
  ] };
document.deck.footer = { left: { type: 'text', text: 'SYNTHETIC DEMO · 30 FPS' }, center: { type: 'none' }, right: { type: 'page-of-count' } };
const result = await buildSlidesPptx(assertDocument(document), async () => image);
await writeFile(join(output, 'document.json'), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(join(output, 'dynamic-demo.pptx'), result.bytes);
console.log(JSON.stringify({ output, slides: 2, bytes: result.bytes.length, warnings: result.warnings }, null, 2));
