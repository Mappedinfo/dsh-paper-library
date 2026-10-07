# 可审阅的论文阅读问题

全文分析现在让模型回答阅读问题，由程序定位原文、生成节点和关系。书目资料与论文原始 Abstract 不再属于这条模型任务；单独生成的中文精读笔记是 AI 解读，不能替代原始 Abstract。

## 哪些工作不需要 LLM

导入已优先使用 PDF 内嵌 CSL／PDF 信息、首页的 DOI 候选及登记服务匹配；已有 Zotero、CSL、RIS、BibTeX、JSON 字段直接复用。Crossref／arXiv 返回的摘要可作为原始摘要来源。缺失或冲突应保持可见，不能让模型编造书目事实。

目前 PDF 内部没有摘要的条目，不保证能仅凭版式规则准确找出原始 Abstract。全文模型不会因此补写一个“摘要”。明确的 `mode:"metadata"` 仍保留为独立、可选的模型资料提取入口；它不会在全文流程中自动调用。`mode:"full"` 即使收到旧设置的 `apply_metadata:true`，也不提取和写回书目字段。

## 六个问题及编辑位置

| 编号 | 实际问题 | 主要选项 | 权威文件 |
| --- | --- | --- | --- |
| q1 | 材料明确出现了哪些方法、数据、指标和任务？ | 方法／数据／指标／任务 | [q1.json](../prompts/reading/q1.json) |
| q2 | 作者提出了哪些有限主张，报告了哪些观察或结果？ | 作者主张／报告结果／读者解释 | [q2.json](../prompts/reading/q2.json) |
| q3 | 哪些连续原文、图表说明或公式说明可作为证据？ | 原文／图表说明／公式说明 | [q3.json](../prompts/reading/q3.json) |
| q4 | 这些证据对具体主张起什么作用？ | 支持／限定／矛盾 | [q4.json](../prompts/reading/q4.json) |
| q5 | 方法、数据、指标、任务与结果有什么明确联系？ | 方法–数据／方法–结果／数据–结果／指标–结果／任务–结果 | [q5.json](../prompts/reading/q5.json) |
| q6 | 材料明确指出了哪些缺口、限制或待回答问题？ | 作者研究问题／作者局限或缺口／读者推断疑点 | [q6.json](../prompts/reading/q6.json) |

所有问题都有 `other`（其他）、`not_reported`（本批未报告）、`not_applicable`（本批不适用）。共同规则、分组、预算和版本在 [protocol.json](../prompts/reading/protocol.json)，每题的合成选码示例在相应 q*.json。表格是导览，实际措辞和选项以 JSON 为准。

其他实际提示也外置在 [prompts/analysis](../prompts/analysis)：`note.json` 精读笔记、`review.json` 评审、`metadata.json` 独立资料提取、`knowledge.json` 手动知识工作流、`coverage.json` 缺失范围说明、`agent.json` 原生 DSH 分析代理的基础约束。JSON 是随软件发布的本地资产，无需把真实论文交给 AI 才能审阅提示。修改这些辅助模板后需重启已加载的服务；阅读题库在每个新作业启动时读取、冻结并保存版本及内容哈希。当前新作业冻结 `reading-questions-v2`；旧作业继续使用原快照，同一个请求标识不会因题库变化自动重放或再次计费。要用 v2 分析须创建新请求。

## 选码手册与编译说明

v2 的每个选项都有 `coding`：`definition` 定义其含义，`include_when` 说明何时选用，`exclude_when` 说明边界。模型同时收到选项的 `projection`，这是程序生成的只读编译说明，解释节点类型、关系语义和方向。选码依靠陈述的内容、对象、条件与证据，不能机械按语气或因果关键词分类；材料有相关内容却缺少足够语义依据时，应选 `other` 并说明。

作者主张、设计目的和假设不能当作实测结果；实际报告的因果估计量仍可属于 `reported_result`，作者对结果新增的机制解释另标为主张。读者不能把所报关联升级为因果。`some`、`most`、`previously described` 等数量、范围和历史归属应保留。q4 的支持可以来自本论文数据、分析或论证，不要求另找独立文献；作者重复自己的主张本身不构成验证。只读了部分页面时，未报告与读者疑点都不能升级为对全文的否定。

每题有 2–3 条通用阅读、思考与写作的合成示例，解释选码理由与常见边界。它们不是 S1 等本批来源，不可作为 `evidence` 引用。`coding`、`projection` 和示例都不增加答案字段，模型仍只返回 `answers`。代码册增加输入 token；现有回答数量、引文长度、输出字节和模型调用预算不变。此次改造没有调用真实模型或读取私有材料，也未验证真实模型的阅读质量。

## 分次提问如何使用上下文

默认按既有文字预算顺序读取整篇 PDF，每个文字批次调用三次：`q1+q2`、`q3+q4`、`q5+q6`。每次都收到该批的全部文字，并非每次重发整篇 PDF。页面只由内核提取一次，后续题组复用来源快照。`question_mode:"separate"` 改成每题一次；`question_ids` 可指定非空子集。

没有按章节关键词预先删掉内容，也不让某题依赖上一题生成的自由文字。这样保留完整的批内证据范围、隔离错误传播，但同一批文字仍会发送三次或六次；缓存折扣取决于提供商，不能假定免费。可选图片随每次题组请求重复发送，也会增加输入成本。启用笔记／评审各另加一次调用。模型总调用预算仍由现有配置限制；批量编排器按每个实际凭据最多两路控制并发，多个独立 headless 进程不共享并发额度。

例如通过独立后端运行部分问题：

