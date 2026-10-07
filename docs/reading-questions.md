# 可审阅的论文阅读问题

全文分析现在让模型回答阅读问题，由程序定位原文、生成节点和关系。书目资料与论文原始 Abstract 不再属于这条模型任务；单独生成的中文精读笔记是 AI 解读，不能替代原始 Abstract。

## 哪些工作不需要 LLM

导入已优先使用 PDF 内嵌 CSL／PDF 信息、首页的 DOI 候选及登记服务匹配；已有 Zotero、CSL、RIS、BibTeX、JSON 字段直接复用。Crossref／arXiv 返回的摘要可作为原始摘要来源。缺失或冲突应保持可见，不能让模型编造书目事实。

目前 PDF 内部没有摘要的条目，不保证能仅凭版式规则准确找出原始 Abstract。全文模型不会因此补写一个“摘要”。明确的 `mode:"metadata"` 仍保留为独立、可选的模型资料提取入口；它不会在全文流程中自动调用。`mode:"full"` 即使收到旧设置的 `apply_metadata:true`，也不提取和写回书目字段。

## 23 个问题及编辑位置

| 编号 | 实际问题 | 主要选项 | 权威文件 |
| --- | --- | --- | --- |
| q1_method | 本批文字明确出现了哪些方法或处理流程？ | 方法 | [q1_method.json](../prompts/reading/q1_method.json) |
| q1_dataset | 本批文字明确出现了哪些数据集或数据来源？ | 数据集 | [q1_dataset.json](../prompts/reading/q1_dataset.json) |
| q1_metric | 本批文字明确出现了哪些评价指标或测量标准？ | 指标 | [q1_metric.json](../prompts/reading/q1_metric.json) |
| q1_task | 本批文字明确出现了哪些研究任务或应用问题？ | 任务 | [q1_task.json](../prompts/reading/q1_task.json) |
| q2_author_claim | 作者明确提出了哪些主张、假设、建议或设计目的？ | 作者主张 | [q2_author_claim.json](../prompts/reading/q2_author_claim.json) |
| q2_reported_result | 明确报告了哪些实际观察、测量或分析结果？ | 报告结果 | [q2_reported_result.json](../prompts/reading/q2_reported_result.json) |
| q2_reader_inference | 可以提出哪一个作者未直接陈述、仍需核实的候选解释？ | 读者解释，至多一条 | [q2_reader_inference.json](../prompts/reading/q2_reader_inference.json) |
| q3_text | 正文明确陈述了哪些可以逐条核对的事实？ | 单一事实与连续正文 | [q3_text.json](../prompts/reading/q3_text.json) |
| q3_figure | 明确提供了哪些图示编号、标题、图注或对应正文说明？ | 图示文字 | [q3_figure.json](../prompts/reading/q3_figure.json) |
| q3_table | 明确提供了哪些表格编号、标题、表注或对应正文说明？ | 表格文字 | [q3_table.json](../prompts/reading/q3_table.json) |
| q3_formula | 明确提供了哪些公式表达式或变量定义？ | 公式文字 | [q3_formula.json](../prompts/reading/q3_formula.json) |
| q4_supports | 哪些依据为哪一条可定位的原文主张提供了支持？ | 支持目标主张 | [q4_supports.json](../prompts/reading/q4_supports.json) |
| q4_qualifies | 哪些依据限定了哪一条可定位原文主张的范围、条件或确定程度？ | 限定目标主张 | [q4_qualifies.json](../prompts/reading/q4_qualifies.json) |
| q4_contradicts | 哪些依据在可比条件下与哪一条可定位的原文主张不相容？ | 反驳目标主张 | [q4_contradicts.json](../prompts/reading/q4_contradicts.json) |
| q5_method_data | 哪个方法实际使用或处理了哪项输入数据？ | 方法–数据 | [q5_method_data.json](../prompts/reading/q5_method_data.json) |
| q5_method_result | 哪项实测结果明确归属于哪个方法？ | 方法–结果 | [q5_method_result.json](../prompts/reading/q5_method_result.json) |
| q5_data_result | 哪项实测结果来自哪项数据或子样本？ | 数据–结果 | [q5_data_result.json](../prompts/reading/q5_data_result.json) |
| q5_metric_result | 哪项实测结果由哪个指标测量？ | 指标–结果 | [q5_metric_result.json](../prompts/reading/q5_metric_result.json) |
| q5_task_result | 哪项实测结果对应哪项具体任务？ | 任务–结果 | [q5_task_result.json](../prompts/reading/q5_task_result.json) |
| q6_research_question | 作者明确提出了哪些待回答或检验的研究问题？ | 作者研究问题 | [q6_research_question.json](../prompts/reading/q6_research_question.json) |
| q6_study_limitation | 作者明确说明了本研究哪些对象、条件或内容尚未检验或受限？ | 本研究局限 | [q6_study_limitation.json](../prompts/reading/q6_study_limitation.json) |
| q6_prior_gap | 作者明确指出了先前文献中的哪些具体未解决问题？ | 先前研究缺口 | [q6_prior_gap.json](../prompts/reading/q6_prior_gap.json) |
| q6_reader_check | 哪一个作者未明确提出的问题还需要读者继续核对？ | 读者核对问题，至多一条 | [q6_reader_check.json](../prompts/reading/q6_reader_check.json) |

