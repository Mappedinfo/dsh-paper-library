# LaTeX 项目：编辑器、预览与对比

这一版把「一个装着 `.tex` 和对应 PDF 的文件夹」当作**项目**来管理：源码、参考文献、
图片和编译产物都在同一个目录里，插件只记录「哪个文件夹是项目、哪个文件是主文件」，
不搬动既有文件；明确导入图片时会新增项目内素材。

## 图片、表格与公式工具

源码栏「插入」集中提供以下工具，生成的内容进入当前源码草稿，沿用撤销、自动保存和冲突保护。异步处理期间若已切换文件或修改原草稿，工具保留生成内容供复制，不向新文件插入。

- **图片**：`⌘/Ctrl+Shift+I` 立即插入 figure 模板；「插入图片」可选文件，源码区也接收图片拖放与截图粘贴。PNG／JPEG 保留字节，其余受支持图片转换为 PNG（GIF 取首帧），写入当前项目 `figures/`，文件名含内容标识，同名不覆盖。最多 8 MiB、5000 万像素。导言区需要 `\usepackage{graphicx}`；模板的图片说明和引用标签需自行填写。
- **表格**：`⌘/Ctrl+Shift+T` 打开可编辑网格。粘贴 Markdown 表格、从 Excel 复制单元格，或导入／拖入／粘贴 `.xlsx` 文件；选择工作表、修改单元格、设列角色（文本左对齐／数值右对齐／居中）、表头、标题和引用标签，然后复制或插入 LaTeX。最多 100 行、30 列、2000 个单元格；XLSX 最多 8 MiB，只读缓存值，不计算公式，缺缓存时拒绝导入。单元格作为普通文本转义，样式、合并单元格与数字显示格式不保留。
- **公式**：「提取并检查公式」先保存当前编辑，再按需读取项目内保存的 `.tex` 文件，列出常见行内／独立数学环境及其文件、行号。自动检查分隔符、花括号、`\left`／`\right` 数量、重复标签及未定义 `\eqref`，点击结果定位源码。保存失败或冲突时暂停检查；不调用模型、不展开宏、不判断数学推导。包括未参与当前编译的 `.tex`，单次最多 100 文件／8 MiB 源码／500 公式／500 提示；达到上限明确标记覆盖不完整。

写作设置中的「文件路径字体」提供像素、等宽和跟随界面三种选择，与 DSH 插件设置共用偏好。导航、源码、PDF 标题行统一高度；侧栏标题与主工具栏对齐。PDF 状态行显示当前页数，提前准备相邻页；保存批注时局部更新标记层，保持当前阅读位置。

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

## 章节、文件与媒体侧栏

从 DSH「开始 → LaTeX 工作台」进入原有工作台。左侧用「章节／文件／媒体」切换；
编辑器顶部只显示当前文件路径。右侧 DSH 写作栏可独立收起，宿主工作台的全屏按钮可扩展写作空间。

顶部「主入口」可在同一目录的正式稿与草稿之间切换，候选来自含 `\documentclass` 的文本源文件。
切换只更新项目记录，不改论文内容；章节与编译预览都随当前入口变化。新入口没有同名 PDF 时
显示待编译状态，不再沿用上一入口的 PDF。

`latex_outline {id}` 按当前入口中静态 `\input`／`\include` 的出现位置深度展开，
再按 `part/chapter/section/subsection/subsubsection/paragraph` 和 abstract 的源码顺序列出标题。
中文、星号、短标题参数、嵌套花括号、空标题都保留可用位置；点击跳到相应文件的 1-based 行。
重复／共享章节按每次引用出现，循环中断并显示警告。input/include 链之外的文本（书目、其他稿件、
未引用笔记等）放在「其他文本文件」中，文件树始终可用。
引用优先按项目根目录解析，找不到时尝试引用文件所在目录。注释、宏定义与逐字示例不作章节；
这是静态导航，不是 TeX 解释器：动态路径、条件、includeonly 与自定义导入不展开，明确显示未解释。
一次最多读取 100 个源文件／8 MiB，展开 1,200 个节点、24 层；文件树沿用 2,000 文件／8 层预算，
达到预算时显示结果不完整。刷新按钮重读磁盘；保存成功后自动刷新章节，不解析未保存文字。

