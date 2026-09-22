#!/usr/bin/env node
/**
 * Our own MCP server: the whiteboard's readable files, over stdio.
 *
 * Why this exists. The official draw.io MCP server (`jgraph/drawio-mcp`, Apache-2.0) exposes a
 * `.drawio` file to a model through `list_pages` / `get_page` / `set_page` / `search_shapes`, and
 * our board now reads and writes that format. This server is the same idea applied to what this
 * project owns: the **readable** board source document (`paper-library-board.v1`) plus its style
 * sidecar, validated by the app's own validators and convertible to and from `.drawio`. A model
 * talking to us therefore gets the same file-level surface draw.io offers, with the extra checks
 * this project insists on — the file is validated before it is written, and what cannot be
 * represented is reported instead of guessed.
 *
 * Boundaries, deliberately narrow:
 *   - stdio only; no listener, no network, no model, no worker.
 *   - No new dependency: JSON-RPC is spoken directly, `.drawio` compression uses `node:zlib`.
 *   - Every path must sit under a root passed on the command line (`--root`, repeatable) and must
 *     have an allowed extension. A path outside the roots is refused, not resolved.
 *   - Read-only unless `--write` is given; the write tools are then listed and nothing else changes.
 *   - Writes are revision-checked and atomic (temp file + rename). An existing file is never
 *     overwritten without its current revision.
 *
 * Usage:
 *   node mcp/server.mjs --root <dir> [--root <dir> ...] [--write]
 *
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0 (initialize, tools/list, tools/call).
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import vm from 'node:vm'

import { renderBoardOutline, validateBoard, BOARD_LIMITS } from '../src/harness/board-store.mjs'
// The library side reuses the plugin's own transport to its Python worker: one bounded,
// serialized path to the same authority the app reads, instead of a second reader of the
// private catalog.
import { core } from '../src/bridge.mjs'

const VERSION = '0.1.0'
const SERVER_NAME = 'paper-library-board-mcp'
const PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])
const LIMITS = Object.freeze({ scanFiles: 2000, scanDepth: 3, listing: 200, text: 4 * 1024 * 1024 })
const BOARD_EXTENSIONS = Object.freeze(['.json'])
const DRAWIO_EXTENSIONS = Object.freeze(['.drawio', '.xml'])

/** The app's own browser modules, run in a bare realm so the server validates exactly what the
 *  whiteboard validates instead of keeping a second copy of the rules. Both are plain scripts that
 *  attach themselves to `window`, which is all this needs to supply. */
function loadBrowserModule(path) {
  const context = vm.createContext({ window: {} })
  vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path })
  return context.window
}
const here = dirname(fileURLToPath(import.meta.url))
const boardSource = loadBrowserModule(join(here, '../web/board-source.js')).PaperBoardSource
const drawioCodec = loadBrowserModule(join(here, '../web/board-drawio.js')).PaperBoardDrawio

/** Host-side half of draw.io's compressed page: base64 → raw DEFLATE → percent-decoded XML. */
const inflate = base64 => decodeURIComponent(inflateRawSync(Buffer.from(String(base64).trim(), 'base64')).toString('utf8'))

// ── arguments ──────────────────────────────────────────────────────────────────────────────────
function parseArguments(argv) {
  const roots = []
  let write = false
  let library = null
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--root') {
      const value = argv[++index]
      if (!value) throw new Error('--root 需要一个目录。')
      roots.push(value)
    } else if (argument === '--library') {
      library = argv[++index]
      if (!library) throw new Error('--library 需要文献库目录。')
    } else if (argument === '--write') write = true
    else if (argument === '--help' || argument === '-h') return { help: true }
    else if (argument === '--version') return { version: true }
    else throw new Error(`无法识别的参数 ${argument}。`)
  }
  if (!roots.length && !library) throw new Error('至少需要一个 --root（画板文件）或 --library（文献库）。')
  return { roots, write, library }
}

const USAGE = `用法：node mcp/server.mjs [--root <目录> ...] [--library <目录>] [--write]

  --root     允许访问的目录（画板源文件与 .drawio），可重复；所有路径都必须落在其中。
  --library  文献库目录；给出后增加三个**只读**文献工具。写入文献库不在本服务器范围内。
  --write    打开写工具（写 board.json / .drawio）。默认只读。
  --version  打印版本。
  --help     打印这段说明。`

