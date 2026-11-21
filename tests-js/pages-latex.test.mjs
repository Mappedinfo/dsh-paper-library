import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { core } from '../src/bridge.mjs';
import { handleLatex } from '../src/pages-latex.mjs';

const python = fileURLToPath(new URL(process.platform === 'win32'
  ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'pages-latex-'));
  const library = join(temp, 'library');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const context = {
    library, readJson: request => request.json(),
    run: (action, payload) => core({ ...payload, action }, { library, python }),
  };
  const call = async (operation, input) => {
    const request = new Request('http://127.0.0.1/api/pages/latex/' + operation, input === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    return (await handleLatex(request, context)).json();
  };
  return { temp, library, call, context };
}

test('LaTeX web routes share the DSH catalog and preserve concurrent source edits', async t => {
  const { library, call, context } = await fixture(t);
  assert.equal((await call('projects')).projects.length, 0);
  const { project } = await call('create', { title: '合成稿件' });
  assert.equal(dirname(project.root), await realpath(join(library, 'manuscripts')));
  const binding = { id: project.id, generation: project.binding_generation };
  assert.equal((await call('projects')).projects[0].id, project.id);
  const source = await call('read', { ...binding, path: 'main.tex' });
  const written = await call('write', { ...binding, path: 'main.tex', revision: source.revision, content: '合成新内容\n' });
  assert.notEqual(written.revision, source.revision);
  await assert.rejects(call('write', { ...binding, path: 'main.tex', revision: source.revision, content: '旧草稿' }),
    error => error.status === 409);
  await assert.rejects(call('write', { ...binding, path: 'main.tex', content: '没有修订号' }), /修订号/);
  await assert.rejects(call('read', { ...binding, path: '../main.tex' }), /相对/);
  assert.equal(await readFile(join(project.root, 'main.tex'), 'utf8'), '合成新内容\n');
  await call('write', { ...binding, path: 'notes.tex', revision: '', content: 'Notes' });
  assert.deepEqual((await call('tree', binding)).files, ['main.tex', 'notes.tex']);
  await assert.rejects(call('write', { ...binding, path: 'notes.tex', revision: '', content: '' }), error => error.status === 409);
  await context.run('latex_project_update', { id: project.id, main_path: 'notes.tex' });
  await assert.rejects(call('write', { ...binding, path: 'notes.tex', revision: written.revision, content: 'old' }), /绑定已变化/);
});

test('Projects cannot be created through a redirected manuscripts directory', { skip: process.platform === 'win32' }, async t => {
  const { temp, library, call } = await fixture(t);
  await mkdir(library);
  await symlink(temp, join(library, 'manuscripts'), 'dir');
  await assert.rejects(call('create', { title: 'Synthetic' }), /本地目录/);
});

test('An existing manuscript compiles locally and previews one page per request', async t => {
  try {
    await promisify(execFile)('latexmk', ['-v']);
    await promisify(execFile)('pdflatex', ['--version']);
  } catch { t.skip('本机未安装 latexmk 和 pdflatex'); return; }
  const { temp, call, context } = await fixture(t);
  const root = join(temp, 'synthetic-manuscript');
  await mkdir(root);
  await writeFile(join(root, '.latexmkrc'), 'warn "SYNTHETIC_CUSTOM_RC_LOADED";\n');
  await writeFile(join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nFirst page.\\newpage Second page.\n\\end{document}\n');
  const { project } = await context.run('latex_project_create', { root });
  const binding = { id: project.id, generation: project.binding_generation };
  assert.equal((await call('projects')).projects[0].id, project.id);
  const build = await call('compile', { ...binding, engine: 'pdflatex' });
  assert.equal(build.ok, true, build.log_tail);
  assert.doesNotMatch(build.log_tail, /SYNTHETIC_CUSTOM_RC_LOADED/);
  assert.match(build.command, /-no-shell-escape/);
  assert.equal(build.pages, 2);
  const preview = await call('preview', { ...binding, page: 2 });
  assert.deepEqual(Object.keys(preview).sort(), ['image', 'page', 'page_count']);
  assert.equal(preview.page, 2);
  assert.equal(preview.page_count, 2);
  assert.equal(Buffer.from(preview.image, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await assert.rejects(call('preview', { ...binding, page: 3 }), /页码/);
});
