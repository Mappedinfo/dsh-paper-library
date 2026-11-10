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

图片可以直接由 Node 后端生成，不需要打开网页、启动浏览器或解锁桌面。页面的「预览图表」「后端导出 PNG / SVG」、原生 `library_field_radar_render` 工具和 CLI 共用同一个绘图服务；主题版本、关键词/任务/年份过滤与页面使用同一纯数据模块。

「图表与地图」在同一领域研究页提供图种选择、频次字段、年度分组、SVG 预览和 PNG/SVG 下载；继续使用关键词、任务和年份筛选。预览在筛选、图种、分组或频次字段改变后失效并回到第一页，需重新生成，避免旧图误代表当前范围。图下的「上一页图表 / 下一页图表」按回执覆盖范围翻页，导出使用当前图表页，不影响作品列表分页。

支持 overview（研究地图）、timeline（作品时间线）、concepts（概念对照）、research-lines（研究脉络）、scholars（学者与机构）以及 frequency（任务/方法/数据集频次）、publications（年度堆叠发表量）、citations（已核验有向引用网络）、geography（研究地区与空间数据）。支持 PNG/SVG。记录型图每张最多12条，1200–2400像素宽，返回总量、分页、来源ID、数据版本和生成时间；长字段显式省略，并在同名私有JSON中保留完整记录与来源。

```
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view timeline --format png --width 2400 --limit 12
```

可继续传 `--query`、`--task`、`--year`、`--offset`。只读取已保存主题，不发模型请求、不联网、不解析PDF，也不默认更新资料。图片及JSON保存于当前资料库的 `.paper-library/field-radar-exports/`，文件内容不可变并校验完整性，拒绝路径穿越、链接文件和超限输出。

HTTP调用 `field_radar_render` 返回受控的同源下载地址；下载路由只接受内容标识与PNG/SVG格式，不接受文件路径。原生工具/CLI还返回本机路径，供调用者通过自己已授权的附件渠道发送图片。导图不会自动公开上传或给第三方发送数据。正在运行的宿主需要重新加载插件后才能使用新接口；离线CLI立即可用。

Node consumers can import `renderFieldRadarSVG` and `createFieldRadarExporter` from `@mappedinfo/dsh-paper-library/field-radar-export`. The exporter accepts the existing library path and a topic-store adapter with `get(id)`; no browser or model is required.

The UI sends `expected_revision`; a stale loaded topic returns 409 rather than silently exporting changed data. Native/HTTP callers can pass the same field, and the CLI supports `--expected-revision HASH`.


### 图表统计与证据边界

- `frequency` 用 `frequency_by:task|method|dataset` 选择字段，默认 task。按当前筛选内文献计标签频次，多标签可能使总和大于文献数；不将缺失数据当零。
- `publications` 用 `group_by:subtopic|task|research_group` 选择年度堆叠分组。页面默认 subtopic；研究组只采用明确记录，不由共同作者或单位自动识别稳定团队。一篇归属 k 个类别时，每类计 1/k，年度堆叠总量仍为文献数；不是每组各计一篇的整数排名。缺少年份或分组在回执中说明。
- `citations` 只绘制明确、带来源、已核验的有向引用边。引用次数不等于引用关系，方法沿革也不等于真实引用网络。
- `geography` 只使用明确提供的坐标、GeoJSON 或空间数值。只有研究区位置时显示研究区，不能称为原始轨迹密度；只有地区名、没有坐标或边界时显示缺失说明，不自动猜坐标或抓取底图。

HTTP/原生渲染回执包含 `available`、`warnings`、`coverage`，页面同时显示不可用状态和具体缺失说明。完整数据和来源仍保留在私有导出 JSON 中。所有图表都反映收录样本而非全领域普查，不对缺失年份、引用或坐标进行补造。

自动化导图例子（读取同一资料库中的已保存主题，不新建工具台）：

```
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view publications --group-by research_group --format svg
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view frequency --frequency-by dataset --format png
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view citations --format svg
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view geography --format png
```

执行后先检查 available、warnings 和 coverage，再交付图与回执；数据不可用时明确列出需要补充的证据。命令行可供已获授权的工作流调用，但不会自行安排周期运行。

### 可复用的图表输入字段

- 真实研究组：`research_groups:[{id,name,paper_ids,source_ids,status:"verified"}]`。小主题使用既有 `groups` 或 `research_lines`。方法标签优先 `papers[].method_tags`，否则使用 method；数据集使用 datasets/dataset。同篇同类去重。
- 引用边：`citations:[{id,source_paper_id,target_paper_id,source_ids,status:"verified",section?}]`，箭头从引用者指向被引用者。既有关系只有明确 `explicitly_cites_as_background` 才可作为引用边。
- 引用数：`papers[].citation_metrics:[{count,provider,as_of,source_ids}]`；不同平台及统计日期不混成一个数字，也不推导成网络边。
- 研究区：`study_areas:[{id,name,paper_ids,source_ids,geometry,precision}]`。
- 空间观测：`geo_observations` 与研究区字段相同，另需有限数值 `value`、`metric` 和 `unit`。不得混用不同指标/单位来比较数值。
- 可选底图几何：`map_context` 需要 geometry、source_ids、precision，不要求 paper_ids。不会自动下载或伪造底图。