const sha256 = value => createHash('sha256').update(value).digest('hex')

// ── path confinement ───────────────────────────────────────────────────────────────────────────
function pathError(message) { const error = new Error(message); error.code = 'E_PATH'; return error }

const within = (path, roots) => roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))

/**
 * Resolve one requested path inside the roots, in two steps, because either alone is escapable:
 * the parent directory is resolved through `realpath` (so `..` and a symlinked *directory* cannot
 * step outside), and an existing file is resolved through `realpath` too (so a symlinked *file*
 * cannot point out of a root either). A file that does not exist yet is checked lexically, which is
 * all a new file can be. An external directory belongs in another `--root`, not behind a link.
 */
async function confinedPath(requested, extensions, roots, { mustExist }) {
  if (typeof requested !== 'string' || !requested.trim()) throw pathError('需要一个文件路径。')
  const absolute = resolve(requested)
  const extension = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
  if (!extensions.includes(extension)) throw pathError(`只接受这些扩展名：${extensions.join('、')}（收到 ${extension || '无扩展名'}）。`)
  if (Buffer.byteLength(absolute) > 4096) throw pathError('路径过长。')
  let parent
  try { parent = await realpath(dirname(absolute)) } catch { throw pathError(`目录不存在：${dirname(absolute)}。`) }
  const target = join(parent, basename(absolute))
  if (!within(target, roots)) throw pathError(`这个路径不在允许的目录里：${target}`)
  let exists = false
  let path = target
  try {
    const resolved = await realpath(target)
    exists = (await stat(resolved)).isFile()
    path = resolved
  } catch { exists = false }
  if (exists && !within(path, roots)) throw pathError(`这个路径不在允许的目录里（链接指向 ${path}）。`)
  if (mustExist && !exists) throw pathError(`文件不存在：${target}`)
  return { path, exists, root: roots.find(root => within(target, [root])) }
}

/** Write through a temp file in the same directory, so a reader never sees a half-written file. */
async function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, 'utf8')
  try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

const readText = async path => {
  const info = await stat(path)
  if (info.size > LIMITS.text) throw pathError(`文件超过 ${Math.round(LIMITS.text / 1024 / 1024)} MiB，本服务器不读。`)
  return readFile(path, 'utf8')
}

// ── board files ────────────────────────────────────────────────────────────────────────────────
/** The sidecar that belongs to a source document: `board.json` → `board.style.json`. */
const stylePathFor = path => path.endsWith('.json') ? `${path.slice(0, -'.json'.length)}.style.json` : `${path}.style.json`

const isBoardSource = value => Boolean(value) && typeof value === 'object' && value.schema === boardSource.SOURCE_SCHEMA

/** Validate a source document + sidecar through the app's own rules, then through the host's. */
function validateSourceAndStyle(source, style) {
  const converted = boardSource.fromSource(source, style ?? {})
  const board = validateBoard({ ...converted.board, id: 'b-mcp' })
  return { board, converted }
}

async function scanBoards(roots) {
  const found = []
  const skipped = []
  for (const root of roots) {
    const walk = async (directory, depth) => {
      if (found.length >= LIMITS.listing || depth > LIMITS.scanDepth) return
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (found.length >= LIMITS.listing) return
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await walk(path, depth + 1); continue }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        if (entry.name.endsWith('.style.json')) continue
        let parsed
        try { parsed = JSON.parse(await readText(path)) } catch { continue }
        if (!isBoardSource(parsed)) { skipped.push({ path: relative(root, path) || basename(path), reason: '不是 paper-library-board.v1 源文件' }); continue }
        const stylePath = stylePathFor(path)
        let stylePresent = false
        try { stylePresent = (await stat(stylePath)).isFile() } catch { stylePresent = false }
        found.push({
          path, style_path: stylePath, style_present: stylePresent,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
          edges: Array.isArray(parsed.edges) ? parsed.edges.length : 0,
        })
      }
    }
    await walk(root, 0)
  }
  return { boards: found, skipped }
}

