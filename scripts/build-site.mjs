/** Assemble the browser library, whiteboard and documentation for GitHub Pages.
 *
 * The board markup is extracted from the plugin's own `web/index.html` instead of being
 * copied, so the plugin page and the standalone page cannot drift: one edit updates both.
 * The shared canvas assets are copied verbatim, which is the point of keeping this site a
 * thin host around the same `web/board.js`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { buildBrowserPdf } from './build-browser-pdf.mjs';
import { buildBrowserTex } from './build-browser-tex.mjs';
import { buildPaperFlow } from './build-paper-flow.mjs';
import { buildDocsSite } from './build-docs-site.mjs';

await buildPaperFlow();
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(project, '_site');
const shell = await readFile(join(project, 'web/index.html'), 'utf8');
const template = await readFile(join(project, 'site/index.html'), 'utf8');

const start = shell.indexOf('  <section id="board-view"');
if (start < 0) throw new Error('The plugin page no longer contains the board section');
const end = shell.indexOf('\n  </section>', start);
if (end < 0) throw new Error('The board section is not closed as expected');
const markup = shell.slice(start, end + '\n  </section>'.length);

// A missing control would silently produce a half-working drawing page, so fail the build.
const required = [
  'id="board-flow-view"', 'id="board-flow-open"', 'id="board-stage"', 'id="board-tool-select"', 'id="board-tool-pan"', 'id="board-tool-text"', 'id="board-tool-note"',
  'id="board-tool-rect"', 'id="board-tool-ellipse"', 'id="board-tool-diamond"', 'id="board-select"', 'id="board-title"',
  'id="board-new"', 'id="board-delete"', 'id="board-tidy"', 'id="board-undo"', 'id="board-redo"', 'id="board-zoom-in"',
  'id="board-zoom-out"', 'id="board-zoom-label"', 'id="board-fit"', 'id="board-fullscreen"', 'id="board-status"',
  'id="board-conflict"', 'id="board-conflict-reload"', 'id="board-conflict-copy"', 'id="board-kind"', 'id="board-color"',
  'id="board-relation"', 'id="board-edge-label-input"', 'id="board-selection"', 'id="board-tool-connect"', 'id="board-edge-kind"', 'id="board-edge-arrow"', 'id="board-edge-dashed"',
  'id="board-layout-mode"', 'id="board-layout-direction"', 'id="board-layout-gap-x"', 'id="board-layout-gap-y"', 'id="board-layout-apply"',
  'id="board-layout-pin"', 'id="board-layout-unpin"', 'id="board-layout-status"', 'id="board-source-open"', 'id="board-source-dialog"',
  'id="board-source-content"', 'id="board-source-style"', 'id="board-source-apply"', 'id="board-source-download"', 'id="board-source-upload"', 'id="board-source-file"',
];
for (const fragment of required) if (!markup.includes(fragment)) throw new Error(`The board section is missing ${fragment}`);
if (!markup.includes('id="board-add-paper"') || !markup.includes('id="board-send"')) throw new Error('The host-only controls disappeared; the standalone page still needs to hide them');

if (!template.includes('<!--BOARD_MARKUP-->')) throw new Error('site/index.html lost its BOARD_MARKUP placeholder');
const page = template.replace('<!--BOARD_MARKUP-->', markup);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, 'board.html'), page);
await cp(join(project, 'site/home.html'), join(output, 'index.html'));
await cp(join(project, 'site/home.js'), join(output, 'home.js'));
await writeFile(join(output, '.nojekyll'), '');
for (const asset of ['board.js', 'board-flow.js', 'board-source.js', 'board-render.js', 'board-bridge.js', 'board-annotations.js', 'board-annotations.css', 'board-mermaid.js', 'board-drawio.js', 'board.css', 'theme.css', 'floating-windows.js', 'floating-windows.css']) await cp(join(project, 'web', asset), join(output, asset));
for (const asset of ['paper-flow-editor.js', 'paper-flow-editor.css']) await cp(join(project, 'lib', asset), join(output, asset));
await cp(join(project, 'site/standalone.js'), join(output, 'standalone.js'));
// 发布清单只含网页程序。文献、稿件以及用户选定的文件夹不会参与构建。
const library = join(output, 'library');
await mkdir(library);
const libraryAssets = ['index.html', 'app.js', 'library.css', 'storage.js', 'assistant.js', 'licenses.html'];
for (const name of libraryAssets) await cp(join(project, 'site/library', name), join(library, name));
await esbuild({ entryPoints: [join(project, 'site/library/archive.js')], outfile: join(library, 'archive.js'), bundle: true, format: 'esm', platform: 'browser' });
await cp(join(project, 'node_modules/client-zip/LICENSE.txt'), join(library, 'client-zip-LICENSE.txt'));
await buildBrowserPdf(library);
await buildBrowserTex(library);
await mkdir(join(output, 'licenses/paper-flow'), { recursive: true });
await cp(join(project, 'LICENSE'), join(output, 'licenses/project-MIT.txt'));
await cp(join(project, 'vendor/paper-flow/README.md'), join(output, 'licenses/paper-flow/README.txt'));
for (const name of ['DAGRE-LICENSE.txt', 'GRAPHLIB-LICENSE.txt', 'MATHJAX-LICENSE.txt']) await cp(join(project, 'vendor/paper-flow/core', name), join(output, 'licenses/paper-flow', name));
for (const name of ['react-LICENSE.txt', 'react-dom-LICENSE.txt']) await cp(join(project, 'licenses/slides', name), join(output, 'licenses/paper-flow', name));
await cp(join(project, 'node_modules/scheduler/LICENSE'), join(output, 'licenses/paper-flow/scheduler-LICENSE.txt'));
await cp(join(project, 'licenses/markdown/dompurify-LICENSE.txt'), join(output, 'licenses/paper-flow/dompurify-LICENSE.txt'));
await cp(join(project, 'site/boards'), join(output, 'boards'), { recursive: true });

const docs = await buildDocsSite({ outDir: output });
console.log(JSON.stringify({ output: '_site', docs, library: 'library/', board: 'board.html', markup_lines: markup.split('\n').length }));
