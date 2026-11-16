import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../src/bridge.mjs';
import { createFetchHandler } from '../src/http.mjs';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'latex-citation-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'manuscript');
  await mkdir(root);
  const options = { library: join(folder, 'library'), localStateHome: join(folder, 'state'),
    python: fileURLToPath(new URL('../.venv/bin/python', import.meta.url)) };
  const author = [{ family: 'Ng', given: 'Sample' }];
  const paper = async (citekey, title, DOI) => dispatch({ action: 'create', metadata: {
    type: 'article-journal', citekey, title, author, DOI, 'container-title': 'Synthetic Journal',
    issued: { 'date-parts': [[2022]] },
  } }, options);
  const project = async main_path => (await dispatch({ action: 'latex_project_create', root, main_path }, options)).project;
  const handle = createFetchHandler(options);
  const call = async (action, fields) => {
    const request = new Request('http://localhost/api', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    const reply = await handle(request);
    const data = await reply.json();
    if (!data.ok) throw Error(data.error);
    return data.result;
  };
  function insert(project, paper, bibliography) {
    return call('latex_citation_insert', { id: project.id, expected_root: project.root,
      expected_binding_generation: project.binding_generation, paper_id: paper.id, citekey: paper.citekey, bibliography });
  }
  return { root, paper, project, call, insert };
}

test('catalog search and one-click citation use the bibliography declared from the nested main file', async t => {
  const f = await fixture(t), dir = join(f.root, 'draft');
  await mkdir(dir);
  await writeFile(join(dir, 'main.tex'), String.raw`\documentclass{article}
\input{preamble}
\begin{document}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`);
  await writeFile(join(dir, 'preamble.tex'), '% \\addbibresource{unrelated.bib}\n');
  const bibliography = join(dir, 'references.bib'), before = Buffer.from('% Keep this comment\r\n@book{original, title={Original title}}\r\n');
  await writeFile(bibliography, before);
  const article = await f.paper('Ng2022urban', 'Synthetic Urban Work', '10.5324/synthetic');
  const project = await f.project('draft/main.tex');
  assert.equal((await f.call('latex_citation_search', { query: 'Ng2022' })).items[0].id, article.id);
  assert.equal((await f.call('latex_citation_search', { query: 'Synthetic Urban' })).items[0].citekey, 'Ng2022urban');
  await assert.rejects(f.insert(project, { ...article, citekey: 'obsolete' }), /引用键已变化/);
  const first = await f.insert(project, article);
  assert.equal(first.path, 'draft/references.bib');
  assert.equal(first.added, true);
  const after = await readFile(bibliography);
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.match(after.toString(), /@article\{Ng2022urban,[\s\S]*\bjournal\s*=/i);
  assert.ok(!after.toString().replaceAll('\r\n', '').includes('\n'));
  assert.equal((await f.insert(project, article)).added, false);
  assert.deepEqual(await readFile(bibliography), after);
  assert.match(await readFile(join(dir, 'main.tex'), 'utf8'), /\\bibliography\{references\}/);
});

test('when the main file declares multiple BibLaTeX resources, choose a file and refuse a conflicting key', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'main.tex'), '\\addbibresource{first.bib}\n\\addbibresource{second.bib}\n');
  await writeFile(join(f.root, 'first.bib'), '@misc{Duplicate, title={Unrelated work}}\n');
  await writeFile(join(f.root, 'second.bib'), '');
  const project = await f.project('main.tex');
  const first = await f.paper('Unique', 'A new paper', '10.5324/unique');
  const collision = await f.paper('Duplicate', 'Completely different', '10.5324/duplicate');
  assert.deepEqual((await f.insert(project, first)).choices, ['first.bib', 'second.bib']);
  await assert.rejects(f.insert(project, first, 'other.bib'), /引用范围/);
  await assert.rejects(f.insert(project, collision, 'second.bib'), /重名/);
  const writes = await Promise.all([f.insert(project, first, 'second.bib'), f.insert(project, first, 'second.bib')]);
  assert.equal(writes.filter(row => row.added).length, 1);
  const content = await readFile(join(f.root, 'second.bib'), 'utf8');
  assert.equal(content.match(/@article\{Unique,/g).length, 1);
  assert.match(content, /journaltitle\s*=/i);
});

test('an unconfigured project gets its own local references file and a linking hint', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'main.tex'), '% \\addbibresource{never.bib}\n');
  const project = await f.project('main.tex');
  const result = await f.insert(project, await f.paper('LocalOnly', 'Synthetic fallback', '10.5324/fallback'));
  assert.deepEqual([result.path, result.resource, result.linked, result.created], ['references.bib', 'references.bib', false, true]);
  assert.equal(await readFile(join(f.root, 'main.tex'), 'utf8'), '% \\addbibresource{never.bib}\n');
});
