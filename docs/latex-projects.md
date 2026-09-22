# LaTeX 项目：编辑器、预览与对比

这一版把「一个装着 `.tex` 和对应 PDF 的文件夹」当作**项目**来管理：源码、参考文献、
图片和编译产物都在同一个目录里，插件只记录「哪个文件夹是项目、哪个文件是主文件」，
不复制、不移动、不删除其中任何东西。

## 为什么是文件夹而不是新格式

- 你原来的工作方式不变：`latexmk`、Overleaf、VS Code、WSL 里的 LaTeX 都仍然可以直接用；
  插件读写的就是同一批文件。
- 「对比研究」因此是可行的：同一篇稿子的两个版本就是两个文件夹，或者同一文件的两个历史版本。
- 文献库这一侧只增加索引与历史，不成为新的权威副本；即使删掉插件，文件也完好。

## 项目模型

| 记录 | 内容 |
| --- | --- |
| `latex_projects` | `id`（`lt-` + 12 位十六进制）、`root`（绝对路径，唯一）、`title`、`main_path`、`pdf_path`、创建/修改时间 |
| `latex_archive` | 归档时间；归档**只影响记录**，文件夹与文件原样保留 |
| `latex_revisions` | 每个文件的历史正文（≤512 KiB）、sha256、来源（读者／AI／写入前快照），每文件保留最近 40 条 |

创建项目时自动寻找主文件：优先 `main.tex`，其次是包含 `\documentclass` 的文件，
否则取字典序第一个 `.tex`；`pdf_path` 取同名 PDF（`main.tex` → `main.pdf`）如果存在。
没有任何 `.tex` 时不会擅自造文件，除非显式传 `create_missing`，此时写入一个最小的
`main.tex`（article + geometry + amsmath + graphicx + ctex + booktabs + hyperref，xelatex 可编译）。

## 读取与写入

- `latex_tree`：项目内的文本文件（`.tex .bib .cls .sty .bst .cfg .def .tikz .txt .md`）、
  素材（PDF／图片／CSV／drawio 等）与构建副产物（`.aux .log .fls .fdb_latexmk .xdv …`），
  上限 2,000 个文件、深度 8。符号链接与隐藏目录（`.git`、`.latex-history` 等）不进入索引。
- `latex_read`：默认读主文件；单文件上限 1 MiB，返回正文、sha256 修订号、行数与最后落库的历史版本。
- `latex_write`：文本后缀才允许写，单文件上限 2 MiB；带 `expected_revision` 时做 CAS，
  过期即返回 `STATE_CONFLICT` 与**当前正文**（前端可提示重新读取）；写入是原子的
  （同目录临时文件 + `os.replace`），并保留写入前、写入后两份历史快照。
- 所有路径都会 `realpath` 后校验是否仍在项目根目录内：`../`、绝对路径、以及指向外部的
  符号链接都会被拒绝，读取与写入都是如此。

## 编译与预览

`latex_compile` 调用**你本机的 `latexmk`**（默认 `/Library/TeX/texbin/latexmk`，找不到就直接报错
而不是假装成功），参数为 `-xelatex|-pdflatex|-lualatex -interaction=nonstopmode -file-line-error -synctex=1`，
工作目录就是项目文件夹，所以 PDF 与 `.tex` 同目录（符合原始习惯）。要点：

- 超时默认 120 秒、上限 600 秒；进程 stdin 关闭，`PATH` 前置 TeX bin，不会挂在交互输入上。
- 返回 `ok`、`exit_code`、`timed_out`、`duration_ms`、`pdf_path`、`pages`、
  `errors`（从 `-file-line-error` 与 `! ` 行提取，最多 40 条）、`log_tail`（末尾 32,000 字符）。
- 编译失败会照实报告：`ok=false`、错误行、日志尾部；已有的 PDF 不会被当成这次的结果。
- `latex_pdf_pages` / `latex_pdf_page` 复用文献库既有的 PDF 管线（2000 页上限、
  像素预算、加密或损坏文件拒绝），把项目 PDF 的页面几何与位图交给预览面板。
