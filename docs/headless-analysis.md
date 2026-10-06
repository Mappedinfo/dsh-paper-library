# 无界面的元数据提取与全文分析

Paper Library 的后台可以直接运行，不需要浏览器或 DSH。独立脚本负责检索与分析，Paper Library 共用同一份文献、来源快照、分析记录和待审阅草稿；DSH 是可选的对话入口。本功能已在源码实现，安装旧发布版本时应先核对是否包含 `--model-config`。

## 先复用已有资料，再决定是否调用模型

1. 用既有 `list`、`get` 或[元数据清点脚本](pdf-metadata-audit.md)确定需要处理的条目，保存明确的 ID 清单。
2. 有 DOI／公开论文页时，可通过独立 CLI 的 `metadata_lookup` 获取登记资料草稿。此操作不下载 PDF、不调用模型，也不写回；缺少标识符或身份不匹配会报告错误。审阅后使用 `update` 保存。
3. 登记资料仍不足时，使用 `mode:"metadata"` 从选定 PDF 页提取缺失字段；需要深入阅读时再使用 `mode:"full"`。

已有本地 PDF 才能进行文本分析。分析入口不会下载 OSS 对象，不会扫描整库或发现私人凭据。将文本提交给模型发生在明确提交的分析请求中；单纯列出文献或读取已有结果不会启动模型。

## 显式模型配置

将配置保存在公开源码仓库之外，例如 `/absolute/private/model.json`。配置只写凭据变量名，不写密钥值：

```json
{
  "provider": "glm",
  "model": "glm-4.7-flash",
  "keyEnv": "GLM_API_KEY",
  "envFile": "/absolute/private/credentials.env",
  "maxCalls": 100,
  "maxConcurrency": 1,
  "maxOutputTokens": 8192,
  "timeoutMs": 120000
}
```

GLM 使用官方 OpenAI Chat Completions 接口。Kimi Code 使用官方 Anthropic Messages 接口；改为 `provider:"kimi"`、`model:"kimi-for-coding"`、`keyEnv:"KIMI_TOKEN_PLAN_KEY"` 即可。模型名称是可修改的示例，不代表最新型号、价格或套餐适用保证；先确认自己的服务支持所选用途。已做过的连接测试及官方说明见[直连测试文档](direct-model-probe.md)。

`envFile` 是可选项；省略时只读取当前进程的指定环境变量。明确指定文件时，该文件中的指定变量优先；相对路径相对模型配置文件解析。仅解析普通赋值或 `export NAME='value'`，不执行 shell、不展开变量，不尝试第二个 key，不自动换模型或重试请求。支持的两个 API 地址固定，拒绝重定向。

`maxCalls` 是单个后台实例的实际调用尝试上限（1–10000，默认 100），含失败尝试、精读笔记和评审；`maxConcurrency` 限制同时处理的文献数（1–4，默认 1）。额度按当前进程计算，不是账号费用上限，也不跨不同进程共享。服务返回的 token 用量会汇总；未知值保持 `null`。同一个服务承接多个批次时，`usage_scope:"headless_instance"` 表示实例累计用量，不冒充单批费用。

## 命令行批量调用

以下命令在源码根目录执行。`--library` 必须指向已导入文献的管理库，ID 来自该库的 `list`。示例 ID 是占位符，需要替换。普通请求也通过同一 CLI 输入：

```bash
node src/cli.mjs --library /absolute/private/library <<'JSON'
{"action":"list","limit":20}
JSON
```

只提取首页资料，保存为待核对的资料笔记：

```bash
node src/cli.mjs --library /absolute/private/library \
  --model-config /absolute/private/model.json <<'JSON'
{"action":"paper_analysis_run","ids":["paper-id-a","paper-id-b"],"request_id":"metadata-pass-1","mode":"metadata"}
JSON
```

分析指定文献的全文，并生成精读笔记：

```bash
node src/cli.mjs --library /absolute/private/library \
  --model-config /absolute/private/model.json <<'JSON'
{"action":"paper_analysis_run","ids":["paper-id-a","paper-id-b"],"request_id":"full-reading-1","mode":"full","notes":true,"review":false,"apply_metadata":false}
JSON
```