所有问题都只含一种肯定选码，以及 `other`（其他）、`not_reported`（本批未报告）、`not_applicable`（本批不适用）。按单一要素、陈述、材料或关系逐条回答，分别统计缺题、错误选码和证据定位。某题有多个条目时可重复该题 ID；两个读者题每题最多一条，包括 `other`。共同规则、题目清单、分组、预算和版本在 [protocol.json](../prompts/reading/protocol.json)，每题有三个通用学习材料的合成示例。表格是导览，实际措辞和选项以 JSON 为准。

### 本轮消除的混合判断

| 原问题的含糊处 | 当前判定单位 | 核对方式 |
| --- | --- | --- |
| Q2 把作者主张、测量结果和读者解释放在一起 | 一项作者陈述、一项报告结果或一个读者解释分别提问 | 分别核对来源、限定条件和归属；转述他人结果不能变成本研究结果 |
| Q3 问哪些材料“值得”作证据，缺少一致标准 | 一个正文事实、一幅图、一张表或一个公式分别定位 | 核对材料身份、连续引文和复述忠实性；不按重要程度选取 |
| Q4 让模型在判断文字中自行拟写被评价主张 | 一个原文目标主张与一组具体依据构成关系判断 | 目标与依据分别定位；理由不替代目标；逐类判断支持、限定或反驳 |
| Q6 把作者研究问题、本研究局限、先前研究缺口与读者疑点混为一类 | 四类对象分别提问 | 核对缺口属于哪项研究、是谁提出，以及是否只是待核查问题 |

拆题改善可审阅性，不证明模型语义准确率已经提高。正文题仍是有界的出处候选集合，每条一个事实与必要条件；最多 12 条，不声称穷尽全文事实。读者两题评价依据、归属和推断强度，不评价是否列全所有可能解释。它们保留独立能力，也可用 `question_ids` 选择只提取作者明确内容。

其他实际提示也外置在 [prompts/analysis](../prompts/analysis)：`note.json` 精读笔记、`review.json` 评审、`metadata.json` 独立资料提取、`knowledge.json` 手动知识工作流、`coverage.json` 缺失范围说明、`agent.json` 原生 DSH 分析代理的基础约束。JSON 是随软件发布的本地资产，无需把真实论文交给 AI 才能审阅提示。修改这些辅助模板后需重启已加载的服务；阅读题库在每个新作业启动时读取、冻结并保存版本及内容哈希。当前新作业冻结 `reading-questions-v4`；旧 v1/v2/v3 作业继续使用原快照、问题和分组，同一个请求标识不会因题库变化自动重放或再次计费。要用 v4 分析须创建新请求。旧 q1–q6 文件保留，旧宽题答案不能冒充已回答全部分题。

## 选码手册与编译说明

应用 v4 时须同时更新后端代码和 `prompts/reading/` 资产，已加载旧后端的服务需重新加载代码后再启动 v4 作业。仅替换题库文件不能让旧代码识别新分题与目标主张合同。

自 v2 起每个选项都有 `coding`：`definition` 定义其含义，`include_when` 说明何时选用，`exclude_when` 说明边界。模型同时收到选项的 `projection`，这是程序生成的只读编译说明，解释节点类型、关系语义和方向。选码依靠陈述的内容、对象、条件与证据，不能机械按语气或因果关键词分类；材料有相关内容却缺少足够语义依据时，应选 `other` 并说明。

作者主张、设计目的和假设不能当作实测结果；实际报告的因果估计量仍可属于 `reported_result`，作者对结果新增的机制解释另标为主张。读者不能把所报关联升级为因果。`some`、`most`、`previously described` 等数量、范围和历史归属应保留。q4 的支持可以来自本论文数据、分析或论证，不要求另找独立文献；作者重复自己的主张本身不构成验证。只读了部分页面时，未报告与读者疑点都不能升级为对全文的否定。