geometry 使用 WGS84 GeoJSON `Point|LineString|Polygon|MultiPolygon`，coordinates 顺序是经度、纬度。precision 说明位置精度及研究区性质；所有来源 ID 必须存在。每个空间集合最多 500 条，总坐标点最多 12000。当前使用等距圆柱投影；跨日期变更线的线/面须预先切分，不能用跨全球的直线代替真实边界。未获取原始空间数据时，允许只提供有来源的研究区几何并明确标注；无几何时保留地区提及和缺失说明。

coverage 提供 papers、corpus_papers、frequency_missing、unknown_year、unclassified、citation_edges、citation_counts_known、mapped_papers、study_areas、observations、place_mentions，用于核对当前筛选与缺失范围。


## 中文与全英文图表版本

图表工具栏可选「中文为主 / Chinese + English」或「English only」。默认 `language:zh` 保留原有中文为主、英文术语混排；`language:en` 用于英文汇报。切换语言保留关键词、任务与年份筛选，图表回到第一页并要求重新预览。预览、PNG/SVG 导出及回执使用同一语言；此选项控制图表版本，不改写原始研究资料或其他阅读页面，当前界面会话中保留选择。

```
node scripts/export-field-radar.mjs --library /absolute/path/to/library --id synthetic-topic --view publications --language en --format svg
```

HTTP/原生工具同样传 `language:"en"`，回执返回 language。英文图中的实体/来源文字使用主题内的明确翻译映射：

```json
{"translations":{"en":{"labels":{"轨迹预测":"Trajectory prediction","城市研究组":"Urban research group"}}}}}
```

映射键必须对应保存证据中的原始字符串，译文忠实保留原意、数字、人物身份与不确定性。渲染是确定性的本机操作，不调用模型自动翻译。中文字段缺少映射时，全英文版使用中性实体 ID 或 `Translation unavailable` 并报告缺失，不把未翻译中文混进英文图，也不创造英文事实。为汇报准备翻译时，应核对证据并通过已有主题导入/版本校验保存映射，保留原始字段及来源不变。切勿将替代标记当成已完成译文。

## 内置多维关系（离线 relations.html 的安全接入）

「领域研究 → 多维关系」在现有界面中重建离线关系报告的桑基图、逐篇圆形轨道、中英切换、维度筛选和来源记录。无需新服务，不载入、不执行用户提供的 HTML/JavaScript。输入必须是该报告的结构化 companion `relation-input.json`，由随插件发布的通用渲染器生成 SVG。原 HTML、PDF 与主题 JSON 均不改动。

关系快照与当前主题选择独立，明确显示独立快照提示。每库保存一份当前关系快照，使用既有本机状态库、内容寻址分块与 revision 比较写入；旧分块保留。源日期保留在逐条来源中，导入日期不冒充研究更新日期。筛选只高亮相关图形，桑基宽度与标签始终对应完整快照；逐篇记录每页最多 20 项，中英文切换保持筛选。维度共现不是因果或单篇唯一路径，历史署名分组不证明当前团队身份。来源中的本库 ID 先经现有论文匹配接口核对，唯一且完整匹配后才打开。

私有导入 CLI（首次版本为 `0`，更新必须使用读取返回的 revision）：

```
node scripts/import-field-radar-relations.mjs /absolute/relation-input.json /absolute/library 0 /absolute/dsh-state-home
```

末尾 state home 可省略，此时沿用 `DSH_HOME`/默认 home；必须与当前宿主的 `localStateHome` 一致。CLI 不读取宿主凭据，不猜配置路径。可通过现有认证 API 调用 `field_radar_relations_get` 和 `field_radar_relations_import`，后者参数为 `{document,expected_revision}`。get 返回 document、revision、digest、updated_at；import 返回保存回执。通用浏览器 state 接口不能写这些保留命名空间。

输入 schema_version 为 1，包含 title/scope（文本或 zh/en 标签）、sources、dimensions（id/label/categories）、records（id/title/source_ids/values/evidence）及可选 relationships/config。来源和关系引用须存在；标识符、颜色和 HTTP(S) 链接严格校验。限制 1 MiB、2–6 维、每维最多 24 类、1–200 篇、1000 来源、500 证据关系；圆形轨道过多会拒绝，不能静默裁掉维度。超过范围请明确分主题生成快照。更新 corpus 后重新生成并导入 companion JSON；本功能不会自动扩大样本、抓取论文或调用模型。

```
node --test tests-js/field-radar-relations.test.mjs
PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node scripts/field-radar-relations-browser-fixture.mjs
```

只用合成样本执行安全、计量、存储与浏览器回归。不使用用户当前窗口。源码修改与已运行宿主/已打开页面是否加载新版是不同状态，测试不重载宿主或刷新用户页面。


## 文献对照表：复制到 Slides 与本机导出

