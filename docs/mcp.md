# draw.io 互通与我们自己的 MCP

这份文档记录三件事：官方 draw.io MCP 的许可证核查（先后顺序上它决定了后面能不能参考）、我们观察到的 `.drawio` 格式契约与互通范围，以及本仓库自己的 MCP 服务器（`mcp/server.mjs`）的边界与工具面。它是**观察与设计记录**，不是把对方代码引入本仓库：我们只把 `@drawio/mcp` 装到本地（gitignored 的 `.local/`）跑过一次，用来读它的工具面与文件写法。

## 1. 许可证核查

结论：**可以**。`jgraph/drawio-mcp` 与 npm 上的 `@drawio/mcp` 都是 Apache-2.0，与本项目的 MIT 兼容；我们参考其实现逻辑、按自己的代码重写，没有复制文件。

三条互相独立的证据（可随时复核）：

```bash
# ① npm 元数据
npm view @drawio/mcp license version
#   license = 'Apache-2.0'
#   version = '1.6.1'

# ② GitHub 仓库元数据
curl -s https://api.github.com/repos/jgraph/drawio-mcp | python3 -c "import json,sys;print(json.load(sys.stdin)['license'])"
#   {'key': 'apache-2.0', 'name': 'Apache License 2.0', 'spdx_id': 'Apache-2.0', …}

# ③ 实际安装到的包
node -e "console.log(require('./.local/drawio-ref/node_modules/@drawio/mcp/package.json').license)"
#   Apache-2.0
```

安装位置 `.local/drawio-ref/` 被 Git 忽略，它不是本项目的依赖：`package.json` 里没有 `@drawio/mcp`，发布包里也不含它。Apache-2.0 的要求是保留版权与许可声明**如果**分发了它的代码；我们没有分发，所以这里只做记录。若将来真的要复制它的任何文件，必须同时带上其 LICENSE 与 NOTICE，并在 [THIRD_PARTY.md](../THIRD_PARTY.md) 增加一行。

它自己的依赖是 `@modelcontextprotocol/sdk@^1.27.1` 与 `pako@^2.1.0`；我们两者都没有引入。

## 2. 对方的工具面（实测）

```bash
node scripts/mcp-probe.mjs .local/drawio-ref/node_modules/@drawio/mcp/src/index.js
# server: {"name":"drawio-mcp","version":"1.6.1"} | protocol: 2025-06-18
# tools: 7
#   - open_drawio_xml(content, lightbox, dark, postLayout, direction, routing) required=content
#   - open_drawio_csv(content, lightbox, dark) required=content
#   - open_drawio_mermaid(content, postLayout, lightbox, dark) required=content
#   - list_pages(path) required=path
#   - get_page(path, page) required=path+page
#   - set_page(path, page, content) required=path+page+content
#   - search_shapes(query, limit) required=query
```

前三个工具把 XML／CSV／Mermaid 交给 draw.io 网页版打开，后四个是**文件级**读写：列页、读页、写页、查形状库。我们参考的正是后四个的形态——把一个文件暴露给模型，读写都要能说清“动的是哪一页”。

## 3. `.drawio` 格式契约（实测）

- 一个 `.drawio` 文件是 `<mxfile host="app.diagrams.net">`，里面一页一个 `<diagram id name>`；页体是 `<mxGraphModel>…<root><mxCell id="0"/><mxCell id="1" parent="0"/>…`，`0`/`1` 是 draw.io 自己的两个根单元格。
- **两种页体**。他们的 `set_page` 写**未压缩**的 XML；draw.io 网页版自己保存时写**压缩**形式：`encodeURIComponent(xml)` → raw DEFLATE → base64，整段 base64 就是 `<diagram>` 的内容。判断方法是“内容去掉空白后是否以 `<` 开头”，这也是他们 `pages.js` 里 `isLikelyCompressed` 的规则。
- 页可以用**序号、id 或名字**寻址；我们的 `parse(xml, { page })` 三种都收。
- 形状在 `style` 里：`shape=note`／`ellipse`／`rhombus`／`text`，圆角是 `rounded=1`，图形库是 `shape=mxgraph.*`；连线是 `edge=1` 加 `source`/`target`，路由是 `edgeStyle=orthogonalEdgeStyle`，箭头在 `endArrow`/`startArrow`，拐点在 `<Array as="points">` 里的 `<mxPoint>`。
- 多行文本写成 `&#10;`，所以实体解码必须处理数字引用。
- 他们的 `assertPagePath` 只检查扩展名（`.drawio`／`.xml`），路径本身不限定目录；写入是“先写临时文件再改名”。我们两处都收紧了：见第 5 节。

