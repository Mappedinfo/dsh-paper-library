import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readPaperVisual, paperVisualOutput } from '../src/harness/paper-visual.mjs'
import { registerLibraryTools } from '../src/harness/tools.mjs'
import { resolveConfig } from '../src/harness/config.mjs'
import { core } from '../src/bridge.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(process.env.DSH_CHECKOUT ?? join(repo, '../../deepseek-ai/deepseek-harness'))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const value = { paper_id: 'synthetic', page: 1, width: 1, height: 1, mime_type: 'image/png', image: png }
const request = { action: 'paper_visual_read', id: 'synthetic', page: 1 }
const makeExec = () => ({ signal: new AbortController().signal, agent: { options: { provider: 'visual', model: 'test' } } })
const services = (modalities = ['text', 'image']) => ({
  llm: { resolveModelInfo: async () => ({ inputModalities: modalities }) },
  attachments: { imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 2097152, maxMessageImageBytes: 2097152 }, saveImage: async () => ({ attachmentId: 'durable', mediaType: 'image/png' }) },
})

test('visual tool returns an attachment block; base64 never becomes model text', async () => {
  const s = services()
  const result = await readPaperVisual({ get: key => s[key] }, makeExec(), request, async () => value, {})
  const blocks = paperVisualOutput.render(request, result)
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'durable')
  assert.ok(!blocks[0].text.includes(png))
})

test('current request route wins and text-only routes fail before PDF rendering', async () => {
  const s = services(), exec = makeExec()
  exec.agent.session = { requestHeader: () => ({ config: { provider: 'text', model: 'only' } }) }
  s.llm.resolveModelInfo = async (provider, model) => {
    assert.equal(provider, 'text'); assert.equal(model, 'only')
    return { inputModalities: ['text'] }
  }
  await assert.rejects(readPaperVisual({ get: key => s[key] }, exec, request, () => assert.fail('must not render'), {}), { code: 'PAPER_IMAGE_MODEL_UNSUPPORTED' })
  await assert.rejects(readPaperVisual({ get: key => s[key] }, { signal: exec.signal }, request, () => assert.fail(), {}), { code: 'PAPER_IMAGE_ROUTE_REQUIRED' })
  delete s.attachments
  s.llm.resolveModelInfo = async () => ({ inputModalities: ['image'] })
  await assert.rejects(readPaperVisual({ get: key => s[key] }, makeExec(), request, () => assert.fail(), {}), { code: 'PAPER_IMAGE_SERVICE_REQUIRED' })
})

test('invalid results, attachment budget and cancellation do not commit attachments', async () => {
  const s = services(), ctx = { get: key => s[key] }
  s.attachments.saveImage = () => assert.fail('must not save')
  for (const patch of [{ paper_id: 'wrong' }, { page: 2 }, { image: 'invalid' }, { width: 2049 }]) {
    await assert.rejects(readPaperVisual(ctx, makeExec(), request, async () => ({ ...value, ...patch }), {}), { code: 'PAPER_IMAGE_INVALID' })
  }
  s.attachments.imageLimits.maxImageBytes = 50
  await assert.rejects(readPaperVisual(ctx, makeExec(), request, async () => value, {}), { code: 'PAPER_IMAGE_INVALID' })
  const controller = new AbortController(), exec = { ...makeExec(), signal: controller.signal }
  await assert.rejects(readPaperVisual(ctx, exec, request, async () => { controller.abort(new Error('cancelled')); return value }, {}), /cancelled/)
})

test('actual Harness runtime stores and returns a rendered image-only PDF table', { skip: !existsSync(join(root, 'packages/attachment/attachment-local/lib/index.js')) && 'Requires built DSH_CHECKOUT' }, async () => {
  const load = relative => import(pathToFileURL(join(root, relative)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
  const { default: ToolRuntime, defineTool } = await load('packages/core/tools/lib/index.js')
  const { default: LocalAttachmentStore } = await load('packages/attachment/attachment-local/lib/index.js')
  const { default: LlmRuntime, LlmAdapter, ToolCallId } = await load('packages/llm/llm/lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'paper-visual-'))
  const ctx = new Context()
  let dispose
  try {
    const { stdout } = await promisify(execFile)(join(repo, '.venv/bin/python'), ['-c', `
import sys, json, pathlib, pymupdf as fitz
from dsh_paper_library.core import Library
root = pathlib.Path(sys.argv[1])
with fitz.open() as table:
    p = table.new_page(width=400, height=200)
    p.insert_text((40,60), 'Area | 42', fontsize=24)
    p.draw_rect(fitz.Rect(20,20,380,100), color=(0,0,1))
    image = p.get_pixmap().tobytes('png')
with fitz.open() as pdf:
    p = pdf.new_page(width=400, height=200)
    p.insert_image(p.rect, stream=image)
    pdf.save(root / 'synthetic.pdf')
library = Library(root / 'library')
paper = library.create({'title': 'Synthetic image-only table'})
library.attach(paper['id'], str(root / 'synthetic.pdf'))
print(json.dumps({'id': paper['id']}))
library.close()
`, home], { env: { ...process.env, PYTHONPATH: join(repo, 'src') } })
    const { id } = JSON.parse(stdout)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    if (existsSync(join(root, 'packages/core/tool-executor-native/lib/index.js'))) await ctx.plugin(await load('packages/core/tool-executor-native/lib/index.js'))
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    await ctx.plugin(LlmRuntime)
    class Adapter extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
      async listModels() { return [{ id: 'test', name: 'test', inputModalities: ['text', 'image'] }] }
      async * stream() { throw new Error('No remote model calls in synthetic fixture') }
    }
    ctx.llm.registerAdapter(['visual'], new Adapter())
    const config = resolveConfig({ library: join(home, 'library'), requireToolApproval: false })
    const options = { library: config.library, python: join(repo, '.venv/bin/python') }
    dispose = registerLibraryTools(ctx, defineTool, core, options, config)
    const text = await core({ action: 'paper_text_read', id, pages: [1] }, options)
    assert.equal(text.pages[0].no_extractable_text, true)
    const result = (await ctx.tools.execute({ ...makeExec(), calls: [{ type: 'tool-call', id: ToolCallId('synthetic-view'), name: 'library_paper_view', arguments: JSON.stringify({ id, page: 1, max_edge: 1024, expected_version: text.source_version }) }] })).results[0].result
    assert.equal(result.isError, false, JSON.stringify(result))
    const block = result.content.find(item => item.type === 'image')
    assert.ok(block?.attachment?.attachmentId, JSON.stringify(result))
    const stored = await ctx.attachments.readImage(block.attachment)
    assert.ok(stored.data.length > 1000)
    assert.ok(block.attachment.width <= 1024)
    assert.ok(Math.abs(block.attachment.width - block.attachment.height * 2) <= 1)
    const source = JSON.parse(result.content.find(item => item.type === 'text').text)
    assert.equal(source.source_kind, 'pdf-page-image')
    assert.equal(source.page, 1)
    assert.equal(source.annotations_included, false)
    assert.equal(source.image, undefined)
  } finally {
    dispose?.()
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