// ── tools ──────────────────────────────────────────────────────────────────────────────────────
function tools({ write }) {
  const list = [
    {
      name: 'list_boards',
      description: '列出允许目录里的画板源文件（paper-library-board.v1）及其样式辅助文件。只读。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const scanned = await scanBoards(ROOTS)
        const lines = scanned.boards.map(board => `${board.path}｜${board.title || '未命名'}｜${board.nodes} 节点／${board.edges} 连线｜样式${board.style_present ? '有' : '无'}`)
        return {
          text: [`画板 ${scanned.boards.length} 个（跳过 ${scanned.skipped.length} 个不相关的 JSON）。`, ...lines].join('\n'),
          data: { boards: scanned.boards, skipped: scanned.skipped },
        }
      },
    },
    {
      name: 'read_board',
      description: '读取一个画板源文件与它的样式辅助文件，按应用自身的规则校验，并给出压缩大纲。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'board.json 的路径，必须位于允许目录内' },
          outline: { type: 'boolean', description: '是否附带给模型看的大纲文本，默认 true' },
        },
        required: ['path'], additionalProperties: false,
      },
      run: async args => {
        const target = await confinedPath(args.path, BOARD_EXTENSIONS, ROOTS, { mustExist: true })
        const source = JSON.parse(await readText(target.path))
        if (!isBoardSource(source)) throw pathError('这不是 paper-library-board.v1 源文件。')
        const stylePath = stylePathFor(target.path)
        let style = {}
        try { style = JSON.parse(await readText(stylePath)) } catch { style = {} }
        const { board } = validateSourceAndStyle(source, style)
        const wantsOutline = args.outline !== false
        const outline = wantsOutline ? renderBoardOutline(board).text : ''
        const revision = sha256(await readText(target.path))
        return {
          text: `已校验：${board.nodes.length} 个节点、${board.edges.length} 条连线${wantsOutline ? `\n\n${outline}` : ''}`,
          data: { path: target.path, style_path: stylePath, revision, counts: { nodes: board.nodes.length, edges: board.edges.length }, outline },
        }
      },
    },
    {
      name: 'read_drawio',
      description: '把一个 .drawio / mxGraph XML 文件读成画板源文件与样式（draw.io 自己保存的压缩页会先解压）。无法表达的部分逐条报告。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.drawio 或 .xml 的路径，必须位于允许目录内' },
          page: { type: 'string', description: '页序号（从 0 开始）或页名，默认第一页' },
        },
        required: ['path'], additionalProperties: false,
      },
      run: async args => {
        const target = await confinedPath(args.path, DRAWIO_EXTENSIONS, ROOTS, { mustExist: true })
        const options = { inflate }
        if (args.page !== undefined && args.page !== '') options.page = /^\d+$/.test(String(args.page)) ? Number(args.page) : String(args.page)
        const parsed = await drawioCodec.parse(await readText(target.path), options)
        // Imported files must be files the app accepts, so the conversion runs here too.
        const { board } = validateSourceAndStyle(parsed.source, parsed.style)
        const notes = parsed.warnings.length ? `\n无法表达或已跳过：\n${parsed.warnings.map(line => `- ${line}`).join('\n')}` : ''
        return {
          text: `已读取 ${parsed.counts.pages} 页中的 1 页：${board.nodes.length} 个节点、${board.edges.length} 条连线。${notes}`,
          data: { source: parsed.source, style: parsed.style, warnings: parsed.warnings, pages: parsed.pages, counts: parsed.counts },
        }
      },
    },
  ]
  if (LIBRARY) list.push(...libraryTools())
  if (!write) return list
  list.push(
    {
      name: 'write_board',
      description: '写入画板源文件与样式辅助文件。先按应用规则校验，再按修订号做原子替换；文件已存在时必须给出当前修订号。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'board.json 的路径，必须位于允许目录内' },
          source: { type: 'object', description: 'paper-library-board.v1 源文件' },
          style: { type: 'object', description: '样式辅助文件，可省略' },
          expected_revision: { type: ['string', 'null'], description: '文件当前内容的 sha256；新建时给 null' },
        },
        required: ['path', 'source', 'expected_revision'], additionalProperties: false,
      },
      run: async args => {
        const target = await confinedPath(args.path, BOARD_EXTENSIONS, ROOTS, { mustExist: false })
        const { board } = validateSourceAndStyle(args.source, args.style)
        const current = target.exists ? sha256(await readText(target.path)) : null
        if (current !== (args.expected_revision ?? null)) {
          throw pathError(`修订号不匹配：文件当前是 ${current ?? '（不存在，请传 null）'}，收到 ${args.expected_revision ?? 'null'}。`)
        }
        const content = `${JSON.stringify(args.source, null, 2)}\n`
        const stylePath = stylePathFor(target.path)
        const styleContent = `${JSON.stringify(args.style ?? {}, null, 2)}\n`
        await atomicWrite(target.path, content)
        await atomicWrite(stylePath, styleContent)
        return {
          text: `已写入 ${board.nodes.length} 个节点、${board.edges.length} 条连线。`,
          data: { path: target.path, style_path: stylePath, revision: sha256(content) },
        }
      },
    },
    {
      name: 'write_drawio',
      description: '把画板源文件写成 .drawio（未压缩、可读、可 diff）。文件已存在时必须给出当前修订号。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.drawio 的路径，必须位于允许目录内' },
          source: { type: 'object', description: 'paper-library-board.v1 源文件' },
          style: { type: 'object', description: '样式辅助文件，可省略' },
          title: { type: 'string', description: '图页标题，默认取源文件标题' },
          expected_revision: { type: ['string', 'null'], description: '文件当前内容的 sha256；新建时给 null' },
        },
        required: ['path', 'source', 'expected_revision'], additionalProperties: false,
      },
      run: async args => {
        const target = await confinedPath(args.path, DRAWIO_EXTENSIONS, ROOTS, { mustExist: false })
        const { board } = validateSourceAndStyle(args.source, args.style)
        const current = target.exists ? sha256(await readText(target.path)) : null
        if (current !== (args.expected_revision ?? null)) {
          throw pathError(`修订号不匹配：文件当前是 ${current ?? '（不存在，请传 null）'}，收到 ${args.expected_revision ?? 'null'}。`)
        }
        const written = drawioCodec.toDrawio({ ...board, title: args.title ?? board.title })
        await atomicWrite(target.path, written.xml)
        return {
          text: `已写出 ${written.counts.nodes} 个节点、${written.counts.edges} 条连线到 ${target.path}。`,
          data: { path: target.path, revision: sha256(written.xml), counts: written.counts, bounds: written.bounds },
        }
      },
    },
  )
  return list
}

