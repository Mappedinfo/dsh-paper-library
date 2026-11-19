/** 从指定 Git 修订同步随宿主分发的纯静态模块。 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [repository, revision] = process.argv.slice(2)
if (!repository || !revision) throw Error('用法：node scripts/vendor-eqtrace.mjs <EqTrace 仓库> <提交>')
const repo = resolve(repository)
const git = (...args) => execFileSync('git', ['-C', repo, ...args])
const commit = git('rev-parse', '--verify', '--end-of-options', revision + '^{commit}').toString().trim()
const target = fileURLToPath(new URL('../vendor/eqtrace/', import.meta.url))
const files = new Map([['LICENSE', git('show', commit + ':LICENSE')]])
for (const name of ['__init__', 'network_flow', 'training_flow', 'tensor_shapes', 'training_tensors', 'paper_flow']) {
  const file = 'eqtrace/' + name + '.py'
  files.set(file, git('show', commit + ':code/src/' + file))
}
await mkdir(join(target, 'eqtrace'), { recursive: true })
for (const [file, bytes] of files) await writeFile(join(target, file), bytes)
await writeFile(join(target, 'REVISION'), commit + '\n')
console.log('已同步 EqTrace 静态解析模块 ' + commit)
