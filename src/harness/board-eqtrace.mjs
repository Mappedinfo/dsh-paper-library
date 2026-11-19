/** 仅解析读者选择的 Python 文本；使用随包分发的 EqTrace 规则，不导入用户模块。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validateFlowWorkspace, FLOW_LIMITS } from '../paper-flow/validation.mjs'

const run = promisify(execFile)
const sourceLimit = 256 * 1024
const vendor = fileURLToPath(new URL('../../vendor/eqtrace/', import.meta.url))
const managedPython = fileURLToPath(new URL(process.platform === 'win32' ? '../../.venv/Scripts/python.exe' : '../../.venv/bin/python', import.meta.url))
const failure = (message, status = 400) => Object.assign(new Error(message), { code: 'BOARD_EQTRACE', status })

function sourceFile(file) {
  if (!file || typeof file.name !== 'string' || file.name.length > 200 || basename(file.name) !== file.name ||
      /[\\/:\x00-\x1f]/u.test(file.name) || !file.name.endsWith('.py') || file.name.startsWith('-')) {
    throw failure('请选择文件名有效的 .py 源码。')
  }
  if (typeof file.text !== 'string' || !file.text.trim() || Buffer.byteLength(file.text, 'utf8') > sourceLimit) {
    throw failure('每份源码须为非空文本，最大 256 KiB。')
  }
  return file
}

export async function generateBoardEqTrace(input, { python } = {}) {
  const files = new Map(), args = []
  for (const role of ['entry', 'model']) {
    if (input[role] == null) continue
    const file = sourceFile(input[role])
    const same = files.get(file.name)
    if (same !== undefined && same !== file.text) throw failure('两个不同的源码文件同名，请用 EqTrace 命令行保留目录后再导入 JSON。')
    files.set(file.name, file.text)
    args.push('--' + role, file.name)
  }
  if (!files.size) throw failure('请选择训练入口或模型源码。')
  if (input.class_name) {
    if (typeof input.class_name !== 'string' || input.class_name.length > 200 ||
        !/^[\p{ID_Start}_][\p{ID_Continue}]*(?:\.[\p{ID_Start}_][\p{ID_Continue}]*)?$/u.test(input.class_name)) {
      throw failure('模型选择应填写类名或 Class.method。')
    }
    args.push('--class', input.class_name)
  }
  const custom = process.env.PAPER_LIBRARY_EQTRACE
  if (custom && !isAbsolute(custom)) throw failure('PAPER_LIBRARY_EQTRACE 必须指向本机 eqtrace 可执行文件的绝对路径。', 503)
  const executable = custom || python || (existsSync(managedPython) ? managedPython : process.platform === 'win32' ? 'python' : 'python3')
  const prefix = custom ? ['paper-flow'] : ['-I', '-B', join(vendor, 'run.py')]
  const root = await mkdtemp(join(tmpdir(), 'paper-library-eqtrace-'))
  try {
    for (const [name, text] of files) await writeFile(join(root, name), text, { flag: 'wx', mode: 0o600 })
    let stdout
    try {
      const result = await run(executable, [...prefix, '--root', root, ...args, '--out', '-'],
        { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: FLOW_LIMITS.workspaceBytes, windowsHide: true, encoding: 'utf8' })
      stdout = result.stdout
    } catch (error) {
      if (error.code === 'ENOENT') throw failure('找不到本机 Python 3.11+ 或配置的 EqTrace。请检查 PaperLibrary 的 Python 设置，亦可直接导入流程 JSON。', 503)
      if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw failure('源码解析超时或图过大，请选择更小的训练函数或模型入口。')
      const message = String(error.stderr || '').trim().split(root).join('.').slice(-1500)
      throw failure(message || 'EqTrace 无法解析所选源码。')
    }
    const document = JSON.parse(stdout)
    if (document.kind !== 'paper-flow-document') throw failure('EqTrace 未返回流程文档。')
    validateFlowWorkspace(document)
    return document
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