/** Read-only library tools, backed by the plugin's own worker transport. */
function libraryTools() {
  const ask = async (request, note) => {
    try { return await core(request, { library: LIBRARY }) }
    catch (error) { throw new Error(`${note}失败：${error?.message ?? error}`) }
  }
  const summary = item => {
    const authors = Array.isArray(item.author) ? item.author.map(author => author.family || author.literal || author.given).filter(Boolean).join(', ') : ''
    const year = item.issued?.['date-parts']?.[0]?.[0] ?? ''
    return [item.id, item.title, authors, year, item.citekey].filter(value => value !== undefined && value !== '').join('｜')
  }
  return [
    {
      name: 'search_papers',
      description: '按题名、作者、DOI 或标签检索文献库，返回有界的条目列表。只读。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词；留空则按最近修改列出' },
          limit: { type: 'integer', description: '返回条数，1–50，默认 20' },
        },
        additionalProperties: false,
      },
      run: async args => {
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50)
        const result = await ask({ action: 'resource_list', kind: 'paper', query: String(args.query ?? ''), limit, offset: 0, sort: 'modified', order: 'desc' }, '检索文献')
        const items = (result.items ?? []).filter(item => (item.resource_kind ?? 'paper') === 'paper')
        return {
          text: [`命中 ${result.total ?? items.length} 篇，返回 ${items.length} 篇。`, ...items.map(item => `- ${summary(item)}`)].join('\n'),
          data: { total: result.total ?? items.length, items },
        }
      },
    },
    {
      name: 'read_paper',
      description: '读取一篇文献的元数据（作者、年份、DOI、引用键、标签、摘要）。只读，不改资料。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '文献标识' } }, required: ['id'], additionalProperties: false },
      run: async args => {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('需要文献标识。')
        const result = await ask({ action: 'get', id: args.id }, '读取文献')
        const item = result.item ?? result.paper ?? result
        return { text: `已读取：${summary(item)}`, data: item }
      },
    },
    {
      name: 'read_annotations',
      description: '读取一篇文献的批注目录；给出 annotation_ids 时读取这些批注的原文与批注内容。只读，批注本身仍是 PDF 里的权威对象。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '文献标识' },
          annotation_ids: { type: 'array', items: { type: 'string' }, description: '要读全文的批注标识；省略则只列目录' },
        },
        required: ['id'], additionalProperties: false,
      },
      run: async args => {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('需要文献标识。')
        const ids = Array.isArray(args.annotation_ids) ? args.annotation_ids.filter(value => typeof value === 'string' && value.trim()) : []
        if (ids.length) {
          const result = await ask({ action: 'annotation_context_exact', id: args.id, annotation_refs: ids, selection: 'annotations', max_characters: 20000 }, '读取批注原文')
          const annotations = result.annotations ?? []
          return {
            text: [`读取 ${annotations.length} 条批注。`, ...annotations.map(entry => `- ${entry.page !== undefined ? `第 ${entry.page} 页：` : ''}${String(entry.quote ?? entry.text ?? '').slice(0, 300)}`)].join('\n'),
            data: result,
          }
        }
        const result = await ask({ action: 'annotation_catalog', id: args.id }, '读取批注目录')
        const annotations = result.annotations ?? []
        return {
          text: [`共有 ${annotations.length} 条批注（含外部阅读器写入的）。`, ...annotations.slice(0, 50).map(entry => `- ${entry.id}｜${String(entry.quote ?? entry.text ?? '').slice(0, 120)}`)].join('\n'),
          data: result,
        }
      },
    },
  ]
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────────────────────────
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }) }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

