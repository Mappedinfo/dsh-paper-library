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

## 默认论文目录与同步（已实现）

插件自己维护一个论文目录，默认 `<DSH home>/manuscripts`（本机 `~/.dsh/manuscripts`），
可用部署配置 `latexRoot` 或环境变量 `DSH_PAPER_LIBRARY_LATEX_ROOT` 覆盖：

- ☰ 菜单里的**新建项目**在该目录下建 `<名称>/`（名称会清洗成安全的一段路径），
  按设置写入最小 `main.tex`，然后走同一套 `latex_project_create` 登记；
  同名再次新建会直接选中已有项目，不会重复建目录
- 目录不存在时首次新建会 `mkdir -p`；不可写则明确报错，不会静默换到别处
- 该目录默认作为**独立源**加入数据同步服务（`~/.dsh/vault-sync/config.json`）：
  写入前 `cp` 备份为 `config.json.bak-<时间>`，只新增一个 `paper-library-latex` 源，
  绝不删除、重排或改写其他源；已被任何源覆盖（含 `paper-library-state`）时不重复添加；
  配置缺失、非法 JSON 或不可写时只报告原因，不阻断项目创建
- 排除构建副产物（`*.aux/*.fls/*.fdb_latexmk/*.synctex.gz/*.out/*.blg/.latex-build`），
  `.tex/.bib/.pdf/图片` 照常同步；设置 `latex_sync_folder` 可关掉自动纳入

## 编辑器与预览面板（已实现）

工作台是**独立页面**（和画板一样），不是弹窗：顶栏「LaTeX」把整页切成工作台（`body.latex-focused`
隐藏顶栏与文献库），工具栏右侧「返回文献库」回到列表且不刷新页面；`?view=latex` 与画板的
`?view=board` 对称，可以直接作为一个 DSH 标签页的入口，此时页面只剩工作台。
（`web/latex-workspace.js` + `.css`，纯原生 JS，无外部请求。）

- **布局是 Overleaf 习惯**：源码在左、PDF 在右，中间一条可拖拽（或 ←/→）的分隔条，
  比例存进设置 `latex_split`；顶部只有项目选择、主文件、保存状态、自动编译状态、编译按钮和 ☰。
- **左侧**：文件胶囊（`.tex/.bib/...`，★ 标主文件）+ 带行号的等宽编辑器；
  输入 900 ms 后**自动保存**，⌘/Ctrl-S 立即保存；保存队列串行，两次击键不会抢同一个修订号。
- **右侧页签**：`PDF`（`latex_pdf_page` 渲染，1.4×，最多缓存 6 页，翻页与引擎/耗时/页数）与
  `版本`（与上一版对比，以及菜单触发的「与其他项目对比」结果）。
- **DSH 写作在阅读侧栏里**：提问与提案不是再加一个页签，而是登记进文献库那套**侧栏**
  （`PaperReadingPanels` 的共享 rail，和「批注」同一种实现）：同样的左右切换（⇄，跟随
  `reading-panel-side`）、同样的宽度拖拽与保存（`reader:layout.rail_width`）、同样的标题栏与 ×。
  打开工作台时侧栏自动打开并只显示「DSH 写作」这一栏（文献库/批注页签让位，返回文献库后原样恢复）；
  工具栏的「DSH 写作」按钮可随时收起/展开。没有传侧栏实例时（例如被单独嵌入），
  面板退化为工作台内的一个页签，功能不变。
- **自动编译**（默认开，可在 ☰ 设置里关）：保存成功后空闲约 2.5 秒自动重编译，同一时刻只跑一个；
  已有 PDF 的项目才会自动编译，从未编译过的项目先手动编译一次，连续失败会暂停自动编译，
  手动成功一次后恢复。
- **☰ 菜单**：新建项目、登记已有文件夹（绝对路径，文件留在原处）、与其他项目对比、
  写作设置（写入最小 `main.tex`、自动编译）、论文目录与同步状态（「纳入同步」按钮）。
- **冲突处理**：别的编辑器改过文件后，面板的保存会被拒绝并在底部给出「载入最新 / 用我的版本覆盖」，
  在你选择之前磁盘内容不会被覆盖。