「媒体」按目录展示项目内素材，包含 `media/formal`。`latex_media_preview {id,path,page?,scale?}`
只读取当前选择的一个文件：PNG、JPEG、SVG、PDF 返回惰性 PNG 预览、路径、尺寸、字节数与页码，
可翻页、适应和缩放。SVG 先拒绝脚本、事件、外部资源、嵌入内容与 DTD，再在本地光栅化；
浏览器不接收可执行 SVG。其余类型显示不支持原因。图片输入 ≤32 MiB，SVG ≤2 MiB，
位图源 ≤6,400 万像素；PDF 沿用 2,000 页及加密拒绝规则。全部路径经过项目边界校验。

文件、入口或项目切换以及关闭工作台前，会等待保存完成；保存失败或冲突时留在原文件保留编辑。
快速连续切换取消过期读取，即使旧传输未响应取消也不能覆盖新选择。失败状态提供原页重试。

## 单人自审

见 [单人自审工作流](latex-self-review.md)：真实 SyncTeX 双向定位、源码选段批注、PDF 原生高亮与区域便笺、统一列表和版本失效提示；复用 Paper Library 阅读与 PDF 对象工具，编译原 PDF 保留。

## 编译与预览

`latex_compile` 调用**你本机的 `latexmk`**（默认 `/Library/TeX/texbin/latexmk`，找不到就直接报错
而不是假装成功），参数为 `-g -xelatex|-pdflatex|-lualatex -interaction=nonstopmode -file-line-error -synctex=1`，
工作目录就是项目文件夹，所以 PDF 与 `.tex` 同目录（符合原始习惯）。要点：

- 超时默认 120 秒、上限 600 秒；进程 stdin 关闭，`PATH` 前置 TeX bin，不会挂在交互输入上。
- 返回 `ok`、`exit_code`、`timed_out`、`duration_ms`、`pdf_path`、`pages`、
  `errors`（从 `-file-line-error` 与 `! ` 行提取，最多 40 条）、`log_tail`（末尾 32,000 字符）。
- 编译失败会照实报告：`ok=false`、错误行、日志尾部；已有的 PDF 不会被当成这次的结果。
- `latex_pdf_pages` 返回几何与文件版本；`latex_pdf_page {id,page?,scale?}` 按请求密度渲染。
  工作台依显示宽度 × 缩放 × `devicePixelRatio` 请求实际像素，支持全宽至 400%，
  去掉原先 `scale ≤2`／160 万像素的清晰度裁减。不会静默降低请求密度。
  极端请求超过单页分配安全边界（6,400 万像素或单边 16,000，PNG 传输 ≤18 MiB）明确拒绝，
  提示缩窄预览区或降低缩放；这是拒绝分配，不能当作低清替代图成功返回。
  只渲染当前页、取消过期渲染；缓存最多三页，按编码字节与预计解码字节合计 48 MiB 淘汰，
  当前显示页可单独超过缓存预算，其余缓存会被释放。侧栏／窗宽变化重新计算密度。
- `latex_clean` 只删除已知的构建副产物，绝不碰 `.tex`、`.bib`、`.pdf`。

实测（本机 MacTeX 2025 basic，xelatex）：一篇含中文的单页 `article` 从 `latex_project_create`
到编译完成 **0.30 秒**，产物 4 KB，页面位图通过既有管线正常返回。

## 未完成内容检查（LaTeX lint）

未完成内容统一用 `todo` 或 `xxxx` 标记，草稿和正式稿在写作期间都允许保留。
`latex_lint` 是显式调用的只读检查，不改变保存、自动保存或编译行为，也不调用模型。
它检查磁盘上已保存的文本；先按已有流程保存编辑内容，再发起检查。当前接入已有 JSON CLI、
API 与 DSH 的 `library_latex` 只读工具；工作台没有新增按钮或自动检查钩子。

```json
{"action":"latex_lint","id":"lt-0123456789ab","mode":"editing","main_path":"draft.tex"}
```

将请求保存为 `lint-request.json`，运行：

```sh
node src/cli.mjs --library /absolute/library < lint-request.json
```

投稿前将 `mode` 改成 `submission`，将 `main_path` 改成正式稿入口（如 `formal.tex`）。
`main_path` 只覆盖这次检查，不改项目登记的主文件；双入口可共用 `.bib` 与 `media/formal/`
素材目录。DSH 中用 `library_latex` 的 `operation:"lint"`，将同一对象去掉 `action` 后作为
`input_json` 传入。HTTP 也沿用既有 `/api/paper-library/api` JSON action 接口。

