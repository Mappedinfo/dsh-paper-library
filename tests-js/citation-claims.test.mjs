import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { createFetchHandler } from '../src/http.mjs'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { TOOL_SPECS, requestFromTool } from '../src/harness/tools.mjs'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let JSDOM
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')) } catch {}

async function post(handler, action, params = {}) {
  const response = await handler(new Request('http://127.0.0.1/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...params }),
  }))
  return { status: response.status, ...await response.json() }
}

function output(prompt, mode) {
  const batch = JSON.parse(prompt.split('\nDATA: ').at(-1))
  const context = batch.find(row => row.parts.some(part => part.text.includes('uses weighted matching')))
  if (!context) return JSON.stringify({ claims: [] })
  const part = context.parts.findIndex(part => part.text.includes('uses weighted matching'))
  const claim = { context_id: context.context_id, relation: 'uses', scope: 'individual',
    statement: 'Alpha uses weighted matching for city retrieval.', targets: [{ mention_id: context.mentions[0].mention_id, role: 'subject' }],
    methods: ['weighted matching'], tasks: ['city retrieval'], conditions: [], negated: false, hedged: false,
    evidence: [{ part, quote: 'uses weighted matching for city retrieval' }] }
  if (mode === 'quote') claim.evidence[0].quote = 'A fabricated passage.'
  if (mode === 'id') claim.targets[0].mention_id = 'foreign-mention'
  return JSON.stringify({ claims: [claim] })
}

test('HTTP and the program entry share extraction, immutable source evidence, deduplication and reverse queries', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'citation-claims-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const python = resolve('.venv/bin/python'), library = join(root, 'library'), localStateHome = join(root, 'state')
  const fixture = await exec(python, ['-B', '-c', `
import json,sys
from pathlib import Path
import pymupdf as fitz
from dsh_paper_library.core import Library
root=Path(sys.argv[1])
with fitz.open() as doc:
    doc.new_page().insert_text((40,55),'1 Introduction\\nAlpha [1] uses weighted matching for city retrieval.')
    doc.new_page().insert_text((40,55),'References\\n[1] Alice Example. Alpha model. 2024. doi:10.1234/synthetic-alpha.')
    doc.save(root/'paper.pdf')
library=Library(root/'library')
source=library.create({'title':'Synthetic citing work'})['id']
second=library.create({'title':'Another citing work'})['id']
target=library.create({'title':'Alpha work','DOI':'10.1234/synthetic-alpha'})['id']
library.attach(source,str(root/'paper.pdf'))
library.attach(second,str(root/'paper.pdf'))
print(json.dumps({'source':source,'second':second,'target':target}))
library.close()
`, root], { env: { ...process.env, PYTHONPATH: resolve('src') } })
  const { source, second, target } = JSON.parse(fixture.stdout)
  let calls = 0, mode = 'valid'
  const agent = async ({ prompt }) => { calls++; return output(prompt, mode) }
  agent.model = { provider: 'synthetic', model: 'fixture' }
  const analysis = await createHeadlessAnalysis({ library, python, localStateHome, agent })
  t.after(() => analysis.dispose())
  const handler = createFetchHandler({ library, python, localStateHome, citationClaims: analysis, loopbackOnly: true })
  const read = await post(handler, 'citation_context_candidates', { id: source })
  assert.equal(read.status, 200)
  assert.equal(read.result.targets[0].paper_id, target)
  assert.equal(calls, 0)
  assert.equal((await post(handler, 'citation_claim_commit', { id: source })).status, 403)
  const saved = await post(handler, 'citation_claim_extract', { id: source })
  assert.equal(saved.status, 200, saved.error)
  assert.equal(saved.result.count, 1)
  assert.equal((await post(handler, 'citation_claim_extract', { id: source })).result.reused, true)
  assert.equal(calls, 1)
  assert.equal((await analysis({ action: 'citation_claim_extract', id: second })).count, 1)
  const tool = TOOL_SPECS.find(spec => spec.name === 'library_citation_claim_search')
  const query = requestFromTool(tool, { target_id: target, method: 'weighted', task: 'city', limit: 1, ignored: 'x' }, {})
  const reverse = await analysis(query)
  assert.equal(reverse.total, 2)
  assert.equal(reverse.next_offset, 1)
  const secondPage = await analysis({ ...query, offset: reverse.next_offset })
  assert.deepEqual(new Set([reverse.items[0].source.id, secondPage.items[0].source.id]), new Set([source, second]))
  assert.equal(reverse.items[0].evidence[0].page, 1)
  assert.equal(reverse.items[0].targets[0].paper_id, target)
  assert.equal(reverse.items[0].review_status, 'needs-review')
  mode = 'id'
  const foreign = await post(handler, 'citation_claim_extract', { id: source, force: true })
  assert.equal(foreign.status, 502)
  mode = 'quote'
  const forged = await post(handler, 'citation_claim_extract', { id: source, force: true })
  assert.match(forged.error, /精确/)
  const status = await analysis({ action: 'citation_claim_status', id: source })
  assert.equal(status.runs[0].revision, saved.result.revision)
})

test('graph can look up incoming descriptions on B and open A at the evidence page', { skip: !JSDOM }, async t => {
  const dom = new JSDOM('<div id="graph"></div>', { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom, root = window.document.getElementById('graph')
  window.eval(await readFile(new URL('../web/knowledge-graph.js', import.meta.url), 'utf8'))
  const calls = [], opened = []
  const claim = { id: 'claim-1', relation: 'limitation', scope: 'individual', statement: 'Beta may require more data.', conditions: ['Under the low-data setting'],
    source: { id: 'a', title: 'Citing paper A', status: 'current' }, source_version: { sha256: 'a'.repeat(64) },
    targets: [{ id: 'entry-1', node_id: 'b', paper_id: 'b', label: 'Cited paper B', role: 'subject', binding: 'doi' }],
    evidence: [{ page: 3, text: 'Beta may require more data in this setting.' }] }
  const reader = window.PaperKnowledgeGraph.create({ root, getPaper: () => ({ id: 'b', pdf: true }), navigatePaper: (...args) => opened.push(args),
    api: async (action, input) => {
      calls.push([action, JSON.parse(JSON.stringify(input))])
      if (action === 'citation_claim_status') return { runs: [] }
      if (action === 'citation_claim_search') return { total: input.target_id ? 1 : 0, next_offset: null, items: input.target_id ? [claim] : [] }
      return { nodes: [], edges: [] }
    } })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await reader.load()
  assert.ok(!calls.some(([action]) => action === 'citation_claim_extract'))
  const mode = root.querySelector('[data-kg="mode"]'); mode.value = 'citation-claims'; mode.dispatchEvent(new window.Event('change'))
  await tick()
  const direction = root.querySelector('[aria-label="引用描述方向"]'); direction.value = 'incoming'; direction.dispatchEvent(new window.Event('change'))
  await tick()
  assert.equal(calls.at(-1)[1].target_id, 'b')
  assert.equal(root.querySelectorAll('.kg-node').length, 3)
  assert.equal(root.querySelectorAll('.kg-edge').length, 2)
  const panel = root.querySelector('[aria-label="引用描述与原文"]')
  assert.match(panel.textContent, /Beta may require more data/)
  const button = [...panel.querySelectorAll('button')].find(item => item.textContent === '打开来源 PDF 第 3 页')
  button.click()
  assert.deepEqual(opened, [['a', 3]])
})