颜色只走插件的主题桥（`--paper/--surface/--panel/--ink/--muted/--line/--teal/--error` 与
`--dsw-alias-*`），少数语义色用 `light-dark()`；因此跟随系统/DSH 的浅色与深色，正文与底色始终分离
（回执里有一条把 `prefers-color-scheme` 切到 dark 后比较计算样式与亮度的检查）。
布局上只有编辑器与预览两个滚动区；侧栏收起时工作台占满整页（不再留下一条侧栏宽的空白列——
此前 `.workspace[data-sidebar-side]` 的栅格会保留该列，而列内容被隐藏，看起来就是一条空白色带）。

外壳集成回执（真实 `src/server.mjs` 主机 + 真实页面 + 真实面板，11 项）：
`docs/validation/latex-shell-browser.json`，
复现命令 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/latex-shell-fixture.mjs`。

面板回执（真实 Chromium + 真实 Python worker + 真实 latexmk + 真实协作模块（模型为桩），22 项）：
`docs/validation/latex-workspace-browser.json`，
复现命令 `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/latex-workspace-fixture.mjs`。
它覆盖：打开对话框、加载项目树与主文件、编辑落盘、编译并渲染首页、过期保存被拒且不覆盖、
载入最新不改文件、与上一版对比、切换文件、两个项目对照、面板内登记新文件夹并写入 starter、
协作区可用并加载模型、提问就地回答且不改文件、提案先审后写、接受后经 CAS 落盘并刷新编辑器、
放弃提案不写文件、进入/离开整页工作台、分隔条比例落库、空闲后自动重编译、
在插件目录新建项目并只向同步配置新增一个源（含备份与幂等）、深浅色对比可读、
无浏览器报错、零外部请求。
截图：`docs/images/latex-workspace.jpg`、`docs/images/latex-workspace-ai.jpg`、
`docs/images/latex-workspace-dark.jpg`、`docs/images/latex-workspace-rail.jpg`、
`docs/images/latex-workspace-rail-dark.jpg`。协作模块本身另有 6 项 Node 测试
（`tests-js/latex-ai.test.mjs`，模型为桩、稿件与写入都是真实文件）。

## DSH 提问与人机互写（已实现）

面板底部是同一条协作区（`src/harness/latex-ai.mjs`，动作前缀 `latex_ai_`）：

- **问题**：`latex_ai_ask` 把「文件（或编辑器里选中的片段）+ 你的问题」交给模型，回答直接显示在
  面板里。材料写明是**不可信引用数据**，模型被告知不要执行其中的指令、不要编造引文或数据。
  提问**不写文件**；选中的文字已经不在文件里会明确报错，而不是悄悄改用整篇文件。
- **提案**：`latex_ai_propose` 要求模型返回**逐字替换**的 JSON（`find`/`replace`），服务端逐条校验
  每个 `find` 在它读到的那一版里**恰好出现一次**（最多 20 处、合计 ≤64 KiB），然后只保存替换项
  ——**不保存第二份文件正文**，所以文件夹始终是唯一权威。
- **接受**：`latex_ai_accept` 重新读取文件、比对提案记录的修订号，再用与读者相同的 `latex_write`
  （CAS）落盘，来源记为 `ai:<provider>/<model>`；文件在提案之后被改过就返回 `STATE_CONFLICT`
  与当前正文，提案保留待你处理，**绝不覆盖**。
- **放弃**：`latex_ai_discard` 只清掉提案，留下一条记录。
- 提问与提案各自留下最多 4 条协作记录（问题/回答/摘要/模型），面板重开即可看到；模型路由可以是
  请求里选的（面板从 `/models` 列出），也可以来自插件部署配置 `provider`/`model`；两者都没有时
  会明确提示先选模型，而不是猜一个。

## 下一步（尚未实现）

- **Markdown → LaTeX**：参考 `MarkTex` 的表格／数学／代码块转换规则，做成本地、离线、不改源文件的
  导入路径（复用它的表格环境选择与转义思路，不引入浏览器 WASM 依赖）。
- 面板可选增强：编辑区语法高亮、选区→提问的右键菜单、提案的部分接受。
