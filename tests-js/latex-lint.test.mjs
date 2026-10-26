/** Real bridge/worker/CLI, synthetic dual manuscripts and no model calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../src/bridge.mjs'
import { LATEX_TOOL_SPECS, latexToolRequest } from '../src/harness/latex-tools.mjs'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const python = join(cwd, '.venv', 'bin', 'python')

test('lint crosses the read tool, bridge, worker and CLI without modifying manuscripts', async t => {
  const base = await mkdtemp(join(tmpdir(), 'latex-lint-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'manuscript'), library = join(base, 'library')
  await mkdir(root)
  const draft = '\\documentclass{article}\n\\begin{document}\nDraft TODO, xxxx.\\bibliography{refs}\n\\end{document}\n'
  const formal = '\\documentclass{article}\n\\begin{document}\nAI evidence.\\bibliography{refs}\n\\end{document}\n'
  await writeFile(join(root, 'draft.tex'), draft)
  await writeFile(join(root, 'formal.tex'), formal)
  await writeFile(join(root, 'refs.bib'), '@article{synthetic,title={Evidence},author={Example, A.}}\n')
  const { project } = await dispatch({ action: 'latex_project_create', root, main_path: 'draft.tex' }, { library, python })
  const read = LATEX_TOOL_SPECS.find(s => s.name === 'library_latex')
  const request = latexToolRequest(read, { operation: 'lint', input_json: JSON.stringify({ id: project.id }) })
  const editing = await dispatch(request, { library, python })
  assert.equal(editing.ok, true)
  assert.equal(editing.counts.warn, 2)
  assert.equal(editing.counts.submission_blocker, 0)
  assert.equal(editing.submission_ready, false)
  const blocked = await dispatch({ ...request, mode: 'submission' }, { library, python })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'failed')

  const cli = payload => {
    const child = spawnSync(process.execPath, ['src/cli.mjs', '--library', library, '--python', python], { cwd, input: JSON.stringify(payload), encoding: 'utf8' })
    assert.equal(child.stderr, '')
    return { exit: child.status, ...JSON.parse(child.stdout) }
  }
  const warnings = cli(request)
  assert.equal(warnings.exit, 0)
  assert.equal(warnings.ok, true)
  const failed = cli({ ...request, mode: 'submission' })
  assert.equal(failed.exit, 1)
  assert.equal(failed.ok, false)
  assert.equal(failed.result.counts.submission_blocker, 2)
  const passed = cli({ ...request, mode: 'submission', main_path: 'formal.tex' })
  assert.equal(passed.exit, 0)
  assert.equal(passed.result.submission_ready, true)
  assert.deepEqual(passed.result.files.map(f => f.path), ['formal.tex', 'refs.bib'])
  assert.equal(JSON.stringify(passed).includes(base), false)
  assert.equal(await readFile(join(root, 'draft.tex'), 'utf8'), draft)
  assert.equal(await readFile(join(root, 'formal.tex'), 'utf8'), formal)
  assert.equal((await dispatch({ action: 'latex_project_get', id: project.id }, { library, python })).project.main_path, 'draft.tex')

  // Placeholder checks do not become a save gate.
  const readDraft = await dispatch({ action: 'latex_read', id: project.id }, { library, python })
  const saved = await dispatch({ action: 'latex_write', id: project.id, path: 'draft.tex', content: draft + '% todo later\n', expected_revision: readDraft.revision }, { library, python })
  assert.equal(saved.changed, true)
})