```json
{
  "action": "paper_analysis_run",
  "ids": ["synthetic-paper-id"],
  "request_id": "reading-q2-q4-v2",
  "mode": "full",
  "question_ids": ["q2", "q4"],
  "question_mode": "separate",
  "notes": false,
  "review": false,
  "apply_metadata": false
}
```

它回答两个问题，不能称为完成六题全套。也可用既有 `pages` 明确选页；这是用户选择范围，不是程序猜测相关段落。

## 回答、精确引文和图谱

模型只需返回小型对象；每个问题允许多条原子回答，总量受协议预算约束：

```json
{
  "answers": [{
    "question_id": "q2",
    "choice": "author_claim",
    "judgment": "作者建议先检查证据再接受结论。",
    "evidence": [{
      "source_id": "S1",
      "quote": "Check the evidence before accepting a conclusion."
    }]
  }]
}
```

示例只使用合成学习文本。`judgment` 可省略；`other` 和需要具体被评价主张的 q4 要求填写。`free_text` 是兼容别名。肯定回答必须附原文；未报告和不适用可不附原文，它们只描述所读批次。

“精确引文”指证据片段必须能在本批保存的文本中定位，不是要求模型生成 APA 参考文献。引文应短且足以核对判断，保留必要的条件句、比较对象和限定词；不能只摘结论短语而删掉适用范围。每页只有简短来源别名 S1、S2，不给每行加编号。程序恢复真实来源 ID、PDF 页码、内容哈希和 UTF-16 字符位置。只允许字面唯一匹配或唯一的空白等价匹配；不会悄悄改词、修断词、改变大小写、拼接不同句子或猜测重复片段的位置。Markdown 标记须按来源保留；引文只对应保存的派生 Markdown，不能声称逐字对应 PDF 原始字符。

定位成功证明“这段文字存在”，不证明它支持模型判断。结果始终是待核对草稿。程序根据固定映射生成图谱 ID、节点和边；例如 q2 的 `reported_result` 会生成 observation，同时保留同文的 claim 包装。模型不返回这些图谱对象。

q5 可额外给出 `subject`、`object` 原文端点，两者须同时提供并出现在同一证据片段。回答字段的顺序和图谱边的方向是两个层面：

| 选项 | subject 类型 | object 类型 | 图谱关系与方向 |
| --- | --- | --- | --- |
| `method_data` | method | dataset | 保留 claim 与两端节点，无直接关系边 |
| `method_result` | method | observation | object → subject，`produced_by`：结果的研究或计算流程归属，不代表因果识别 |
| `data_result` | dataset | observation | object → subject，`observed_on`：结果在该数据或样本上观察到 |
| `metric_result` | metric | observation | object → subject，`measured_by`：结果由该指标测量 |
| `task_result` | task | observation | object → subject，`for_task`：结果对应该任务 |

论文不能充当方法，方法生成的输出图片不能充当输入数据。仅说明设计目的时用 `other`，作为 claim 保留，并省略结果端点。程序只连接文本明确关联且类型允许的要素；无法安全连接时保留回答和证据，并报告 `batch_compilation.limitations`。现有类型不允许直接创建 method→dataset 的 uses 边，不会虚构实验节点来绕过限制。

## 查看失败和候选选项

每组由适配器返回的响应与每条校验记录分开落盘。DSH 原生适配器在返回前拒绝不完整 JSON，这类输出沿用宿主私有会话日志，本插件只记录失败；直连模型的返回文字可在问题记录中查看。某题缺答案、引文失败或一次模型请求失败，不删除已成功的题目，继续后续题组和页面；预算耗尽、用户取消、来源改变则停止。新作业 `status:"partial"` 表示仍有覆盖或交付缺口；旧记录没有问题覆盖字段，不会伪造成新协议结果。

- `coverage`：文字提取覆盖；`full_document:true` 本身不等于模型答完了问题。
- `question_coverage`：每题应处理、已回答、失败与无文字的批次；`full_questionnaire` 标明是否选择六题。
- `analysis_complete`：所选范围的问题与所请求的产物是否完成；笔记／评审因材料预算只覆盖部分批次时为 false。人工语义审核不在此标志内。
- `paper_analysis_get` 加 `batch_index`：读取该批 `batch_answers`、`question_results`、`batch_compilation` 和 `option_candidates`。再加 `include_raw:true` 可读取该批题组原始响应；不重新调用模型。
- 中途停止的当前批次保留在 `active_questions`，不会因重启自动再问。

`option_candidates` 只汇总经过来源校验的 `other`，带问题、次数和来源。源码仓库可用 [候选导出工具](../scripts/export-reading-option-candidates.mjs) 汇总明确指定作业，输出到仓库外的私有 JSON。它不会读取 PDF 或调用模型，也不会自动修改生效题库。例如：

```json
[{"id":"synthetic-paper-id","request_id":"saved-single-paper-request-id"}]
```

把这份作业清单保存到私有目录，再运行：

```bash
node scripts/export-reading-option-candidates.mjs \
  --library /absolute/private/library \
  --state-home /absolute/private/state \
  --requests /absolute/private/selected-jobs.json \
  --out /absolute/private/reading-option-candidates.json
```

这里的 request_id 使用批量结果返回的**逐篇请求 ID**。输出文件必须尚不存在；达到批次／候选上限时 `truncated:true`，不能当作完整清点。

建议人工合并同义候选、去掉偶发答案，确认新选项对其他论文也适用，再修改相应 q*.json，并提升 protocol.json 的版本。保留稳定的问题／选项 ID；改变含义时使用新 ID。程序保存内容哈希，避免只改文案却把不同题库当成同一版本。以后可据候选频率和真实审核结果调整选项，本轮没有自动评价答案质量或自动晋升新选项。