每题有 1–3 条通用阅读、思考与写作的合成示例，解释选码理由与常见边界。它们不是 S1 等本批来源，不可作为 `evidence` 引用。`coding`、`projection` 和示例都不增加答案字段，模型仍只返回 `answers`。拆题沿用编码手册；每次输出的数量、引文长度和字节预算保持不变。实际语义准确率与同类实体漏项率仍须通过逐题人工核对评估，来源定位成功不能代替这些评价。

## 分次提问如何使用上下文

默认按既有文字预算顺序读取整篇 PDF，每个文字批次按上述顺序调用 23 次，一次只问一题。每次都收到该批的全部文字；页面只由内核提取一次，后续问题复用来源快照。`question_ids` 可指定非空子集，默认按所选顺序逐题调用。`question_mode:"grouped"` 仍按题库的 `default_groups` 调度；v4 的每组也只有一题，旧 v3 保持 13 题单题，旧 v1/v2 保持六题、三组。

没有按章节关键词预先删掉内容，也不让某题依赖上一题生成的自由文字。相同来源分别用于识别要素和核对关系，模型自行复制所需原文，不能凭前一题的答案猜测联系。同一批文字默认发送 23 次；缓存折扣取决于提供商，不能假定免费。可选图片随每次请求重复发送。启用笔记／评审各另加一次调用。新题库不自动增加模型调用额度；计划用量为“所选题数 × 有文字批次数 + 笔记／评审次数”，预算不足会停止并保留结果。批量编排器仍按每个实际凭据最多两路控制并发，多个独立 headless 进程不共享并发额度。

例如通过独立后端运行部分问题：

```json
{
  "action": "paper_analysis_run",
  "ids": ["synthetic-paper-id"],
  "request_id": "reading-result-support-v4",
  "mode": "full",
  "question_ids": ["q2_reported_result", "q4_supports"],
  "question_mode": "separate",
  "notes": false,
  "review": false,
  "apply_metadata": false
}
```

它回答两个问题，不能称为完成 23 题全套。也可用既有 `pages` 明确选页；这是用户选择范围，不是程序猜测相关段落。

## 回答、精确引文和图谱

模型只需返回小型对象；每个问题允许多条原子回答，总量受协议预算约束：

```json
{
  "answers": [{
    "question_id": "q2_author_claim",
    "choice": "author_claim",
    "judgment": "作者建议先检查证据再接受结论。",
    "evidence": [{
      "source_id": "S1",
      "quote": "Check the evidence before accepting a conclusion."
    }]
  }]
}
```

示例只使用合成学习文本。部分提取题的 `judgment` 可省略；`other`、两个读者题以及 q3_*、q4_* 的肯定选项要求填写。`free_text` 是兼容别名。肯定回答必须附原文；未报告和不适用可不附原文，它们只描述所读批次。同题不能混合肯定内容与中性范围选项，也不能同时选择未报告与不适用；矛盾答案保留为无效记录。

q4_* 的非中性回答还必须提供 `target_claim:{source_id,quote}`，它是本批作者明确陈述的原文主张，独立恢复来源、哈希和字符位置。`evidence` 是关系依据，`judgment` 只说明理由。缺失、改写、来源越界或无法唯一定位的目标会使该回答无效；若目标只在其他未提供页面，应选 `not_reported`，不能凭前一题的模型回答补齐。重复目标或仅复制目标子句不能作为支持、限定或反驳的额外依据；包含目标且同时含实据的连续上下文仍可定位，但语义关系须人工核对。

```json
{
  "answers": [{
    "question_id": "q4_supports",
    "choice": "supports",
    "target_claim": {"source_id": "S1", "quote": "Source checks improve recall."},
    "judgment": "练习观察与主张一致，但尚不足以确证因果。",
    "evidence": [{"source_id": "S1", "quote": "Nine of twelve readers recalled the passage after a source check."}]
  }]
}
```

“精确引文”指证据片段必须能在本批保存的文本中定位，不是要求模型生成 APA 参考文献。引文应短且足以核对判断，保留必要的条件句、比较对象和限定词；不能只摘结论短语而删掉适用范围。每页只有简短来源别名 S1、S2，不给每行加编号。程序恢复真实来源 ID、PDF 页码、内容哈希和 UTF-16 字符位置。只允许字面唯一匹配或唯一的空白等价匹配；不会悄悄改词、修断词、改变大小写、拼接不同句子或猜测重复片段的位置。Markdown 标记须按来源保留；引文只对应保存的派生 Markdown，不能声称逐字对应 PDF 原始字符。

