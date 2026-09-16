---
name: paper-library-knowledge
description: "根据明确选择的文献批注、数据集说明或本地来源，建立可审核的证据、结果、主张与有方向的知识关系草稿。"
---

# 有来源的知识关系

这是 Paper Library 的原创方法适配，项目代码与本技能采用 MIT。沿用当前 DSH 会话的模型与插件工具；不安装 Zotero、私有专家库、向量服务或另一份模型配置。

先确定本次对象及明确选择的来源。用 `library_resources` 查找已有对象；用 `library_dataset` 的 `get`、`release_get`、`link_list` 核对数据集及实际版本。相同名称不等于同一数据集，数据集 DOI、系列 DOI、版本 DOI 与介绍论文应分别保留。没有论文的独立数据集也可以作为来源。

使用真实的 `library_knowledge` 工具，其参数为 `operation` 和 JSON 字符串 `input_json`：

1. `source_list`／`source_get` 读取明确范围内的已有来源。`source_list` 的输入如 `{"entity":{"kind":"dataset","id":"用户选择的ID"},"limit":20}`；列表是预览，需要编码时读取所选 source ID 的完整快照。
2. 若用户明确提供了摘录，可调用 `source_put`，输入 `entity`、`kind`、`text`、`url`（官方摘录必需）及已知 `locator`。kind 可为 `official-excerpt`、`user-text`、`metadata`、`source-note`；已保存论文批注用 `annotation` 加 `annotation_ref:{id,version}`，由工具从 PDF 读取原文。不要自行捏造批注版本或页码。
3. 阅读完整来源后，用 `draft_put` 建立草稿。输入包含 `entity`、`mode:"graph"`、`source_ids`、`title`、`nodes`、`edges`、`assertions`。节点结构为 `{id,type,label,fields}`；证据节点额外记录 `source_id` 与精确 `quote`。Observation 通过 `source_node:"evidence:节点ID"` 连接来源节点。边用 `{subject:"type:id",object:"type:id",relation,surface,source_id?}`；Assertion 同样采用原子端点。
4. 用 `draft_get` 读回保存结果并告知用户它是待审阅草稿；正式审核在库界面完成。模型工具不能接受自己的草稿，也不能直接写知识正文。
5. 审阅前可用 `draft_lint`（输入 `{"id":"草稿ID"}`）做只读结构检查：无支撑主张、孤立节点、未被引用的证据、重复关系、悬空端点与缺来源的观察。它只报告问题，不修改草稿；发现的问题由用户逐项核对处理。

Evidence／Figure／Formula 保存原文或来源材料，Observation 只描述来源实际报告的结果；Claim 是有边界的命题。证据类节点／Observation 到 Claim／Gap 的支持、限定或反驳采用 Assertion；论文使用数据、结果在哪份数据上观察、方法归属等采用 Edge。不要把同时出现、主题相似或数据介绍误判为实际使用。

每条来源保留身份、原文、已知位置、内容哈希与原有证据级别。`metadata` 和 `source-note` 不自动变成已核验全文。AI 生成的内容始终待审阅，置信度高也不代表科学结论成立。作者判断、来源报告和模型建议在说明中分开；不把作者想法改署为模型，或把模型建议写成作者已接受的贡献。

只处理本次明确选择的来源，合计上限 24,000 字符；预算不足时缩小范围，不静默截断或扫描整个库。工具校验失败则修复具体字段或说明缺失，不编造证据以消除警告。

需要互操作时用 `export`，明确提供 `entity`／`entities` 与 `format:"library-json"` 或 `"rkos-v3"`。知识 JSON 保存所选范围内的已审核图、笔记及其引用来源，不是含原始文件、未审草稿和会话的整库备份。RKOS v3 仅为有损兼容子集，必须报告 losses。引用文件中的 BibLaTeX `@dataset` 与知识侧车中的图谱 `@dataset` 契约不同，知识侧车不可传给 biber。
