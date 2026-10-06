# Paper Library 与 Research Knowledge OS 的兼容边界

## 已有兼容

Paper Library 与 Research Knowledge OS（RKOS）可以交换经过选择、审阅的知识记录。Paper Library 的 `knowledge_export` 支持 `library-json` 和 `rkos-v3`：前者保留选定实体、来源快照、已接受图草稿和笔记；后者另生成引用 BibTeX、literature/research/authority 三种角色的知识 sidecar、映射清单和损失清单。导出有实体、记录数与 4 MiB 上限，不是整库备份。见 `src/dsh_paper_library/library_knowledge.py` 的 `export` 与 `rkos_export`，以及 `docs/api.md` 的 `knowledge_export` 说明。

两边都使用带类型的节点、Evidence、Observation、Assertion 与 Edge。RKOS 的确切字段、关系类型和侧车角色以 Research Graph v3 schema 为准；Paper Library 只在映射可验证时输出对应节点。Paper Library 不负责替用户推断缺失的层级、来源定位或关系置信度。

仓库已有合成夹具验证：选中的 Paper、Evidence、Claim 和 Assertion 可被上游解析器加载并通过 lint；数据集资料则被明确报告为当前 v3 适配不支持的部分。验证调用上游纯解析／构图／lint 函数，不加载个人注册表或 Wiki，也不调用模型。证据见 `scripts/validate-rkos-subset.py` 和 `docs/validation/rkos-subset.json`。

## 非无损差异

- Paper Library 的数据集实体可作为独立资源，允许数据集来源记录；RKOS v3 的 `--bib` 解析路径不接受 BibTeX `@dataset`，当前适配因此将引用记录放在 `citations.bib`，不伪装成 Paper，并在损失列表报告。数据集来源支持也会单独报告为未映射。
- Paper Library 的来源类型、验证状态、定位和元数据与 RKOS Evidence/Formula/Figure 的字段并非一一对应。来源无足够定位或验证信息、图表／公式缺少必需字段、Claim/Question/Concept 缺少 RKOS 所需层级时，相关记录不会被静默补造。
- 原生 Edge 类型与 RKOS v3 允许的端点／关系集合不同。缺少端点、源节点映射或编码置信度的关系会进入损失列表；中低置信度映射保持待审阅状态。
- Paper Library 的选定记录 JSON 才保留完整原生来源与字段。BibTeX sidecar 是有损互操作视图，CSV、引用 BibTeX 和图谱文件均不应反向当作原生记录写回。

具体损失代码由导出结果的 `losses` 字段给出；`complete: false` 表示本次 RKOS 文件未覆盖全部原生记录或关系。即便 `complete: true`，也只表示适配器未发现已声明的映射损失，不代表整库导出、语义等价或人工证据审查已完成。

## 推荐整合方式

保留两个项目的存储和职责边界，以显式的选定记录导出／导入作为最小整合层：Paper Library 继续管理其文献、PDF 原生批注和本地知识草稿；RKOS 继续维护其 Zotero/Better BibTeX bibliography 与 parser-only sidecars。用户审阅导出映射和损失清单后，再将适配文件交给 RKOS 的规范脚本处理。需要双向同步、数据集来源完整保真或跨项目统一身份时，应先定义版本化交换格式、冲突与归属规则，再评估迁移；目前证据支持互操作适配，不支持吞并任一方存储或实现。

## 未验证范围

现有验证只覆盖少量合成 Paper、数据集、来源和图节点；没有验证真实项目的批量迁移、复杂图谱覆盖、反向导入、往返无损、跨版本演进或外部插件组合。当前适配器的上游 lint 验证是离线合成脚本，不是 Paper Library 每次运行时自动执行的检查。
