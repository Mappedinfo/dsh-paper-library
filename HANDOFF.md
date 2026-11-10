# Paper Library 当前交接

更新时间：2026-11-10（Asia/Shanghai）。本文件是唯一当前状态入口，不是逐轮聊天记录。

## 1. 接续时先做什么

1. 阅读项目 `AGENTS.md`、本文件；产品说明按需查 [README](README.md)。不要再次加载整段对话或历史归档。
2. 执行 `git status --short --branch`、`git log -5 --oneline`，确认当前源码及他人改动；下面的提交号是检查时基线，不保证下一轮仍是 HEAD。
3. 按用户最新请求选一条工作线，只读对应代码与证据。旧截图或旧失败不能直接当作当前复现结果。
4. 操作 DSH 前检查目标端口、运行进程归属、会话及写入/分析队列。不要用重启整个宿主代替插件热重载。
5. 交付时分别说明：源码、检查、运行中插件、当前浏览器页面、提交、排队、远端推送。它们是不同状态。

历史已移至 [HANDOFF.history.md](HANDOFF.history.md)。该文件约 298 KB，**不应默认读取**；需要旧任务证据时先 `rg -n '关键词' HANDOFF.history.md`，再读取命中附近的小段。npm 安装包未包含历史档案时，请在源码仓库查看。

## 2. 当前任务与实际状态

当前接受的任务：完善交接文件；同时完成上一条要求的 3080 插件热重载。

| 项目 | 已观察到的状态 | 仍不能据此宣称 |
| --- | --- | --- |
| 源码基线 | `main`，`64ce36c`；检查时领先本地 `origin/main` 24 个提交、工作树干净 | 未重新 fetch，不能当作远端实时差距 |
| 包版本 | `package.json` 为 `0.2.5` | 不代表 npm 已发布当前源码 |
| 本机插件来源 | web profile 中 `@mappedinfo/dsh-paper-library` 链接到本仓库 | 不代表其他 profile 或安装机也已更新 |
| 重载前运行检查 | `session/list`：运行中会话 0；分析/伴学队列无活动条目，留存失败条目 1；手写队列无待写入批次 | 留存失败条目没有在本轮重跑或修复 |
| 3080 热重载 | 调用 `pluginManager/setPluginEnabled`，`id=include:paper-library, enabled=true`；返回 `application=applied`、`warnings=[]` | `changed=false` 仅表示启用配置未改变，不是重载失败 |
| 服务端前端资源 | `workbench.js`、`reading-panels.js`、`app.js` 返回 200，逐字节与本地 `web/` 对应文件一致 | 不证明已经打开的 iframe 自动替换了内存中的旧脚本 |
| 当前浏览器页 | 未强制刷新，保留用户现场及未保存草稿 | 未执行真实界面编辑/保存验收 |
| Git 交付 | 文档链接与历史完整性已核对；限定文档提交并加入既有每日推送队列，提交号及排队结果以本轮交付/Git 为准 | 排队不是推送，不能宣称远端已同步 |

热重载核验时间为本轮 2026-11-10；只证明该时刻状态。没有停止 DSH、没有修改用户论文或清理失败任务。

## 3. 最近变更：完成到哪里

### 论文资料无法编辑/保存（`a7bf741`）

- 修复 PyMuPDF 1.28 下重复保存内嵌 `paper-library.csl.json` 报 `Name ... already exists`：更新现有附件流/xref，保留名称树、其他附件和批注；仍走备份及原子替换。
- 未注册阅读面板的可见性查询返回 false，避免页面初始化触发 `Unknown reading panel`。
- 元数据表单补齐卷、期、页码、出版者及草稿字段；APA 7 继续经 CSL 生成，缺失必要信息时可见提示，不伪造作者/DOI。
- 导入时对缺 DOI 且标题可靠的资料执行有界 Crossref 精确标题候选匹配；已有便携元数据不完整时补查。查询失败不能阻止原资料保留。
- 历史记录中的验证：50 项 Python、64 项编辑/导入/引用/面板、32 项元数据查询，共 146 项；构建和 diff 检查通过。本轮没有重跑这些未改动测试。
- 验证边界：合成 PDF 重复保存及附件保留已测；真实论文保存、真实网络补全及用户当前页面的交互未在本轮验收。

### 问题放置预检（`7d774d1`、`64ce36c`）

- 独立只读模块 `dsh_paper_library.placement_preflight`：按逐题登记、来源/版本/对象/用途、物理页、文件 hash、唯一原文和逐行 quad 检查计划。
- 22 项合成回归；不通过时不写 PDF。重复锚点不能任取首个；换行的多个 quad 不等于多个命中。
- `64ce36c` 修改的是 `skills/paper-library-notes/SKILL.md`：要求原生写入前先预检。**这是调用流程约束，不是所有宿主写入接口已强制接入。**
- 尚未改写真实旧批次，结构检查也不等于答案语义已核验。详见 [问题放置](docs/question-placement.md)。