定位成功证明“这段文字存在”，不证明它支持模型判断。结果始终是待核对草稿。程序根据固定映射生成图谱 ID、节点和边；例如 q2_reported_result 会生成 observation，同时保留同文的 claim 包装。q4_* 的 claim 标签来自目标原文，理由单独保存；`other` 只保留目标与来源，不生成支持、限定或反驳关系。界面分别展示目标、依据和读者推断标记。模型不返回这些图谱对象。

表格选码 `table` 使用现有图谱的 `figure` 类型存储，问题 ID 与选码保留表格身份，不新增不受支持的类型。两个读者题的回答带 `source_status:"inferred"`；claim 节点归属保存在 `fields.source_status`，question 节点同时保留现有顶层归属。待核对问题生成 question，不能变成已成立的 gap；当前图谱只为 Claim/Gap 提供证据断言，question 保留来源指针，仍可能出现缺证据断言的 lint 提示。

五个 q5_* 关系题可额外给出 `subject`、`object` 原文端点，两者须同时提供并出现在同一证据片段。回答字段的顺序和图谱边的方向是两个层面：

| 选项 | subject 类型 | object 类型 | 图谱关系与方向 |
| --- | --- | --- | --- |
| `method_data` | method | dataset | 保留 claim 与两端节点，无直接关系边 |
| `method_result` | method | observation | object → subject，`produced_by`：结果的研究或计算流程归属，不代表因果识别 |
| `data_result` | dataset | observation | object → subject，`observed_on`：结果在该数据或样本上观察到 |
| `metric_result` | metric | observation | object → subject，`measured_by`：结果由该指标测量 |
| `task_result` | task | observation | object → subject，`for_task`：结果对应该任务 |

论文不能充当方法，方法生成的输出图片不能充当输入数据。方法结果题遇到明确的方法设计目的而尚无实测结果时用 `other`，作为 claim 保留，并省略结果端点。指标只有定义、任务尚未执行等未报告对应结果的情况，按各题边界选 `not_reported`。程序只连接文本明确关联且类型允许的要素；无法安全连接时保留回答和证据，并报告 `batch_compilation.limitations`。现有类型不允许直接创建 method→dataset 的 uses 边，不会虚构实验节点来绕过限制。

## 查看失败和候选选项

每组由适配器返回的响应与每条校验记录分开落盘。DSH 原生适配器在返回前拒绝不完整 JSON，这类输出沿用宿主私有会话日志，本插件只记录失败；直连模型的返回文字可在问题记录中查看。某题缺答案、引文失败或一次模型请求失败，不删除已成功的题目，继续后续题组和页面；预算耗尽、用户取消、来源改变则停止。新作业 `status:"partial"` 表示仍有覆盖或交付缺口；旧记录没有问题覆盖字段，不会伪造成新协议结果。

- `coverage`：文字提取覆盖；`full_document:true` 本身不等于模型答完了问题。
- `question_coverage`：每题应处理、已回答、失败与无文字的批次；`full_questionnaire` 标明是否选择冻结题库的全部问题（v4 为 23 题）。未回答与回答未通过校验分开记录。覆盖检查不能检测模型遗漏了同类实体；这需要逐题核对来源并计算漏项。
- `analysis_complete`：所选范围的问题与所请求的产物是否完成；笔记／评审因材料预算只覆盖部分批次时为 false。人工语义审核不在此标志内。
- `paper_analysis_get` 加 `batch_index`：读取该批 `batch_answers`、`question_results`、`batch_compilation` 和 `option_candidates`。再加 `include_raw:true` 可读取该批题组原始响应；不重新调用模型。
- 中途停止的当前批次保留在 `active_questions`，不会因重启自动再问。

笔记／评审材料超出预算时，重复的题组详情可压成 `question_groups_summary`，仍保留全部题目、未完成题目、状态及错误计数；逐题选码计数可汇总为 `answer_counts.by_choice`，保留总数、有效数、无效数及中性回答总数。`packing.group_details_omitted`／`answer_count_details_omitted` 与 `GROUP_DETAILS_COMPACTED`／`QUESTION_COUNTS_COMPACTED` 明确标示省略。原始问题记录保持不变，压缩后的笔记仍为部分覆盖，不能冒充完整回答详情。

笔记中的 q4_* 保留分别绑定的目标与依据摘录。目标丢失或无法绑定时，该关系回答、所属图谱与本批生成摘要一并省略，其他已绑定回答保留；`TARGET_CLAIM_OMITTED` 和遗漏计数明确报告缺口。原始回答不变，不通过无目标图谱或摘要恢复同一关系。

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
