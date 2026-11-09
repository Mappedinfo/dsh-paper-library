# 领域研究与学者雷达

入口在 Paper Library 原有顶部工具栏的「领域研究」。这是同一插件、同一资料库中的原生界面，不启动另一个服务，也不复制论文数据库。

## 研究视野与个人阅读分开

「问题与方法」「学者与组织」「概念与脉络」「作品时间线」「来源与待核」共同展示一个研究主题。可记录定义和区别、研究者与发表时机构、何时何地的合作、研究重点、数据和评价条件、作品间的方法沿革。来源支持的事实、跨论文归纳与 AI 推断保留各自标记；未知当前任职不由历史署名推断。个人未读状态不会阻止快速 AI 分析。

文献候选通过 DOI、规范化题名或明确提供的本库 ID 核对。截断题名、多个版本、缺失与查询未完整分别提示。可直接打开原文献和既有知识笔记，不复制 PDF、不修改批注、不自动合并条目。

## 完整旧雷达

「完整学者雷达」承载原有学者/时间、机构/分组、待核线索、数据/覆盖四个视图，保留领域、主题、机构、身份和近期活动筛选、原影响口径及全部作品分页。来源更新与页面生成日期分开；本机路径显示为来源文字，不转成浏览器任意文件访问。

从明确的已有离线 HTML 导入，命令为：

```
node scripts/import-field-radar-snapshot.mjs /absolute/path/to/field-radar/index.html /absolute/path/to/library
```

只提取 radar-data JSON，存到当前资料库的 `.paper-library/field-radar-snapshot.json`。最多 6 MiB；不读取论文、不联网抓取。私有快照不进入源码、npm 包或公开示例。

## 主题 JSON 与更新

浏览器导入最多 1 MiB，导出保留完整字段。已有主题更新需在界面明确确认，并以当前 revision 写入；并发冲突不覆盖资料。存储复用资料库隔离的本机状态，内容分块和历史快照不可变。

基础结构：`schema_version:1`、`topic:{id,title,question,scope}`，以及 `sources`、`papers`、`scholars`、`claims` 四个数组。每项有稳定 `id`；论文、学者贡献和论断带 `source_ids`。来源含 HTTP(S) URL、标题、证据层级和实际核验日期，未知日期留空。扩展可使用 `concepts`、`distinctions`、`research_lines`、`organizations`、`relationships`、`method_lineage`。论文可记录 `datasets`、`evaluation`、`task_axes` 和 `evidence_scope`。所有嵌套来源与实体引用均校验，不按人名合并身份。

## AI 分析和自动化

「AI 自动分析」显式调用 DSH 已配置模型，分析当前主题保存的来源/摘录、论文和研究者资料，生成定义、概念区分、研究脉络、关系和缺口。结果单独保存为 AI 推断/待核对，不覆盖原主题，不伪装读过未提供的全文。可用既有 `library_paper_search` / `library_paper_read` / `library_paper_view` 定向取得原文证据，或复用原有后台整理流程，然后纳入主题再分析。

每次最多 180 KB 输入、8192 输出 tokens、120 秒。超限拒绝而非静默截断。持久 request_id 防止网络中断或重复点击重新消耗模型；查询状态不生成新内容。明确「重新分析」才创建新请求。独立预览可查看保存结果，但不会搜寻凭据或自行配置模型。

原生 DSH 工具：
- `library_field_radar`：list/get/match/analysis_get，只读。
- `library_field_radar_import`：明确导入并校验版本；工具请求上限 128 KiB。
- `library_field_radar_analyze`：依据主题版本和 request_id 分析。

工具与浏览器共享同一存储；导入和模型调用保留宿主原有审批行为。内置 `paper-library-radar` skill 描述流程。没有默认全网抓取、全库解析或新增定时任务。

HTTP 操作名为 `field_radar_list/get/import/match/snapshot_get/analyze/analysis_get`。浏览器不能通过通用 state 接口绕过证据写入校验。

## 验证

```
node --test tests-js/field-radar*.test.mjs tests-js/workspace-host.test.mjs tests-js/workspace-navigation.test.mjs tests-js/bundled-skill.test.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/field-radar-browser-fixture.mjs
npm run build
```

浏览器脚本使用独立合成资料库和模型替身，覆盖本机入口、筛选、原文献导航、单次 AI 生成、结果恢复、完整雷达回链和窄屏；不访问用户 PDF 或远程模型。真实宿主模型与运行中的 DSH 加载状态须另外核验。

## 后端绘图和图片导出

图片可以直接由 Node 后端生成，不需要打开网页、启动浏览器或解锁桌面。页面的「后端导出 PNG」、原生 `library_field_radar_render` 工具和 CLI 共用同一个绘图服务；主题版本、关键词/任务/年份过滤与页面使用同一纯数据模块。

支持 overview（研究地图）、timeline（作品时间线）、concepts（概念对照）、research-lines（研究脉络）、scholars（学者与机构）以及 PNG/SVG。每张图最多12条，1200–2400像素宽，返回总量、分页、来源ID、数据版本和生成时间；长字段显式省略，并在同名私有JSON中保留完整记录与来源。

```
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view timeline --format png --width 2400 --limit 12
```

可继续传 `--query`、`--task`、`--year`、`--offset`。只读取已保存主题，不发模型请求、不联网、不解析PDF，也不默认更新资料。图片及JSON保存于当前资料库的 `.paper-library/field-radar-exports/`，文件内容不可变并校验完整性，拒绝路径穿越、链接文件和超限输出。

HTTP调用 `field_radar_render` 返回受控的同源下载地址；下载路由只接受内容标识与PNG/SVG格式，不接受文件路径。原生工具/CLI还返回本机路径，供调用者通过自己已授权的附件渠道发送图片。导图不会自动公开上传或给第三方发送数据。正在运行的宿主需要重新加载插件后才能使用新接口；离线CLI立即可用。

Node consumers can import `renderFieldRadarSVG` and `createFieldRadarExporter` from `@mappedinfo/dsh-paper-library/field-radar-export`. The exporter accepts the existing library path and a topic-store adapter with `get(id)`; no browser or model is required.

The UI sends `expected_revision`; a stale loaded topic returns 409 rather than silently exporting changed data. Native/HTTP callers can pass the same field, and the CLI supports `--expected-revision HASH`.
