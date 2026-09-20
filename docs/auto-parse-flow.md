# 文献落库后的自动解析流程与数据产出

本文描述「文献进入 Paper Library 之后会发生什么」：一次导入触发的自动整理（auto analysis）、
每个阶段写下的数据、这些数据的存放位置与体积上限，以及什么时候不会自动发生。

图中所有上限都来自代码里的显式预算（`src/dsh_paper_library/paper_analysis.py`、
`src/harness/paper-analysis.mjs`、`src/harness/paper-analysis-queue.mjs`）；体积样例来自
13 页确定性测试 fixture，不是 1000 篇真实文献的实测值。

## 一张图：从导入到草稿

![落库后的自动解析流程](images/auto-parse-flow.jpg)

<details><summary>Mermaid 源码（可复制到画板或笔记）</summary>

```mermaid
flowchart TB
  A1["① 导入来源<br/>DOI · arXiv · 公开 URL · 本地 PDF · 另存附件"] --> A2["① 落库<br/>papers 行 + FTS5 索引<br/>受管副本 pdfs/citekey.pdf<br/>原始文件保持不动"]
  A2 --> B0{"自动整理是否开启<br/>模型服务可用<br/>且 auto_analysis = true"}
  B0 -- "否" --> B1["仅入库 · 状态 idle<br/>之后可手动整理"]
  B0 -- "是" --> C1["② 自动队列 admission<br/>key analysis.queue:v1<br/>request_id = import 加 id 哈希<br/>已有任务或已有结果则跳过"]
  C1 --> C2["② 持久队列与 drain<br/>最多 2000 条 · 200 KB 以内<br/>并发等于分析服务槽位<br/>同一篇文献内批次串行"]
  C2 --> D1["③ 切批 paper_analysis_batch<br/>每批最多 8 页 · 每页最多 8000 字符<br/>每批最多 24000 字符"]
  D1 --> D2["③ 隔离 spawn agent<br/>只接收本批文本<br/>工具按生成代次收回"]
  D2 --> D3["③ 知识图谱草稿<br/>knowledge_drafts mode=graph<br/>每批最多 12 节点 · 20 条关系与断言<br/>同时冻结 knowledge_sources 证据快照"]
  D3 --> D4["③ 元数据补齐 analysis_fill<br/>只填空缺字段并记录 field_sources<br/>不臆造作者 · 日期 · DOI"]
  D4 --> D5["③ 阅读笔记草稿<br/>knowledge_drafts mode=note"]
  D5 --> D6["③ 证据图谱评审草稿 auto_review<br/>mode=note · 9 个评审小节<br/>可叠加 reviewProfile 个人方法层"]

  D2 --> E2
  C2 --> E2
  D2 --> E3
  D3 --> E1
  D4 --> E1
  D5 --> E1
  D6 --> E1

  E1["④ catalog.sqlite3<br/>papers · knowledge_sources<br/>knowledge_drafts · FTS5"]
  E2["④ 状态 JSON<br/>批次进度 · 结果缓存<br/>analysis.queue-result 加 id 哈希"]
  E3["④ 失败记录<br/>status=failed · stage · error"]
  E1 --> F1["⑤ 所有模型产出以 needs-review 起步"]
  F1 --> F2["人工接受 → 成为正式笔记与知识"]
  F1 --> F3["拒绝或改写 → 不进入正式知识"]

  classDef intake fill:#eef3ff,stroke:#7d9bcc,color:#1f2d45
  classDef auto fill:#fff8e8,stroke:#d9b26a,color:#4a3a12
  classDef output fill:#eefaf1,stroke:#79b98d,color:#173d24
  classDef review fill:#f5eefc,stroke:#a98ccc,color:#33204a
  class A1,A2,B0,B1 intake
  class C1,C2,D1,D2,D3,D4,D5,D6 auto
  class E1,E2,E3 output
  class F1,F2,F3 review
```

</details>

## 存放位置

![库目录与状态目录](images/auto-parse-storage.jpg)

<details><summary>Mermaid 源码（可复制到画板或笔记）</summary>