- `latex_clean` 只删除已知的构建副产物，绝不碰 `.tex`、`.bib`、`.pdf`。

实测（本机 MacTeX 2025 basic，xelatex）：一篇含中文的单页 `article` 从 `latex_project_create`
到编译完成 **0.30 秒**，产物 4 KB，页面位图通过既有管线正常返回。

## 对比研究

- `latex_history`：某文件的历史版本列表（含当前正文的 sha256）。
- `latex_diff {from_revision, to_revision}`：`previous` 表示「与当前磁盘内容不同的最近一版」，
  `current` 表示磁盘内容，也可以直接给历史版本 id；返回 unified diff、增删行数与截断标记。
- `latex_compare {a, b, path?}`：两个项目之间比较同一个相对路径（默认各自的主文件），
  用于「第一版 / 第二版」这类文件夹级对照。

## 对外的工具与动作

两个原生工具，读写分离，便于审批策略区分：

| 工具 | 动作 |
| --- | --- |
| `library_latex`（只读） | `project_list` `project_get` `tree` `read` `pdf_pages` `pdf_page` `history` `diff` `compare` |
| `library_latex_edit`（写入） | `project_create` `project_update` `project_archive` `project_restore` `write` `compile` `clean` |

两者都把 `input_json` 解析为一次调用，动作名变成 `latex_<operation>`，并且只允许
`src/bridge.mjs` 白名单里的 16 个动作通过。浏览器面板通过同一个 `/api/paper-library/api`
动作面读写，因此编辑器与 Agent 走的是同一条经过校验的路径。

## 编辑器与预览面板（已实现）

顶栏「LaTeX」按钮打开工作台（`web/latex-workspace.js` + `.css`，纯原生 JS，无外部请求）：

- **左上**：项目选择（按标题列出主文件）、「＋ 登记文件夹」（绝对路径 + 可选标题；
  文件夹里没有 `.tex` 时可勾选写入最小 `main.tex`）、主文件标签与保存状态。
- **左下**：文件胶囊（`.tex/.bib/...`，★ 标主文件）+ 带行号的等宽编辑器；
  输入 900 ms 后**自动保存**，⌘/Ctrl-S 立即保存；保存队列串行，所以两次击键不会抢同一个修订号。
- **右侧**：`latex_pdf_page` 渲染的页面（1.4× 缩放，最多缓存 6 页）、翻页、引擎/耗时/页数；
  「编译」按钮调用 `latex_compile` 并在下方列出错误行（可展开 latexmk 输出尾部）。
- **冲突处理**：别的编辑器改过文件后，面板的保存会被拒绝并在底部给出「载入最新 / 用我的版本覆盖」，
  在你选择之前磁盘内容不会被覆盖。
- **对比**：「与上一版对比」（`latex_diff` previous→current）与「项目对照」（`latex_compare`，
  选另一个项目比较同一相对路径），差异显示在对话框底部的 `<pre>` 里。

浏览器回执（真实 Chromium + 真实 Python worker + 真实 latexmk，13 项）：
`docs/validation/latex-workspace-browser.json`，
复现命令 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/latex-workspace-fixture.mjs`。
它覆盖：打开对话框、加载项目树与主文件、编辑落盘、编译并渲染首页、过期保存被拒且不覆盖、
载入最新不改文件、与上一版对比、切换文件、两个项目对照、面板内登记新文件夹并写入 starter、
无浏览器报错、零外部请求。面板截图见 `docs/images/latex-workspace.jpg`。

## 下一步（尚未实现，按顺序落地）

1. **DSH 提问**：把当前选区或整篇主文件作为有界上下文，走已有的论文会话通道提问，
   回答可回填为批注或草稿，不直接改文件。
3. **人机互写**：模型产出的是**补丁提案**（替换片段 + 依据 + 修订号），读者接受后
   才用 `latex_write` 带 `expected_revision` 落盘，来源记 `ai:<model>`；拒绝则只留历史。
4. **Markdown → LaTeX**：参考 `MarkTex` 的表格／数学／代码块转换规则，做成本地、离线、
   不改源文件的导入路径（复用它的表格环境选择与转义思路，不引入浏览器 WASM 依赖）。