「领域研究 → 文献对照表」从当前保存主题、关键词／任务／年份筛选整理七列：**研究组、论文简称、具体解决／生成什么、数据集与开放性、方法、年份、推理无需目标区域历史 OD？**。每页 20 篇。点「整理当前页」查看，点「复制到 Slides」复制 HTML 表格与 TSV 两种剪贴板格式；HTML、TSV、CSV、Markdown 可分别导出本页。切换主题、筛选、页码或草稿后旧结果失效，需重新整理。富文本粘贴效果取决于目标软件，若只接受纯文本，可用 TSV 经电子表格中转。导出不是发布或上传。

表格复用现有来源、`papers[].task/output/task_axes.output/method/datasets/dataset/year` 和明确核验的 `research_groups`。缺简称时保留全称；缺组名不由共同作者或单位补造；代码开源不等于数据开放。每格保留来源标识与核验状态，完整导出附来源和范围说明，同名私有 JSON 保留未截断原记录与逐格证据。剪贴板只复制七列表格，不把来源脚注误粘成额外数据行。

OD 标准固定为：**输出 OD 流量，推理目标区域时不输入其历史 OD。** 训练阶段可使用历史 OD，评估真值不等于推理输入。需要目标区域历史／部分 OD 的补全、校准不符合。只有已核验、直接引用来源并带证据文字的布尔字段才能产生「是／否」；缺证据、冲突或 AI 待核结果保留「未知」。不按论文／方法名称猜测。

### 自动提取与审阅边界

已有结构化资料可直接整理，不需要模型。需要从保存的摘录中提取更多字段时，进入同一「AI 自动分析」显式调用已配置的宿主模型。新分析附 `paper_comparisons:[{paper_id,comparison}]`，每次最多 20 篇；输出预算不足或未覆盖的文献须保留缺口，建议按明确主题拆分。旧结果仍能查看，不自动重跑或覆盖。表格页勾选「使用已保存 AI 表格草稿」时，仅采用已完成且与当前主题版本一致的草稿，所有 AI 字段强制标为待核对，不自动变成已验证事实。重复查询／整理／导出不调用模型。

这不是全库无人值守抓取：不解析未选 PDF，不搜凭据，不补造未提供的原文，不自动抓取数据访问条款。已有后台逐篇分析的证据可按原流程纳入主题，再整理；不足的来源明确补充后才核验。

每篇论文可保存以下可选 `comparison` 字段：

- `short_name/research_group/task_output/method`：`{value:"文字",status:"verified|needs_review|unknown|conflicting",source_ids:["s1"],evidence:"原文或位置"}`。
- `datasets`：`[{name:"数据名称",source_ids:["s1"],status:"verified",openness:{value:"open|restricted|closed|unknown",status:"verified",source_ids:["s1"],evidence:"开放、申请或限制的依据"}}]`。数据名来源不能替代开放性来源。
- `od_generation`：`output_is_od`、`target_history_at_inference` 及可选 `training_history`、`evaluation_history`，各为 `{value:true或false,status:"verified",source_ids:["s1"],evidence:"明确依据"}`。最终标准是前者 true、后者 false；未知字段省略，不能用 false 代替缺失。

逐格 `source_ids` 必须存在，资料导入和模型结果使用同一校验器。人工核验后通过已有主题 JSON 导入及 revision 检查保存；AI 草稿不反向覆盖原主题或 PDF。

### 原生工具、HTTP 与命令行

- `library_field_radar_table` / HTTP `field_radar_table`：只读整理，返回表格 HTML、TSV、单元格、覆盖数、来源与缺失说明。
- `library_field_radar_table_export` / HTTP `field_radar_table_export`：写入原有 `.paper-library/field-radar-exports/`，支持 `format:html|tsv|csv|markdown`。原生工具返回本机路径，HTTP 只返回受控同源下载地址。
- 参数为 `{id,expected_revision?,analysis_request_id?,filters?:{query?,task?,year?},offset?:0,limit?:1..100}`，导出另加 format（默认 html）。`analysis_request_id` 可选，明确选择已有 AI 草稿；旧版本或未完成草稿拒绝。超限拒绝而不是静默截断，`count/total/has_more` 说明本页覆盖。

```sh
node scripts/export-field-radar.mjs --library /absolute/library --id topic-id --view literature-table --format html --limit 100
node scripts/export-field-radar.mjs --library /absolute/library --id topic-id --view literature-table --format tsv --analysis-request-id saved-request-id --expected-revision HASH --state-home /absolute/dsh-home
```

`--state-home` 可选，需与宿主 localStateHome 相同。CLI 复用当前资料库状态和安全导出实现，不启动浏览器、不调用模型。文件内容不可变，下载时核验完整性；表格 HTML 转义，CSV／TSV 防止公式注入。派生单元格合计最多 2 MiB，单个渲染格式最多 10 MiB；超限请减少本页 limit，不裁掉证据或字段。

```sh
node --test tests-js/field-radar*.test.mjs tests-js/bundled-skill.test.mjs tests-js/workspace-host.test.mjs tests-js/workspace-navigation.test.mjs
npm run build
```

测试仅使用合成数据。源码／接口检查不代表真实模型提取质量、用户当前页面已刷新或 PowerPoint／Google Slides 已验收。