### 阅读协议与模型/大纲

- `1e37300`：协议 v5 共 36 题，新增移动数据、建筑、方法命名等 13 题；旧 v4 宿主兼容、sessionId 传播及按问题范围打包。记录为 237 项合成检查；不证明任何私人论文集合已经读完。
- `73789bc`：PDF 原生书签大纲；无书签时按需、有界地扫描标题，不调用模型。设置中显示实际 provider/model，支持论文和语言工具分别选择，保护忙碌会话。
- 大纲/模型记录为 5 项 Python、38 项 JS及构建；真实 UI 尚待用户验收。
- `984c6f8`：原文默认四行预览；备注可展开，保持同一输入 DOM，避免切换时丢焦点。

其余已有能力包括原生矩形/自由笔画与回复、截图/图像说明、批注来源筛选和多关键词搜索、全文搜索与定位、全宽/整页、资源预算、收藏和层级标签、语言词条、图谱分页及引用关系。功能存在不等于所有旧问题均已在当前宿主复测；证据按对应主题查历史或测试。

## 4. 下一步优先级与完成判据

1. **交接检查已完成**：本文件相对链接均存在，归档完整包含整理前的原始字节，`git diff --check` 通过；本轮限定文档提交并排队。无需为纯文档整理重跑全套应用测试。
2. **用户现场刷新后的元数据验收**：用户先处理未保存草稿，再刷新 Paper Library。确认选中条目能打开正确表单，连续保存不报附件重名，重开仍保留修改；若需要写真实论文，严格沿用用户授权范围，保留备份。
3. **若继续排查编辑问题**：区分旧页面缓存、阅读面板错误、元数据附件写入、状态版本冲突；先取实际错误和请求结果，不能仅凭截图重新实现已经修过的功能。
4. **若继续 DOI/APA 完整性**：用合成测试覆盖字段传播、候选不唯一/无匹配/网络失败；真实补全只在授权文献范围进行。DOI 缺失不等于无 DOI，资料齐全前不承诺完整 APA。
5. **旧分析任务**：本轮只确认没有活动任务；留存失败记录未诊断，不自动重启全文分析，不恢复全部旧批次。用户再次要求时先读任务状态/覆盖结果，再做有界恢复。

旧对话中提出过的大量特性不应全部重新排成待办。是否完成需查当前实现与相关回执；最新明确要求优先。

## 5. 代码与资料导航

| 工作线 | 首选入口 |
| --- | --- |
| 产品/安装/许可证 | [README](README.md)、[英文说明](README.en.md)、[第三方许可](THIRD_PARTY.md)、`package.json` |
| 宿主注册、工具与服务 | `src/harness/index.mjs`、`cordis.patch.yml`、[API](docs/api.md) |
| 论文伴学/全文整理队列 | `src/harness/companion-queue.mjs`、`src/harness/paper-analysis-queue.mjs`、[无界面分析](docs/headless-analysis.md) |
| 分析问题与兼容 | [问题协议](docs/reading-questions.md)、[兼容说明](docs/research-os-compatibility.md) |
| PDF/元数据/批注 Python | `src/dsh_paper_library/`；按函数或报错文本搜索，避免整包读取 |
| 导入、元数据查找、APA | `src/import-pdf.mjs`、`src/paper-fetch.mjs`、`src/citations.mjs` |
| 阅读及表单界面 | `web/app.js`、`web/workbench.js`、`web/reading-panels.js`；先定位函数再读 |
| 本地状态和手写队列 | `src/local-state.mjs`、`src/ink-queue.mjs` |
| 公式与元素提取 | [公式识别](docs/formula-detection.md)、[自动解析](docs/auto-parse-flow.md) |
| 图谱/阅读证据放置 | [问题放置](docs/question-placement.md)、`src/dsh_paper_library/` 和对应图谱前端 |
| Slides / PlainDeck | [演示工作台](docs/slides-workbench.md)、`src/slides/`、`vendor/plaindeck/` |
| 领域研究 | [Field Radar](docs/field-radar.md) |
| 验证证据 | [回执索引](docs/validation/README.md)、`tests/`、`tests-js/`、`scripts/` |

`docs/validation.md` 及回执可能对应旧日期；检查时间、输入、模拟模型/真实模型、代码版本后再引用。单个成功回执不能证明当前所有功能可用。

## 6. 3080 热重载操作约定