参数：`id` 必填；`mode` 默认为 `editing`，另可选 `submission`；`main_path` 默认为登记的
主文件；`paths` 可追加最多 100 个项目内文本路径，例如 `["notes.md","sections/appendix.tex"]`。
默认沿主文件的静态 `\input`、`\include`、`\bibliography`、`\addbibresource` 引用检查，
无扩展名时分别补 `.tex`／`.bib`。引用始终相对**项目根目录**，每个解析后的文件仅检查一次，
循环／重复引用不会反复读取。不会遍历整个目录，也不会检查其他入口、未引用笔记、图片、
构建产物或 TeX 系统包；需要的其他文本由 `paths` 明确加入。

规则与忽略范围：

- `todo` 不区分大小写，独立词与 `\todo{...}`／`\TODO[...]{...}` 都记录；连续至少四个
  `x`（含 `XXXX`、`xxxxx`）也记录。两侧 ASCII 字母、数字、下划线阻止匹配，所以
  `methodology`、`todos`、`todo_list`、`prefixxxxx` 不匹配；中文紧邻标记仍匹配。
  分类为 `todo`、`todo_command`、`xxxx`，一个命令与其参数中的其他标记分别计数。
- 普通 LaTeX `% TODO` 注释也检查；注释里的文件引用不跟进。正常学术 `AI` 字样不报错。
- 自动忽略逐字／代码环境 `verbatim`、`verbatim*`、`Verbatim`、`BVerbatim`、`LVerbatim`、
  `lstlisting`、`minted`、`comment`、`filecontents`、`filecontents*`；行内 `\verb`、`\Verb`、
  `\lstinline`、`\mintinline` 与 `\detokenize`；URL／路径命令的路径参数、文件引用的文件名，
  以及宏声明的名称。定义 `\todo` 等占位渲染宏时，宏正文中与宏名同类的普通显示标签
  （如 `\texttt{todo:}`）不计作未完成事项；定义中的注释、实际 `\todo` 调用及其他类别占位
  仍检查。普通宏正文与 `\href` 的显示文字仍检查。
- 显式追加的 Markdown 文本忽略反引号行内代码与反引号／波浪线代码围栏；其他正文仍检查。
  未闭合代码区域会报告范围不完整。LaTeX 不是完整宏解释器，不推断条件分支或 `includeonly`；
  动态文件名、缺失依赖、编码错误和超预算都报告检查范围不完整。自定义导入宏需将实际文本
  放进 `paths`，不会自动展开宏。
- 普通文字或 `\texttt{todo}` 若是在说明标记约定，可在该行尾写
  `% latex-lint: ignore-line -- literal example`，或在上一行写
  `% latex-lint: ignore-next-line -- literal example`。只忽略对应行的占位标记，不隐藏引用
  范围错误；没有整份文件或整个项目的静默忽略开关。

结果使用稳定 schema `paper-library-latex-lint.v1`：

```json
{
  "schema":"paper-library-latex-lint.v1",
  "id":"lt-0123456789ab", "mode":"submission", "main_path":"formal.tex", "paths":[],
  "ok":false, "status":"failed", "submission_ready":false, "complete":true,
  "counts":{"findings":1,"markers":1,"todo":0,"todo_command":0,"xxxx":1,"scope":0,"warn":0,"submission_blocker":1},
  "findings":[{"path":"formal.tex","line":12,"column":5,"context":"Text xxxx","category":"xxxx","severity":"submission_blocker","marker":"xxxx","message":"未完成内容占位符"}]
}
```

另返回 `files:[{path,revision,bytes}]`、已读 `bytes`、`limits` 和 `truncated`。路径仅返回项目内
相对路径，不返回项目根目录；行列从 1 起，列按 Unicode 字符计数，命令定位在反斜杠。
上下文最多 200 字符，忽略的字面量留空，绝对路径字面量遮蔽。`revision` 与编辑器的文本
sha256 一致，可用于判断报告对应的保存版本。这里的“投稿通过”仅指占位检查通过。

