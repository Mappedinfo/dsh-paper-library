# 导入已完成的原生代理分析

这是已有 Field Radar「AI 分析」面板的本地导入适配，不是新增模型端点。它接受明确由 ChatGPT 原生子代理完成的结果，复用 DSH 分析校验器核验来源和实体引用，将全部推断保留为 `needs_review`，不修改主题证据，不读取凭据、不调用外部模型，也不认证调用方自行填写的模型名称。

```
node scripts/import-field-radar-analysis.mjs --library /absolute/library --input /absolute/private/review.json
```

输入包含 `id`、`request_id`、主题的精确 `expected_revision`、`draft`（title、summary、concepts、distinctions、research_lines、relations、gaps），以及 `provenance:{kind:"chatgpt-native-subagent",external_model_calls:0,evidence_scope:"实际全文/摘录/题录覆盖范围与缺失"}`。除 gaps 外每项都需已知 `source_ids`；`paper_ids` 和 `scholar_ids` 也必须存在。整个输入不超过 128 KiB，分析正文还受既有校验器的更严格预算约束。

可选传入预先读取的 `knowledge-draft:field-radar:<topic-id>` 的 `expected_pointer_revision`，将结果选入已有面板。若用户已改变选择，会保留已保存草稿并报告选择冲突，不覆盖新选择，不应盲重试。省略此字段只保存，不改变当前选择。同一请求和相同内容幂等返回；同一请求但内容变化会拒绝。私有输入与回执不得进入 Git。

导入不等于逐篇完成 36 题协议。各文档的实际阅读范围和证据仍通过已有知识草稿流程保存，题录或无法获取全文的条目须如实保留状态。原生 PDF 问答另行完成放置预检、版本绑定和原子写入，不能直接从此草稿跳过检查。
