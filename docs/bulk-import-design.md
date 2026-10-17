# bulk-import / external_enrich 设计稿

状态: design · 2026-10-17 · 作者: Shiqi + assistant
关联: [external-sources](external-sources.md) · [pdf-metadata-audit](pdf-metadata-audit.md) · [api](api.md)

## 背景

2026-10-17 的 PaperAssets 治理（2400+ PDF 收敛到唯一事实源）暴露了文献库的一个缺口：
外部同步源（`external_scan`）能按文件名建立条目，但没有一条**批量元数据富化**的路径——
文件名之外的字段（DOI、期刊、作者列表、摘要）只能逐条手工补。

同日先在 Zotero 侧用手写脚本验证了整条管线（`batch_import.js`：文件名/首页证据 →
arXiv/CrossRef 抓取 → 三级去重 → 建条目），踩过的坑（API 版本断层、群组库限制、
storage 中转副本）恰好证明这条管线属于 Paper Library 的"收集"域，而不是 Zotero 插件层。

## 目标

新增 `external_enrich` 动作：对一个外部源的目录条目做**有界、可续跑、从不臆造**的
元数据富化。

1. 候选证据：文件名解析（复用 `parse_filename`）+ PDF 首页文本（DOI / arXiv ID 正则，
   复用 `pdf_write` 的判定风格；每文件最多读 2 页）
2. 元数据提供方（可注入，生产实现走 urllib）：
   - arXiv 文件名/首页 ID → arXiv API
   - DOI（文件名/首页/清单映射）→ CrossRef works
   - 仅标题 → CrossRef bibliographic 检索，标题词重合率 ≥ 0.6 才采纳
3. 三级去重（只标记，不删除）：DOI 归一化、题名归一化、文件 SHA256
4. 字段合并：缺失字段填充 + **文件名派生 title 允许被 API 标题升级**（`field_sources` 记录 `"arxiv-api"` / `"crossref-api"`）；用户核对过的字段永不覆盖；
   不降级已有 `needs_review`；不覆盖用户已核对字段
5. 报告：`enriched.tsv` / `unmatched.tsv` / `failures.tsv` / `manifest.csv` 写入
   `<library>/exports/bulk-enrich/<stamp>/`
6. 断点续跑：进度文件记录已处理条目；重跑自动跳过

## 非目标

- 不写 Zotero 数据库、不与 Zotero UI 交互（导入 BibTeX / 同步由既有机制完成）
- 不做 OCR、不做 LLM 元数据抽取（未来可选 provider）
- 不删除任何文件（重复只标记）
- 不修改原始 PDF

## 架构

```text
core.dispatch ── action 以 external_ 开头 ──▶ external.dispatch
    └─ external_enrich ──▶ bulk_enrich.dispatch(library, request)
            ├─ 选择：external_files JOIN papers，limit 内、缺 DOI、needs_review
            ├─ 证据：parse_filename + 首页正则（pymupdf，可选）
            ├─ 提供方：fetchers 注入（生产=urllib；测试=fake，离线）
            ├─ 合并：只填缺失 + field_sources 溯源
            └─ 报告：exports/bulk-enrich/<stamp>/ 四件套
```

- 路由零侵入：`external_` 前缀已路由至 `external.dispatch`，新增一个 action 分支
- 合并逻辑对齐 `external._update`：`setdefault` 语义 + `field_sources` 记录
- 群组库/存储模式约束：本动作只处理外部源条目（staged symlink），不触碰
  storage 存储附件（Zotero 群组库不支持链接附件的约束与之无关）

## 判定与去重规则（2026-10-17 实测校准）

| 规则 | 阈值/格式 | 来源 |
|---|---|---|
| arXiv ID | 文件名 `^\d{4}\.\d{4,5}(v\d+)?$` 或首页 `arXiv:\d{4}\.\d{4,5}` | batch_import.js 实测 |
| DOI | 首页 `10\.\d{4,9}/[-._;()/:A-Za-z0-9]+` 去尾点 | 同上 |
| CrossRef 标题采纳 | 标题词重合率 ≥ 0.6（归一化后词集合交/并参考集） | 260 篇实测 |
| arXiv 限速 | 1 请求 / 3 秒 | arXiv API 惯例 |
| 单 run 上限 | 200 条（`MAX_ENRICH_PER_RUN`），超出的留给下一次（断点续跑） | 对齐 MAX_INDEX_PER_RUN 风格 |
| 重复标记 | DOI 归一化相同 / 题名归一化相同 / SHA256 相同 → 报告 `duplicate_of`，不删除 | 治理约定"重复只标记" |

## 有界性与失败处理

- 每条失败（网络/解析/采纳失败）写 `failures.tsv`（含错误消息），不中断整体
- 请求超时 30s、重试 1 次；两次失败即记 failure，等待下次运行重试
- 断点：`<library>/state/bulk-enrich/<source>.progress.json`（done 列表）
- 契约对齐：metadata 缺失保持可见（unmatched.tsv 列出文件名派生的临时字段，
  明确标注"未采纳外部元数据"），**从不臆造作者/年份/DOI**

## 测试策略

- 全离线：fetchers 以 fake 注入（合成元数据），不访问网络
- 覆盖：arXiv 文件名富化、标题检索采纳、低重合不采纳（unmatched）、
  只填缺失不覆盖、重复标记、上限截断与续跑
- 沿用 `tests/test_external.py` 的 `make_pdf` / `request` 模式

## 里程碑

- M1（本骨架）：bulk_enrich 模块 + external_enrich 路由 + 离线测试
- M2：urllib 生产 provider + 首页证据 + 进度/续跑打磨
- M3：文档（external-sources.md 增补）+ 数据核对后批量应用于 PaperAssets 源