### 互通范围

我们把对方格式当作**第三种入口**接到画板既有的「校验并应用」路径上（另外两种是手写源文件与 Mermaid）。读了什么、写成什么，都在 `web/board-drawio.js` 里，测试在 `tests-js/board-drawio.test.mjs`（8 项），浏览器回执在 `docs/validation/board-browser.json` 的 `a-drawio-file-opens-here-and-this-board-writes-back-as-drawio`。

| draw.io | 本画板 |
|---|---|
| `id`（节点） | 节点 `id`（同一套标识规则，原样保留） |
| `value` | 节点 `text` / 连线 `label` |
| `mxGeometry x/y` | 节点 `pin`（固定位置） |
| `mxGeometry width/height` | 样式辅助文件 `style.node.byId[id] = {w,h}` |
| `rounded=1` / `shape=ellipse` / `rhombus` / `note` / `text` | 形状 `concept` / `ellipse` / `diamond` / `note` / `text` |
| `edgeStyle=orthogonalEdgeStyle` | 连线 `kind: "elbow"` |
| `endArrow`/`startArrow` | 连线 `arrow: forward｜none｜both` |
| `dashed=1` | 连线 `dashed` |
| `<mxPoint>` 拐点 | 连线 `waypoints` |
| `shape=mxgraph.*`（图形库图标） | 按矩形导入，并在面板里**点名报告** |

draw.io 没有概念的字段用我们自己的 style 键随文件同行，所以经过 draw.io 往返不会丢：`plbKind`（形状）、`plbPaper`/`plbPaperTitle`/`plbPaperYear`/`plbPaperCitekey`（文献绑定）、`plbRelation`（关系词）、`plbAngle`（连线夹角）、`plbProposed`（仍是 AI 提议）。未知 style 键会被 draw.io 原样保留，这正是它成立的原因。

两条**诚实的限制**，都在测试里写明而不是含糊过去：

- 源文件格式里没有连线 `id` 字段（画板模型自己发 `s-e1`…），所以 draw.io 的连线单元格 id 不会穿过往返。导出时若连线还没有 id，我们按 `e-1`、`e-2`… 生成并避开已被占用的标识；重名直接报错，不悄悄改名。
- 压缩页需要解压能力。宿主提供：浏览器用 `DecompressionStream('deflate-raw')`，Node 侧用 `zlib.inflateRawSync`；没有解压能力时报“需要宿主提供解压能力”，而不是给出一块空画板。

我们**只写未压缩**的 XML：本项目的产物要求可读、可 diff。

## 4. 界面上的位置

画板「☰ → 源文件与来源 → draw.io」：粘贴 XML 或「打开 .drawio」选文件 → 「解析为源文件」把内容与样式填进两个编辑框（draw.io 自己保存的压缩页会先解压）→ 仍然只有「校验并应用」会改动画板。反方向是「画板导为 draw.io」与「下载 .drawio」。无法表达的部分（图形库形状、swimlane、没有几何信息的单元格、不合规标识、悬空连线）逐条带行号显示在状态栏里，不会静默变成矩形。

## 5. 我们自己的 MCP 服务器

`mcp/server.mjs`，stdio、零依赖、无网络、无模型、无 worker。它把本项目**自己的可读文件**暴露给任何 MCP 客户端（Claude Desktop、Cursor、DSH 之外的宿主）：

```jsonc
// 客户端配置示例：画板目录 + 文献库，都只读
{
  "mcpServers": {
    "paper-library": {
      "command": "node",
      "args": ["/path/to/dsh-paper-library/mcp/server.mjs", "--root", "/path/to/boards", "--library", "/path/to/library"]
    }
  }
}
```

命令行（`node mcp/server.mjs --help`）：

| 参数 | 含义 |
|---|---|
| `--root <目录>` | 允许访问的画板文件目录，可重复。 |
| `--library <目录>` | 文献库目录。给出后增加三个**只读**文献工具；`--root` 与 `--library` 至少要有一个。 |
| `--write` | 打开画板写工具。默认只读，只读会话里写工具**不在工具表里**。 |