`editing` 中标记为 `warn`，完整检查即 `ok:true`，有标记时 `status:"warnings"`；
`submission` 中为 `submission_blocker`，有占位即 `ok:false,status:"failed"`。
两种模式发现覆盖问题都返回 `ok:false,status:"incomplete",complete:false`；只有覆盖完整且
没有占位才 `submission_ready:true`。CLI 的外层 `ok` 与结果一致，未通过退出码为 1，
通过（含写作期占位警告）为 0；API／工具调用成功与 lint 通过不同，应读取结果中的 `ok`。

预算：100 文件、单文件 1 MiB、合计 8 MiB、引用深度 32、最多 2,000 条文件引用；这些边界
触发时不会声称完整通过。报告最多列出 1,000 条发现，超出用 `truncated:true` 表示，计数仍覆盖
预算内已扫描的全部标记。路径、后缀和 UTF-8 都校验；拒绝项目外路径、绝对路径及指向外部的
符号链接，不执行 TeX 宏。合成回归可重跑：

```sh
.venv/bin/python -m pytest -q tests/test_latex_lint.py tests/test_latex.py
node --test tests-js/latex-lint.test.mjs tests-js/latex-tools.test.mjs tests-js/latex-ai.test.mjs tests-js/latex-workspace.test.mjs
```

## 对比研究

- `latex_history`：某文件的历史版本列表（含当前正文的 sha256）。
- `latex_diff {from_revision, to_revision}`：`previous` 表示「与当前磁盘内容不同的最近一版」，
  `current` 表示磁盘内容，也可以直接给历史版本 id；返回 unified diff、增删行数与截断标记。
- `latex_compare {a, b, path?}`：两个项目之间比较同一个相对路径（默认各自的主文件），
  用于「第一版 / 第二版」这类文件夹级对照。

## SyncTeX 双向跳转（已实现）

编译始终带 `-synctex=1`，项目 PDF 旁边的 `.synctex.gz` 由本机 `synctex` 命令行（随 TeX Live /
MacTeX 安装，定位逻辑与 `latexmk` 相同）解读，两个动作都是只读：

- `latex_synctex_edit {id, page, x, y}`（反向）：把页面上一点映射回源码。坐标是**显示态 PDF 点、
  左上角原点**，与 `latex_pdf_pages` 报告的页面几何、预览位图同一套；synctex 是就近匹配，
  点在空白处会吸附到最近的源码行而不是报错。返回的 `Input` 路径先 realpath 归一
  （synctex 会原样带回编译时的 `./` 段），再校验必须落在项目目录内——落在 TeX 系统样式上
  （项目外）就明确拒绝而不是跳出去读。
- `latex_synctex_view {id, path, line, column?}`（正向）：把某个源文件的某一行映射到 PDF 的
  页码与矩形框（`h/v/W/H` 与命中点 `x/y`，同一坐标系），并报告该页旋转角。
- 带旋转的页两个方向都拒绝：SyncTeX 在未旋转坐标系里计数，映射会错位。
- PDF 早于这次修改时，正向搜索可能命中旧位置——synctex 本身不知道文件已改，这与所有
  SyncTeX 编辑器一致，重新编译即恢复精确。

面板上：**双击 PDF** 反向跳到对应源码行（切换文件会先落盘未保存的改动，再选中整行并滚动到
可视区）；预览页头的 `⇥` 按钮把编辑器光标所在行正向定位到 PDF 并闪烁高亮该矩形。

## 对外的工具与动作

两个原生工具，读写分离，便于审批策略区分：

| 工具 | 动作 |
| --- | --- |
| `library_latex`（只读） | `project_list` `project_get` `tree` `read` `lint` `pdf_pages` `pdf_page` `history` `diff` `compare` `synctex_edit` `synctex_view` |
| `library_latex_edit`（写入） | `project_create` `project_update` `project_archive` `project_restore` `write` `compile` `clean` |

两者都把 `input_json` 解析为一次调用，动作名变成 `latex_<operation>`，并且只允许
`src/bridge.mjs` 白名单里的 19 个动作通过。浏览器面板通过同一个 `/api/paper-library/api`
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
（`web/latex-workspace.js` + `.css`，CodeMirror 编辑器随插件本地打包，无外部请求。）

- **布局**：源码和 PDF 可并排，也可切换「仅源码」「仅 PDF」；章节／文件／媒体导航可以收起。
  分隔条可拖拽或用 ←/→ 调整，比例存进 `latex_split`；切换视图不会丢失该比例或改写侧栏偏好。