let ROOTS = []
let LIBRARY = null
let WRITE = false
let CATALOGUE = []

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    const wanted = params?.protocolVersion
    return reply(id, {
      protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: [
        WRITE
          ? '画板与 draw.io 文件：可读写。路径必须位于启动时给出的目录内，写入按修订号做原子替换。'
          : '画板与 draw.io 文件：只读（未加 --write）。',
        LIBRARY ? '文献库：只读检索与读取；写入文献库不在本服务器范围内。' : '',
      ].filter(Boolean).join(' '),
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, {
      tools: CATALOGUE.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const tool = CATALOGUE.find(entry => entry.name === params?.name)
    if (!tool) return replyError(id, -32602, `没有这个工具：${params?.name ?? '(缺 name)'}`)
    try {
      const outcome = await tool.run(params?.arguments ?? {})
      return reply(id, {
        content: [{ type: 'text', text: outcome.text }],
        structuredContent: outcome.data,
        isError: false,
      })
    } catch (error) {
      // A refused path or a failed check is an answer, not a crash: the model sees why.
      return reply(id, { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true })
    }
  }
  if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`)
}

async function main() {
  let options
  try { options = parseArguments(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return }
  WRITE = Boolean(options.write)
  ROOTS = []
  for (const root of options.roots) {
    // A root that does not exist is a configuration mistake, not something to discover later.
    try { ROOTS.push(await realpath(resolve(root))) } catch { process.stderr.write(`根目录不存在：${root}\n`); process.exit(2) }
  }
  LIBRARY = null
  if (options.library) {
    // The library directory is resolved once, here: the worker is given exactly this path.
    try { LIBRARY = await realpath(resolve(options.library)) } catch { process.stderr.write(`文献库目录不存在：${options.library}\n`); process.exit(2) }
  }
  CATALOGUE = tools({ write: WRITE })
  const where = [ROOTS.length ? `画板目录 ${ROOTS.join('、')}${WRITE ? '（可写）' : '（只读）'}` : '', LIBRARY ? `文献库 ${LIBRARY}（只读）` : ''].filter(Boolean).join('；')
  process.stderr.write(`${SERVER_NAME} ${VERSION} 已启动：${where}\n`)

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let message
    try { message = JSON.parse(trimmed) } catch {
      replyError(null, -32700, 'JSON 解析失败。')
      continue
    }
    if (Array.isArray(message)) { replyError(null, -32600, '不支持批量请求。'); continue }
    try { await handle(message) } catch (error) {
      if (message?.id !== undefined) replyError(message.id, -32603, String(error?.message ?? error))
      else process.stderr.write(`处理 ${message?.method} 时出错：${error?.stack ?? error}\n`)
    }
  }
}

export { parseArguments, confinedPath, scanBoards, tools, libraryTools, handle, USAGE, LIMITS, BOARD_LIMITS }

// Only start when executed, so a test can import the pieces above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