```mermaid
flowchart LR
  L["库目录<br/>由用户选择，默认 ~/.local/share/dsh-paper-library"] --> S1["catalog.sqlite3"]
  L --> S2["pdfs/ 受管 PDF 副本"]
  L --> S3["backups/ 每篇一份批注前备份"]
  L --> S4["exports/ references.bib 与数据集导出"]
  L --> S5["knowledge/staging · knowledge/notes"]

  S1 --> S1a["papers 行 + FTS5 全文索引"]
  S1 --> S1b["knowledge_sources 冻结证据"]
  S1 --> S1c["knowledge_drafts 草稿与评审"]
  S1 --> S1d["datasets · projects · links · feedback"]

  H["状态目录<br/>~/.dsh/paper-library 下按库路径哈希分目录"] --> H1["分析队列 · 批次进度 · 结果缓存"]
  H --> H2["界面偏好与选项"]
```

</details>

## 数据产出对照表

| 产出 | 位置 | 内容 | 上限 |
| --- | --- | --- | --- |
| 文献元数据 | `catalog.sqlite3` `papers` | 题录、DOI、状态、标签 | — |
| 检索索引 | `catalog.sqlite3` FTS5 | 题录与已解析文本的全文检索 | — |
| 受管 PDF | `pdfs/` | 导入时的副本，自动重命名 | 与源文件等大 |
| 批注前备份 | `backups/<id>.pdf.bak` | 每篇一份，写入前生成、成功后覆盖 | 与 PDF 同量级 |
| 证据快照 `knowledge_sources` | `catalog.sqlite3` | 冻结的原文片段与真实页码 | 每批 ≤8 条 · 每条 ≤8,000 字符 · 每批 ≤24,000 字符 |
| 图谱草稿 `knowledge_drafts(mode=graph)` | `catalog.sqlite3` | 节点、关系、断言 JSON | 每批 ≤12 节点 · ≤20 关系与断言 · body ≤64,000 字符 · payload ≤200,000 字节 |
| 阅读笔记草稿 `knowledge_drafts(mode=note)` | `catalog.sqlite3` | 可追溯的 Markdown 笔记 | 样例约 0.75 KB/篇 |
| 评审草稿 `knowledge_drafts(mode=note)` | `catalog.sqlite3` | 9 节证据图谱评审 | 样例约 1.2 KB/篇 |
| 运行状态 | `~/.dsh/paper-library/<sha256>/*.json` | 队列、批次进度、结果缓存、偏好 | 队列 ≤2,000 条且 ≤200 KB · 单条状态 ≤256 KiB |
| 导出 | `exports/` | `references.bib`、CSV、Markdown、BibTeX | 手动触发 |

图谱草稿是节点与关系的唯一来源；阅读笔记和评审草稿都是 `mode=note`，不贡献节点与边。

## 分批预算（每篇文献）

| 参数 | 值 |
| --- | --- |
| `MAX_PAGES` | 8 页/批 |
| `DEFAULT_PAGES` | 3 页（未指定时） |
| `MAX_PAGE_CHARACTERS` | 8,000 字符/页 |
| `MAX_CHARACTERS` | 24,000 字符/批 |

设一篇文献共 P 页、批数 B = ⌈P / 8⌉，则上限为：节点 ≤ 12B、关系与断言 ≤ 20B、
证据快照 ≤ 8B。一篇 20 页文献最多 3 批，即 ≤36 节点、≤60 条关系与断言。

## 什么时候不会自动发生

- `auto_analysis = false`，或模型服务不可用：文献正常入库，整理停留在 idle，可手动开始。
- 该文献已有运行中的整理任务，或已有保存的结果：直接返回现有状态，不重复排队。
- 队列超过 2000 条或 200 KB：本次不再入队并给出提示，文献本身已经保存。
- 宿主重启：只从队列记录恢复；无法确认是否完成的生成会被移除而不是重放。
- `analysis_fill = false`：跳过元数据补齐，其余阶段照常。
- `auto_review = false`：跳过证据图谱评审草稿，图谱与笔记照常。

## 不属于自动流程的相邻功能

以下都需要人明确发起，不在导入触发的链路上：

- 研究难点挖掘 P1–P4：`challenge_scan` → 抽取 → 主题汇总与合并 → 校验、对比与导出。
- 阅读器批注：以标准 PDF 对象写回，读取时直接从 PDF 还原，不依赖目录行。
- 知识工作流：`knowledge source_put` / `draft_put` 建立可审核的证据与关系草稿。
- 导出与引用：`references.bib`、CSL 引用、数据集导出。
- 白板、项目、数据集与文献关联：各自独立的写入路径。
