import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { collectTexInputs, compileDocument, saveCompiledPdf } from '../site/library/latex-compile.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const source = String.raw`\documentclass{article}
\usepackage{graphicx,mystyle}
\graphicspath{{figures/}}
\begin{document}
\mytitle\quad\cite{alpha}
\includegraphics[width=1cm]{dot}
\newpage\input{chapters/intro}
\bibliographystyle{plain}\bibliography{refs}
\end{document}`;
function project() {
  const contents = new Map(Object.entries({
    'sample/main.tex': source, 'sample/mystyle.sty': String.raw`\ProvidesPackage{mystyle}\newcommand{\mytitle}{Synthetic article}`,
    'sample/chapters/intro.tex': 'Second synthetic page.', 'sample/figures/dot.png': png,
    'sample/refs.bib': '@article{alpha, author={Example, Ada}, title={Synthetic bibliography}, journal={Synthetic Journal}, year={2020}}',
    'sample/private.tex': 'unreferenced file', 'other/main.tex': 'unrelated folder',
  }));
  return { list: async () => [...contents.keys()].map(path => ({ path })), read: async path => ({ blob: new Blob([contents.get(path)]) }) };
}

test('TeX sends only referenced source, styles, bibliography, and graphics into the compiler', async () => {
  const files = await collectTexInputs(project(), 'sample/main.tex', source + '\n% \\input{private}\n\\input{../other/main}');
  assert.deepEqual(Object.keys(files).sort(), ['chapters/intro.tex', 'figures/dot.png', 'mystyle.sty', 'refs.bib']);
  assert.deepEqual(Buffer.from(files['figures/dot.png']), png);
  await assert.rejects(collectTexInputs(project(), 'sample/main.tex', 'x'.repeat(1024 * 1024 + 1)), /1 MiB/);
  await assert.rejects(collectTexInputs(project(), 'sample/main.tex', String.raw`\includegraphics{fig.pdf}`), /PNG、JPEG/);
});

test('PDF overwrite uses the content revision before confirmation and preserves a concurrent edit', async () => {
  const blob = new Blob(['synthetic']);
  let version = 'digest-1', actual = null;
  const store = {
    list: async () => [{ path:'main.pdf', revision:'stat:123' }],
    read: async () => ({ revision:version }),
    write: async (path, data, expected) => {
      assert.equal(path, 'main.pdf'); assert.equal(data, blob);
      if (version !== expected) throw new Error('revision conflict');
      actual = expected;
    },
  };
  assert.equal(await saveCompiledPdf(store, 'main.pdf', blob, () => false), false);
  assert.equal(actual, null);
  assert.equal(await saveCompiledPdf(store, 'main.pdf', blob, () => true), true);
  assert.equal(actual, 'digest-1');
  await assert.rejects(saveCompiledPdf(store, 'main.pdf', blob, () => { version = 'digest-2'; return true; }), /conflict/);
  version = null;
  assert.equal(await saveCompiledPdf({ ...store, list:async () => [] }, 'main.pdf', blob, () => assert.fail()), true);
  assert.equal(actual, null);
});

const site = process.env.PAGES_ARTIFACT;
test('published TeX engines typeset multi-file graphics, BibTeX and Unicode Chinese from local assets', { skip:!site }, async () => {
  const base = resolve(site, 'library/tex-engine');
  const { MetaPost } = await import(pathToFileURL(resolve(base,'dist/index.js')));
  const tools = { MetaPost, fontBytes:async () => new Uint8Array(await readFile(resolve(base,'NotoSansSC-Regular.otf'))),
    bibStyle: name => readFile(resolve(base,'bibstyles',name + '.bst'),'utf8') };
  async function verify(input, pageCount, phrases) {
    const { pdf, log } = await compileDocument(input, tools).catch(error => { throw new Error(error.message + '\n' + error.log); });
    const doc = await PDFDocument.load(pdf, { updateMetadata:false });
    assert.equal(doc.getPageCount(), pageCount);
    assert.match(doc.getProducer(), /(?:Lua|pdf)TeX/i);
    assert.doesNotMatch(log, /undefined citations|Citation .* undefined/);
    const extracted = spawnSync('pdftotext',['-','-'],{input:pdf,encoding:'utf8'});
    if (extracted.error?.code === 'ENOENT') return;
    assert.equal(extracted.status, 0);
    for (const phrase of phrases) assert.ok(extracted.stdout.includes(phrase), extracted.stdout);
  }
  await verify({ source, files:await collectTexInputs(project(), 'sample/main.tex', source), engine:'latex' }, 2,
    ['Synthetic article', 'Second synthetic page', 'Synthetic bibliography']);
  await verify({ source:String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{NotoSansSC-Regular.otf}[Path=./]\begin{document}中文合成测试 Hello\end{document}`,
    files:{}, engine:'lualatex' }, 1, ['中文合成测试', 'Hello']);
  await assert.rejects(compileDocument({ source:String.raw`\documentclass{article}\usepackage{nonexistent}\begin{document}Bad\end{document}`, files:{}, engine:'latex' }, tools));
});
