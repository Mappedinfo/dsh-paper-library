// 仅在构建阶段读取锁定的包。PDF、映射表、备用字体和许可在同一 Pages 站点提供。
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const packageDir = (name, from = require) => dirname(from.resolve(name + '/package.json'));

export async function buildBrowserPdf(outDir) {
  const pdfjs = packageDir('pdfjs-dist'), lib = packageDir('pdf-lib');
  const assets = join(outDir, 'pdf-assets'), notices = join(assets, 'licenses');
  await mkdir(notices, { recursive: true });
  await build({ entryPoints: [join(root, 'site/library/pdf.js')], outfile: join(outDir, 'pdf.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, legalComments: 'inline',
    external: ['./pdf-assets/*'] });
  await cp(join(root, 'site/library/pdf.css'), join(outDir, 'pdf.css'));
  for (const file of ['pdf', 'pdf.worker']) await cp(join(pdfjs, 'legacy/build', file + '.min.mjs'), join(assets, file + '.mjs'));
  for (const dir of ['cmaps', 'standard_fonts', 'iccs']) await cp(join(pdfjs, dir), join(assets, dir), { recursive: true });
  // Only image/color decoders are used. The PDF document scripting sandbox is never loaded.
  await cp(join(pdfjs, 'wasm'), join(assets, 'wasm'), { recursive: true, filter: path => !/quickjs/i.test(basename(path)) });
  const libRequire = createRequire(join(lib, 'package.json'));
  const metrics = packageDir('@pdf-lib/standard-fonts', libRequire);
  const tslib = dirname(libRequire.resolve('tslib'));
  for (const [source, name] of [
    [join(root, 'licenses/browser-pdf/core-js-3.51.0.txt'), 'core-js-MIT.txt'],
    [join(pdfjs, 'LICENSE'), 'PDF.js-Apache-2.0.txt'], [join(lib, 'LICENSE.md'), 'pdf-lib-MIT.txt'],
    [join(metrics, 'LICENSE.md'), 'standard-fonts-MIT.txt'], [join(metrics, 'README.md'), 'standard-fonts-credits.md'],
    [join(packageDir('@pdf-lib/upng', libRequire), 'LICENSE'), 'UPNG-MIT.txt'],
    [join(packageDir('pako', libRequire), 'LICENSE'), 'pako-LICENSE.txt'],
    [join(tslib, 'LICENSE.txt'), 'tslib-LICENSE.txt'], [join(tslib, 'CopyrightNotice.txt'), 'tslib-CopyrightNotice.txt'],
  ]) await cp(source, join(notices, name));
  // pako 的 zlib 移植文件保留单独的上游声明；打包压缩后也提供原文。
  const zlib = await readFile(join(packageDir('pako', libRequire), 'lib/zlib/deflate.js'), 'utf8');
  const first = zlib.indexOf('// (C)'), last = zlib.indexOf('from any source distribution.');
  if (first < 0 || last < first) throw new Error('Missing pako zlib notice');
  await writeFile(join(notices, 'zlib-NOTICE.txt'), zlib.slice(first, last + 'from any source distribution.'.length) + '\n');
  await writeFile(join(assets, 'LICENSES.txt'), [
    'Paper Library · 浏览器 PDF 组件', '',
    'PDF.js — Mozilla Foundation, Apache-2.0. See licenses/PDF.js-Apache-2.0.txt.',
    'PDF.js compatibility code (core-js 3.51.0) — see licenses/core-js-MIT.txt.',
    'CMaps — see cmaps/LICENSE. Color profile — see iccs/LICENSE.',
    'Fallback PDF fonts — see standard_fonts/LICENSE_FOXIT and standard_fonts/LICENSE_LIBERATION.',
    'Image codecs and color management — see the individual wasm/LICENSE_* files.',
    'pdf-lib and bundled dependencies — see licenses/ (MIT, ISC and upstream notices).',
    'Source: https://github.com/mozilla/pdf.js and https://github.com/Hopding/pdf-lib.', '',
  ].join('\n'));
}