不给 `--library` 时 3 个工具，给了是 6 个，再加 `--write` 是 8 个：

| 工具 | 作用 |
|---|---|
| `list_boards()` | 列出根目录下的画板源文件（`paper-library-board.v1`）及样式辅助文件是否存在。 |
| `read_board(path, outline?)` | 读源文件与 `.style.json`，按**应用自身的规则**校验，给出 sha256 修订号与压缩大纲。 |
| `read_drawio(path, page?)` | 把 `.drawio`／XML 读成源文件与样式（压缩页自动解压），无法表达的逐条报告。 |
| `search_papers(query?, limit?)` | 按题名／作者／DOI／标签检索文献库（1–50 条，默认 20）。只读。 |
| `read_paper(id)` | 读一篇文献的元数据。只读。 |
| `read_annotations(id, annotation_ids?)` | 批注目录；给出标识时读这些批注的原文与批注内容。只读。 |
| `write_board(path, source, style?, expected_revision)` | 先校验再原子替换；文件已存在时必须给出当前修订号。 |
| `write_drawio(path, source, style?, title?, expected_revision)` | 写成未压缩的 `.drawio`；同样按修订号做 CAS。 |

边界规则，与第 3 节里对方做法的差异都写在这里：

- **路径必须落在 `--root` 里**，而且分两步解析：父目录走 `realpath`（挡掉 `..` 与符号链接目录），已存在的文件本身也走 `realpath`（挡掉指向根目录之外的符号链接）。扩展名限定 `.json`（画板）与 `.drawio`／`.xml`（图）。外部目录请再给一个 `--root`，不要靠链接绕过去。
- **只读是默认值**。写工具在只读会话里不是“调用被拒”，而是根本不在工具表里。
- **写入是 CAS + 原子**：`expected_revision` 是文件当前内容的 sha256（新建时给 `null`），不匹配就拒绝并说明当前值；写入先落临时文件再 `rename`，读者看不到半个文件。
- **校验用的是应用自己的规则**，不是服务器里另写的一套：`web/board-source.js`（源文件与样式）与 `src/harness/board-store.mjs`（画板文档、上限、大纲）在服务器进程里直接加载复用。写不进去的内容永远不会落到磁盘上。
- **文献库只读，而且没有第二个读者**：三个文献工具复用插件自己的传输层（`src/bridge.mjs` → `.venv` 里的 `dsh_paper_library.worker`），只放行 `resource_list`／`get`／`annotation_catalog`／`annotation_context_exact` 这几个读动作。写文献库、写批注、导入仍然只属于插件在 DSH 会话里的工具；本服务器不碰 SQLite，也不需要 SQLite 驱动。
- 拒绝是一种**回答**：路径越界、扩展名不符、修订号冲突、文件不存在都以 `isError` 的工具结果返回并说明原因，不崩、不断流；未知方法回 `-32601`，未知工具回 `-32602`，坏 JSON 回 `-32700`。

### 验证

```bash
node --test tests-js/mcp-server.test.mjs          # 6 项：真实子进程 + 真实管道
node scripts/mcp-probe.mjs mcp/server.mjs --root <目录> [--library <文献库>]
```

单元测试用的是真的 stdio 子进程（不是桩），覆盖：握手与工具表、只读会话里没有写工具、画板与两种 `.drawio`（他们写的未压缩页 + draw.io 自己保存的压缩页）的读取与校验、越界／扩展名／缺失／**符号链接逃逸**的拒绝、写工具的正例与修订号冲突、不加 `--library` 时文献工具不存在、加 `--library` 后三个文献工具能真的检索到合成文献库并读回元数据与批注目录、根目录／文献库目录不存在或缺参数时以退出码 2 失败。文献部分与 `python_tests` 前提相同（需要本仓库的 `.venv`），缺环境时该用例跳过而不是假装通过。

### 与插件原生工具的关系

插件在 DSH 会话里的原生工具（`library_board_*` 等）走宿主记录与模型服务，是画板的**主入口**；这个 MCP 服务器面向仓库里的**文件**（可读源文件、`.drawio`），给 DSH 之外的客户端用。两者共用同一套校验与格式，不共享状态：MCP 服务器不读 `$DSH_HOME` 里的画板记录，也不调用模型。