- 本机 DSH 源码位于此仓库同级组织以外的 `deepseek-ai/deepseek-harness` 仓库；优先读取其当前运维说明和 plugin-manager 实现，接口可能变化。
- 本轮 web profile 的包是源码 symlink，Python worker 按需启动；静态文件按请求读取；已加载的宿主 JavaScript 需要热重载，已打开的浏览器还可能保留旧脚本。
- 宿主身份及一次性入口由明确的 `$DSH_HOME/web-url` 读取，仅在进程内部交换 cookie。**不要打印 URL token、cookie、模型凭据或整份宿主配置。**
- 已验证 RPC：`pluginManager/listPlugins`、`session/list`、`pluginManager/setPluginEnabled`。只操作 `include:paper-library`，保持 `enabled=true`；不先禁用，不重启全宿主。
- RPC 请求为 `POST /api/<method>`，JSON 包含 `type: client-request`、唯一 `rpcId`、`method`、`payload.args`；会话查询用 `{_request:{}}`。重载调用参数 `{id:"include:paper-library",enabled:true}`。
- 插件 API 为 `POST /api/paper-library/api`，如 `{action:"ink_queue_list"}`。仅输出状态/计数，不输出笔画、批注全文或模型配置。
- 分析/伴学状态在 `$DSH_HOME/paper-library/<libraryId>/state`；libraryId 由规范化库路径派生，勿硬编码或把私人状态提交到源码库。
- 若存在 running session、queued/preparing/sending/reading/generating/committing 或未保存手写，等空闲再重载；不能清空任务伪造空闲。历史 failed/uncertain 应分别交代。
- 返回 `application=applied` 且无异常，再检查插件 API 与静态资源；若是 restart-required 或错误，不能说成功。
- 刷新页面前保留草稿；有冲突提示时，不以刷新或覆盖远端数据消除提示。新版脚本已提供不代表用户当前页面已加载。

## 7. 检查与 Git 收尾

按改动选择最小充分检查，不默认全套：

```sh
# JS 元数据、导入、APA、面板相关回归
node --test tests-js/paper-metadata.test.mjs tests-js/import-pdf.test.mjs tests-js/citations.test.mjs tests-js/reading-panels.test.mjs tests-js/metadata-lookup.test.mjs
# 只读放置预检回归（项目环境）
uv run python -m pytest tests/test_placement_preflight.py
# 改动构建相关资源时
npm run build
# 所有源码/文档交付前
git diff --check
git status --short --branch
```

测试仅用合成文档；不把真实用户论文当测试夹具。上面是复跑入口，不表示本轮已全部执行。前端一般交用户手动检查，只有明确要求时做交互/视觉验收。

验证后仅暂存本任务路径，自动提交；按用户全局 Git 工作流加入既有每日推送队列。不新增调度器、不强推、不顺带提交私人库或运行依赖。明确要求立即推送时才按该任务授权正常推送，并核对远端结果。

## 8. 必须保留的工程边界

- 这是独立 DSH 插件，不是 Zotero 扩展。受管文献和私人目录在用户选择的位置、Git 之外；不改导入原件或实时 Zotero 数据库。
- 批注为标准 PDF 对象，读回以 PDF 为准，不能靠目录数据库中的批注副本补出结果；保留外部批注与附件。写入前备份，序列化重开验证后原子替换。
- Python 按需启动；不常驻 PDF 引擎、不默认嵌入模型、不后台全库解析。页面渲染、结果、缓存、队列与并发均有界；资源预算不是整个应用 RSS 的硬保证。
- 宿主模式复用已配置模型；独立入口只用调用者明确指定的配置和凭据，不扫描私人配置找密钥。模型图像能力以实际配置/请求结果验证，不能只凭名称断言。
- 元数据错误必须可见；APA 使用 CSL；不得编造作者、日期、DOI或把缺失字段静默当完整资料。
- AI 输出、推断、原文、人工备注明确区分。分析覆盖按问题/页面/失败项报告，不能用批注数量充当完成证明。
- 原创代码 MIT；PyMuPDF 默认运行时 AGPL/商业许可，CSL 等保留单独许可，不能宣传为整套 MIT-only。

## 9. 后续如何维护本文件

- 每次只替换当前状态、最近变化、下一步及其证据；不要在顶部无上限追加长段。
- 目标 200 行以内、约 15 KB 以内。详细设计进专门文档，验证数据进对应回执，历史经过进归档；本文件只留可检索锚点。
- 每条完成状态注明源码提交或检查入口，并区分历史记录/本轮执行、合成/真实、服务端/浏览器。
- 不把私人 PDF 路径、鉴权入口、完整任务输出、凭据、临时脚本堆进公共交接。
- 接近上下文上限时先写入已观察结果、当前未完成动作及下一步判据，再继续；避免下一轮重新读全库、重做已通过检查或重复询问授权。
