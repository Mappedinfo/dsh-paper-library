/** Assemble the static whiteboard site for GitHub Pages.
 *
 * The board markup is extracted from the plugin's own `web/index.html` instead of being
 * copied, so the plugin page and the standalone page cannot drift: one edit updates both.
 * The shared canvas assets are copied verbatim, which is the point of keeping this site a
 * thin host around the same `web/board.js`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'id="board-stage"', 'id="board-tool-select"', 'id="board-tool-pan"', 'id="board-tool-text"', 'id="board-tool-note"',
  'id="board-tool-rect"', 'id="board-tool-ellipse"', 'id="board-tool-diamond"', 'id="board-select"', 'id="board-title"',
  'id="board-new"', 'id="board-delete"', 'id="board-tidy"', 'id="board-undo"', 'id="board-redo"', 'id="board-zoom-in"',
  'id="board-zoom-out"', 'id="board-zoom-label"', 'id="board-fit"', 'id="board-fullscreen"', 'id="board-status"',
  'id="board-conflict"', 'id="board-conflict-reload"', 'id="board-conflict-copy"', 'id="board-kind"', 'id="board-color"',
  'id="board-relation"', 'id="board-edge-label-input"', 'id="board-selection"',
];
for (const fragment of required) if (!markup.includes(fragment)) throw new Error(`The board section is missing ${fragment}`);
if (!markup.includes('id="board-add-paper"') || !markup.includes('id="board-send"')) throw new Error('The host-only controls disappeared; the standalone page still needs to hide them');

if (!template.includes('<!--BOARD_MARKUP-->')) throw new Error('site/index.html lost its BOARD_MARKUP placeholder');
const page = template.replace('<!--BOARD_MARKUP-->', markup);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, 'index.html'), page);
await writeFile(join(output, '.nojekyll'), '');
for (const asset of ['board.js', 'board.css', 'theme.css']) await cp(join(project, 'web', asset), join(output, asset));
await cp(join(project, 'site/standalone.js'), join(output, 'standalone.js'));

console.log(JSON.stringify({ output: '_site', markup_lines: markup.split('\n').length, assets: ['index.html', 'board.js', 'board.css', 'theme.css', 'standalone.js'] }));
