/** 从固定上游提交提取受控源码；不访问上游工作区或用户项目。 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'https://github.com/Mappedinfo/PlainDeck'
const revision = 'e24105a34028fc87802e65b522fdc29a5b5312da'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const destination = join(root, 'vendor/plaindeck')
const roots = ['src', 'packages/plaindeck/src/core', 'packages/plaindeck/src/render', 'packages/plaindeck/src/react']
const notices = ['LICENSE', 'packages/plaindeck/LICENSE', 'packages/plaindeck/THIRD_PARTY_NOTICES.md', 'packages/plaindeck/package.json']
const isSource = path => roots.some(prefix => path.startsWith(`${prefix}/`)) && !/(?:^|\/)(?:__tests__|tests?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path)
const permitted = path => typeof path === 'string' && !path.includes('\\') && !path.split('/').some(part => ['', '.', '..'].includes(part)) && (notices.includes(path) || isSource(path))
const arguments_ = process.argv.slice(2)
const sourceIndex = arguments_.indexOf('--source')
const sourceArgument = sourceIndex >= 0 ? arguments_[sourceIndex + 1] : process.env.PLAINDECK_SOURCE
const check = arguments_.includes('--check')
if (!sourceArgument || sourceArgument.startsWith('--') || arguments_.some((argument, index) => !['--source', '--check'].includes(argument) && index !== sourceIndex + 1)) {
  throw new Error('用法：node scripts/vendor-plaindeck.mjs --source /path/to/AnyPre [--check]；也可通过 PLAINDECK_SOURCE 指定上游 clone。')
}
const source = resolve(sourceArgument)
const git = (...args) => execFileSync('git', ['-C', source, ...args], { maxBuffer: 16 * 1024 * 1024 })
if (git('rev-parse', `${revision}^{commit}`).toString().trim() !== revision) throw new Error('上游缺少固定提交。')
const paths = git('ls-tree', '-r', '--name-only', revision, '--', ...roots, ...notices).toString().trim().split('\n').filter(permitted).sort()
for (const notice of notices) if (!paths.includes(notice)) throw new Error(`上游缺少许可或包元数据：${notice}`)
const files = new Map(paths.map(path => [path, git('show', `${revision}:${path}`)]))

const version = JSON.parse(files.get('packages/plaindeck/package.json').toString()).version
const upstream = {
  repository,
  revision,
  declared_version: version,
  version_note: '编辑器与 core、render、react 同源构建，不混用其他修订。',
  local_reference: '用户指定的 AnyPre 上游 clone；路径仅作为更新命令的参数，不写入分发文件。',
  license: 'MIT',
  files: paths,
}
const readme = `# PlainDeck 源码子项目

此目录固定复用 [Mappedinfo/PlainDeck](${repository}) 的提交 \`${revision}\`，保留上游相对目录结构和许可。它是 Paper Library 的 slides 编辑器基础；宿主 API、主机持久化、项目切换和入口适配放在主仓库 \`src/slides/\`，不直接修改本目录的上游文件。

当前上游包声明为 ${version}。Web、core、render、react 均来自此固定提交，并一起构建。构建别名分别使用：

- \`plaindeck/core\` → \`packages/plaindeck/src/core/index.ts\`
- \`plaindeck/render\` → \`packages/plaindeck/src/render/index.ts\`
- \`plaindeck/react\` → \`packages/plaindeck/src/react/index.tsx\`

## 来源与范围

\`UPSTREAM.json\` 记录提交和精确文件清单。快照只含受控的 \`src/\` 非测试源码、核心／HTML 渲染／React 渲染源码、包元数据与许可；不读取或复制上游 \`projects/\`、个人稿件、运行依赖、演示导出或构建产物。用户提供的本地参考 clone 名为 AnyPre。

上游 \`src/main.tsx\`、浏览器目录／OPFS／IndexedDB／localStorage 存储与分析入口保留为未改动的来源文件；Paper Library 使用自己的入口和存储桥，不调用这些上游持久化及分析功能。Node 的 Playwright 渲染文件也不作为浏览器入口，不因此安装或启动额外服务。

## 核对与升级

在主仓库运行：

\`\`\`sh
node scripts/vendor-plaindeck.mjs --source /path/to/AnyPre --check
\`\`\`

要升级，先审查上游变更，再修改 \`scripts/vendor-plaindeck.mjs\` 中的固定 revision，执行同一命令去掉 \`--check\`。脚本仅通过 \`git ls-tree\` 与 \`git show\` 读取固定提交的白名单，更新其拥有的快照文件和来源说明；不会读取上游工作区，也不会覆盖 \`src/slides/\` 集成层。之后检查 diff，运行 Paper Library 的相关 slides 测试与构建，再提交快照与集成改动。无需 Git 子模块初始化或额外下载已编译前端。

## 许可

原创代码为 [MIT](LICENSE)。包的 [第三方声明](packages/plaindeck/THIRD_PARTY_NOTICES.md) 保留 juya-news-card 派生设计目录等来源。React、zustand、lucide-react、JSZip、zod 等实际构建依赖继续按各自许可分发，由 Paper Library 的依赖与第三方声明统一维护。
`
files.set('UPSTREAM.json', Buffer.from(JSON.stringify(upstream, null, 2) + '\n'))
files.set('README.md', Buffer.from(readme))

let previous
try { previous = JSON.parse(await readFile(join(destination, 'UPSTREAM.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
const stale = (previous?.files ?? []).filter(path => typeof path === 'string' && permitted(path) && !files.has(path))
const changed = []
for (const [path, bytes] of files) {
  let current
  try { current = await readFile(join(destination, path)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current?.equals(bytes)) continue
  changed.push(path)
  if (!check) { await mkdir(dirname(join(destination, path)), { recursive: true }); await writeFile(join(destination, path), bytes) }
}
if (!check) for (const path of stale) await rm(join(destination, path), { force: true })
if (check && (changed.length || stale.length)) {
  console.error(JSON.stringify({ ok: false, revision, changed, stale }, null, 2))
  process.exitCode = 1
} else console.log(JSON.stringify({ ok: true, mode: check ? 'check' : 'update', revision, upstream_files: paths.length, changed: changed.length, removed: stale.length }))