每批最多 2000 个不重复的文献 ID；不接受目录通配或隐式全库选择。`paper_analysis_run` 等待整批结束，返回每篇结果、覆盖范围、草稿 ID 和状态统计。部分失败返回 `partial` 或 `failed`，CLI 保留 JSON 并返回非零退出码；已完成材料仍保留。单篇也可用 `id` 代替 `ids`，或调用 `paper_analysis_start`；CLI 的 `start` 同样等待结束。

| 选项 | `metadata` | `full` |
| --- | --- | --- |
| 默认读取范围 | 第 1 页，可用 `pages` 指定其他页 | 全部页，可用 `pages` 限定 |
| 保存结果 | 缺失资料建议及引用，待审阅笔记 | 每批图谱草稿与资料建议 |
| `notes` | 必须为 `false` | 默认 `true`，追加一次精读笔记调用 |
| `review` | 必须为 `false` | 默认 `false`，启用后追加一次评审调用 |
| `apply_metadata` | 默认 `false` | 默认 `false` |

这里的默认值属于独立入口；DSH 既有自动整理偏好保持原有行为。仅需每批证据与论断时，显式设置 `notes:false` 可省去总结调用。单批读取最多 8 页／8 个文本块／24000 字符，密集页继续按位置分段。扫描页没有可读文字会报告，不包含 OCR 或图片理解；`coverage.full_document` 与未读、空白、截断范围一并保留。精读笔记／评审使用最多 24 KiB 的已保存批次材料，超出时明确记录部分覆盖，不声称读全。

## 查看、审阅与写回

从批量结果取出某篇的 `id` 和派生 `request_id`，即可不带模型配置读取：

```bash
node src/cli.mjs --library /absolute/private/library <<'JSON'
{"action":"paper_analysis_get","id":"paper-id-a","request_id":"batch-request-id-from-result"}
JSON
```

元数据的 `field_sources` 保留实际来源标识和原文引用。模型草稿标为 `origin:llm`、`needs-review`，不自动变成人工核验的事实。读取 `batch_index` 可查看某一批结果；默认返回最后一批。审阅后明确提交 `paper_analysis_apply`（相同 `id`、`request_id`）才把有来源支持的缺失字段写回。使用原目录版本进行冲突检查，保留备份并原子替换管理副本；已有值、DOI、引用键和 JCR 不由模型改写，导入原件不改动。后续编辑改变了目录版本时应重新审阅，不覆盖冲突。

引文校验只接受对应来源中的原文。模型仅改变换行或连续空白时，允许在同一来源内唯一匹配后恢复真实原文，并在批次与作业的 `quote_normalization` 中记录次数；改字、省略、跨来源和歧义匹配仍被拒绝。分析提示与校验统一为最多 12 个节点、20 条关系合计，不自动截断超限输出。

使用相同资料库和状态根目录启动 Paper Library，即可打开已保存结果。默认状态位置沿用本机 DSH 路径解析，但不要求安装或运行 DSH；如使用 `--state-home /absolute/private/state`，CLI 和服务端应传入同一个路径。

独立服务也能配置相同模型，沿用现有审阅界面：

```bash
node src/server.mjs --library /absolute/private/library \
  --model-config /absolute/private/model.json --port 43121
```

服务只监听本机。HTTP `paper_analysis_start` 立即返回排队状态，客户端使用 `get` 读取进度；无模型配置的服务仍可读取分析记录。图谱接受／否决沿用知识草稿审阅；RKOS 导出只包含符合条件的已接受图记录，见[兼容性说明](research-os-compatibility.md)。

独立后台不启动 DSH 的导入／选中自动整理队列。现有界面发来的 `reuse:true` 自动打开请求只读取已有结果，未分析的文献保持 `idle`；需要明确点「立即整理」或提交后台批次才会使用模型。界面手动运行时，补齐资料和评审复选框仍按用户当前设置传入。

