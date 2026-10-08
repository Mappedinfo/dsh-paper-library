# 本地 Overleaf 调研与我们的 LaTeX 工作台优化

调研目的：弄清「本地 Overleaf」这条产品线上各家到底做到了什么（仓库、许可证、真实特性均逐一核实），
对照 dsh-paper-library 的 LaTeX 工作台找出最有价值的缺口，并把已落地的优化记录下来。

## 一、核实后的生态格局

所有条目都打开过仓库 README 核实（2026-02，GitHub）。分三类：官方自托管、第三方协作替代、
本地优先单人编辑器。

### 官方自托管

- **Overleaf Community Edition / Server Pro**（[overleaf/toolkit](https://github.com/overleaf/toolkit)）：
  官方 Toolkit 基于 docker compose 部署 CE 5.0。功能最全（协作、历史、审阅），但整套栈
  （MongoDB、Redis、多个服务）对「个人本地写作」过重；默认 TeX Live 不全，常需自定义镜像。

### 第三方协作替代（都走 CRDT/实时协作 + Docker）

| 项目 | 仓库 | 许可证 | 核实到的关键特性 |
| --- | --- | --- | --- |
| Aldine | [trahloff/Aldine](https://github.com/trahloff/Aldine) | AGPL-3.0 | Yjs 实时协作、每个项目一个 Git 仓库、Zotero 同步、SyncTeX、约 2 秒增量重编译 |
| TeXlyre | [TeXlyre/texlyre](https://github.com/TeXlyre/texlyre) | AGPL-3.0 | local-first（Yjs + IndexedDB 离线），LaTeX 与 **Typst** 双语种，React 前端 |
| TexLite | [SWUFE-DB-Group/TexLite](https://github.com/SWUFE-DB-Group/TexLite) | AGPL-3.0 | 轻量，SQLite 存储，面向小型可信团队（npm 包名 `texlite`） |
| FlowTex | [stolucc/flowtex](https://github.com/stolucc/flowtex) | 未声明（无 LICENSE 文件） | 协作 + SyncTeX 正反向 + **WYSIWYG 模式** + 基于 latexdiff 的 tracked changes |
| Scribe | [sunnyallana/Scribe](https://github.com/sunnyallana/Scribe) | AGPL-3.0 | React + Rust（Tauri 2 桌面端），README 在 master 分支 |

### 本地优先单人编辑器（与我们的场景最接近）

- **OpenLeaf**（[vicky157/openleaf](https://github.com/vicky157/openleaf)，MIT）：完全本地运行、
  Overleaf 式界面、实时预览、SyncTeX，明确不做协作。
- **Aurora**（[ntenhundfeld/aurora-LaTeX](https://github.com/ntenhundfeld/aurora-LaTeX)）：
  离线桌面编辑器，模板 + 一键编译。
- 传统路线：TeXstudio / VS Code + LaTeX Workshop + Git，成熟但不在浏览器里、没有 Agent 接口。

## 二、对照我们工作台的差距分析

我们的 LaTeX 工作台（`docs/latex-projects.md`）已是独立整页：源码左、PDF 右、自动保存、
自动编译、历史/版本对比、DSH 写作侧栏（提问 + 提案先审后写）。把上表逐项对照：

| 能力 | Aldine/TeXlyre/FlowTex | OpenLeaf | 我们（调研前） |
| --- | --- | --- | --- |
| 实时协作（CRDT） | 有 | 无 | 无（单人 + Agent，本来就不是目标） |
| Git/历史 | Git 仓库 | 无 | 有（每文件 ≤40 版 CAS 历史 + diff） |
| AI 辅助 | Aldine 有 | 无 | 有（侧栏提问、提案审后写）——**差异化优势** |
| **SyncTeX 双向跳转** | 有 | 有 | **无 —— 最明显的功能缺口** |
| WYSIWYG / tracked changes | FlowTex 有 | 无 | 无（投入大，与纯文本 + Agent 提案路线重复） |
| Typst | TeXlyre 有 | 无 | 无（可观察，暂不值得） |

结论：**SyncTeX 双向跳转是唯一边界清晰、收益确定的缺口**——它是 Aldine/OpenLeaf/FlowTex 三家
共同的招牌特性；而我们的编译始终带 `-synctex=1`，`.synctex.gz` 一直在磁盘上却没人用，
本机 `synctex` CLI（TeX Live/MacTeX 自带）直接可用。协作、WYSIWYG、Typst 要么与单人 + Agent
定位冲突，要么投入产出不合理，明确不做。

## 三、已落地的优化：SyncTeX 双向跳转

- **后端**（`src/dsh_paper_library/latex.py`）：新增 `latex_synctex_edit`（PDF 上一点 → 源文件 +
  行号）与 `latex_synctex_view`（源文件某行 → 页码 + 高亮矩形）两个只读动作。坐标沿用工作台
  已有的「显示态 PDF 点、左上角原点」约定（`latex_pdf_pages` 同一坐标系），位图缩放比例换算即可。
  防护：路径 realpath 后必须在项目目录内（synctex 会指向 TeX 系统样式文件）；旋转页拒绝映射；
  行号/列号/坐标严格校验，报错都是中文且说明原因。桥接白名单 16 → 18 个动作。
- **前端**（`web/latex-workspace.js`）：**双击 PDF** 反向跳到源码行（跨文件先落盘再切换，选中整行
  并滚到可视区）；预览页头 **⇥ 按钮**把光标所在行正向定位到 PDF，闪烁高亮约 2.6 秒。
- **实测语义**（真实 xelatex 编译 + synctex 1.5 验证）：synctex 两个方向都是**就近匹配**——
  空白处点击会吸附到最近源码行而非报错；`view` 可能返回多个结果块，取第一块。PDF 早于修改时
  位置可能偏移，与所有 SyncTeX 编辑器行为一致，重新编译即恢复。
- **测试**：`tests/test_latex.py` 新增 4 项（真实编译 round-trip、无 SyncTeX 数据的明确报错、
  路径与数值守卫、就近匹配语义）；JS 套件桥接计数同步到 18。全套件通过（Python 439 / JS 无新增失败）。

## 四、仍未做、及原因

- **实时协作**：与「单人本地 + Agent 协作」的定位冲突，且需要 CRDT 基础设施；Aldine/TeXlyre 已覆盖。
- **WYSIWYG / latexdiff tracked changes**（FlowTex 路线）：提案先审后写已覆盖「修改可见、可拒绝」
  的核心诉求，再加一层所见即所得编辑器投入过大。
- **语法高亮、选区→提问**等面板增强仍在 `docs/latex-projects.md` 的「下一步」里，优先级低于
  本次的跳转闭环。
- **Typst 支持**：TeXlyre 证明有需求，但需要第二套编译与预览管线，暂观察。

## 五、部署建议（给需要完整协作的人）

若确实需要多人实时协作：团队场景选自托管 **Overleaf CE**（Toolkit 部署）或 **Aldine**
（Git 工作流友好）；个人离线写作留在本工作台即可——SyncTeX 补齐后，与 OpenLeaf 这类
本地编辑器的功能差已基本消除，且多了 Agent 写作侧栏与文献库联动。