- **编辑**：CodeMirror 提供 LaTeX 语法高亮、行号、撤销／重做、括号匹配、常用命令建议及当前文件查找／替换；
  菜单或快捷键均可打开查找。输入 900 ms 后**自动保存**，⌘/Ctrl-S 立即保存；保存队列串行，冲突继续保留草稿。
  命令建议是固定集合，不是项目引用键或跨文件补全；语法模式不是完整 TeX 宏解释器。
- **预览**：PDF、媒体与版本视图共用右侧；PDF 按实际显示宽度和缩放渲染，最多保留三页并遵守缓存预算。
  全篇可连续上下滚动，仅当前位置及相邻页保留图像；页签、页码／缩放和批注操作合并为一行，SyncTeX 状态继续单列。
  `版本`展示手动编译快照，也保留与上一版或另一项目的同路径文件对比。[共用版本与批注](latex-self-review.md#手动编译版本与阅读项目)。
- **DSH 写作在阅读侧栏里（左右两侧都已验证：侧栏在左或在右，收起后工作台都占满整页）**：提问与提案不是再加一个页签，而是登记进文献库那套**侧栏**
  （`PaperReadingPanels` 的共享 rail，和「批注」同一种实现）：同样的左右切换（⇄，跟随
  `reading-panel-side`）、同样的宽度拖拽与保存（`reader:layout.rail_width`）、同样的标题栏与 ×。
  打开工作台时侧栏自动打开并只显示「DSH 写作」这一栏（文献库/批注页签让位，返回文献库后原样恢复）；
  工具栏的「DSH 写作」按钮可随时收起/展开。没有传侧栏实例时（例如被单独嵌入），
  面板退化为工作台内的一个页签，功能不变。
- **自动编译**（默认开，可在 ☰ 设置里关）：保存成功后空闲约 2.5 秒自动重编译，同一时刻只跑一个；
  已有 PDF 的项目才会自动编译，从未编译过的项目先手动编译一次，连续失败会暂停自动编译，
  手动成功一次后恢复。
- **引擎与诊断**：☰ 的「编译引擎（全部项目）」在 XeLaTeX、pdfLaTeX、LuaLaTeX 间选择，默认 XeLaTeX；
  手动和自动编译使用同一全局偏好。编译按钮旁显示成功或失败与错误数量，点击展开诊断和日志。
  能确认属于当前项目文本文件的错误位置可点击跳转；无法确认的路径保留原文，不猜测位置。
- **还没有任何项目时**，预览区直接给出两个入口按钮（新建项目…／登记已有文件夹…），
  点击打开 ☰ 菜单并聚焦对应输入框；空文件夹可勾选写入最小 `main.tex`，
  非空文件夹只登记不动文件
- **☰ 菜单**：新建项目、登记已有文件夹（路径输入框旁的「选择…」按钮调起系统文件夹
  选择对话框——浏览器拿不到绝对路径，所以由宿主侧 osascript/zenity/PowerShell 完成；
  不支持的平台上明确提示改为粘贴路径；文件留在原处）、与其他项目对比、
  写作设置（写入最小 `main.tex`、自动编译、编译引擎）、论文目录与同步状态（「纳入同步」按钮）。
- **配色与文件路径**：写作设置提供跟随宿主、纸色、夜色三种工作台主题，选择保存在 `latex_theme`，不改变宿主全局外观。文件路径采用本地 Silkscreen 像素字体，中文回退到系统等宽字；章节标题继续使用正文界面字体。
- **冲突处理**：别的编辑器改过文件后，面板的保存会被拒绝并在底部给出「载入最新 / 用我的版本覆盖」，
  在你选择之前磁盘内容不会被覆盖。

颜色只走插件的主题桥（`--paper/--surface/--panel/--ink/--muted/--line/--teal/--error` 与
`--dsw-alias-*`），少数语义色用 `light-dark()`；因此跟随系统/DSH 的浅色与深色，正文与底色始终分离
（回执里有一条把 `prefers-color-scheme` 切到 dark 后比较计算样式与亮度的检查）。
布局上只有编辑器与预览两个滚动区；侧栏收起时工作台占满整页（不再留下一条侧栏宽的空白列——
此前 `.workspace[data-sidebar-side]` 的栅格会保留该列，而列内容被隐藏，看起来就是一条空白色带）。

外壳集成回执（真实 `src/server.mjs` 主机 + 真实页面 + 真实面板，12 项）：
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