## 重复请求与中断

同一批次 ID 和相同选项复用既有结果，不再次调用模型；修改条目集合、模式、页码、模型或预算需使用新的批次 ID。已失败记录也不自动重试。跨进程查看仍在运行的作业时显示 `unconfirmed`，表示当前进程不能判断原执行器是否仍在工作；不会自动接管或重放，尚未开始的条目也不自动续跑。先检查原执行器，再为确需重跑的条目创建新请求。当前不是自动断点续跑系统。

单篇取消只影响持有执行任务的同一后台实例；从另一个 CLI 进程读取或取消无法终止原服务中的任务。长批次宜用 CLI 执行、从同一服务提交并取消，或由程序保留句柄。新请求意味着新授权范围与新调用预算，不能把新 ID 当作无需计费的“继续”。

## 程序调用

多模型的首批运行可以使用 `scripts/run-paper-analysis-batch.mjs`。准备一个仓库外的计划文件，明确分配文献 ID；同一篇不能同时分给两个入口：

```json
{
  "library": "/absolute/private/library",
  "request_id": "first-reading-batch",
  "mode": "full",
  "notes": true,
  "review": false,
  "routes": [
    {"name": "glm", "config": "/absolute/private/glm-model.json", "ids": ["paper-id-a"]},
    {"name": "kimi", "config": "/absolute/private/kimi-model.json", "ids": ["paper-id-b"]}
  ]
}
```

每份模型配置明确设置 `maxCalls` 和不超过 2 的 `maxConcurrency`。`maxCalls` 按入口分别计数，同一 key 配置多个入口时应合计各入口预算。编排器共用按实际凭据区分的并发限制，同一 key 的不同别名也最多 2 个在途请求；此保护涵盖本次编排，不控制其他应用独立发起的请求。

```bash
node scripts/run-paper-analysis-batch.mjs \
  --plan /absolute/private/plan.json --out /absolute/private/new-run
```

输出目录必须新建并位于源码仓库与资料库之外，保存私有运行清单、进度、结果和脱敏的模型响应。原始响应可能包含论文内容，不能提交到公开仓库。编排器不修改 PDF 资料，不自动重试失败生成或轮换 key。

从既有元数据清点挑选首批时，可使用 `scripts/prepare-paper-analysis-run.py --library … --audit … --out … --model-config … --model-config … --count 12`。它只选已有目录中有 DOI／基础来源元数据、6–24 页、当前字节与审计哈希一致的驻留 PDF，按哈希去重；这是便于初次检查的选择规则，不代表随机样本或整库覆盖。实际选中条目与依据只写入私有目录。

运行结束后，使用 `scripts/inspect-paper-analysis-batch.mjs --plan … --run … --selection …` 检查每篇状态、全文覆盖、必需笔记的待审状态、本地 PDF 哈希和最后一批证据引文。报告保存在运行目录，不调用模型或下载文件；引文抽查只覆盖最后一批，不能代替全文内容审阅。上述三个脚本是源码仓库工具，npm 安装包仍使用 CLI 或下面的程序入口。

包导出 `@mappedinfo/dsh-paper-library/analysis`，源码可直接导入 `src/headless-analysis.mjs`：

```js
import { createHeadlessAnalysis, loadModelConfig } from '@mappedinfo/dsh-paper-library/analysis'
const analysis = await createHeadlessAnalysis({
  library: '/absolute/private/library',
  modelConfig: await loadModelConfig('/absolute/private/model.json'),
})
try {
  const result = await analysis({
    action: 'paper_analysis_run', ids: ['paper-id-a'],
    request_id: 'reading-1', mode: 'full', notes: false,
  })
  // result.results 中的状态和覆盖范围需逐项处理。
} finally {
  analysis.dispose()
}
```

未引入模型 SDK 或常驻 PDF 引擎。测试使用合成学习练习、真实 Python PDF 读取与确定性模型替身，覆盖 CLI／HTTP 共用草稿、元数据明确写回、全文分批、并发预算和重复请求；不代表真实模型提取准确率已经通过批量评估。
