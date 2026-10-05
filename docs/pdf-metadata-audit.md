# 检查本地 PDF 的基础元数据

`scripts/audit-pdf-metadata.py` 按明确的本地文件清单，核对 Paper Library、采集索引、本地 Zotero 与 PDF 内嵌 CSL 的元数据覆盖。它只生成私有报告和待处理草稿，不改写 PDF 或目录，不调用模型、OSS 或公共检索服务。

## 运行

先用 [Vault Sync](https://github.com/mappedinfo/dsh-vault-sync) 的 `scripts/find-pdf-duplicates.mjs` 生成本地清单，然后运行：

```sh
uv run --offline python scripts/audit-pdf-metadata.py \
  --inventory /absolute/private/inventory/report.json \
  --library /absolute/private/paper-library \
  --attachment-root /absolute/private/zotero-attachments \
  --collection-index /absolute/private/selected_papers.json \
  --out /absolute/private/new-metadata-report
```

`--collection-index` 可省略或重复使用；文件为带 `local_file` 绝对路径的 JSON 条目数组。Zotero 需在本机开启本地 API；默认地址为 `http://127.0.0.1:23119/api/users/0`，仅接受无凭据的回环 HTTP 地址，拒绝重定向。报告注明无法获取或读取过程中发生变化的来源。通过附件路径匹配父条目，使用 `/items/top` 防止子项占用分页导致父条目漏取，并验证请求的父条目全部返回。

输出目录必须尚不存在、父目录已存在且位于所有备份源之外。目录权限为 0700，报告为 0600；报告含本地路径与私人文献资料，不进入公开 Git。

- `summary.md`：统计口径、覆盖率和限制。
- `report.json`：逐文件来源、字段和探针结果。
- `metadata-gaps.csv`：可筛选的缺项清单。
- `zotero-metadata.json`：本次匹配到的本地 Zotero 元数据。
- `enrichment-queue.json`：按文件 SHA-256 合并的待补全草稿，尚未执行检索或模型调用。

可显式传入 `--probe-report /absolute/private/previous/report.json` 复用自己的上一轮 PDF 探针。只有设备、inode、大小、修改时间、状态变更时间与权限全部一致才复用；目录及 Zotero 元数据重新读取。缓存一致性用于节省重复工作，不构成对恶意替换的密码学证明。

## 统计口径与限额

基础齐全指至少有标题、作者、发表年份。文件名占位、明确的文件名回退标题、只有编辑或译者的条目、PDF 创建日期均不能满足相应字段。存在这些字段不等于已核验出版信息；DOI、发表载体与 URL 独立统计，缺少 DOI 不一律判错。PDF Info 标题／作者和首页 DOI 只作线索。

只在完全相同文件字节间复用已有记录。不同批注版本、压平笔迹和未知外置目录不自动匹配；“未匹配到记录”不代表历史上从未获取。路径包含 `writer-test` 的文件另行统计；其他文件可能也不是学术论文，文件数不等于独立论文数。

最多 10,000 个文件、4 个并行子进程，每个探针最长 45 秒。单文件最大 512 MiB，内嵌 CSL 最大 1 MiB，PDF 仅提取首页文字来找至多 8 个 DOI 线索。macOS 未驻留文件跳过，读取前后检查文件身份。Zotero 最多 100 次请求，每次最长 15 秒、4 MiB，累计最多 64 MiB。损坏、解析诊断、超时和超限可见，不据此声称没有元数据。使用已有 PyMuPDF 环境，不自动安装或下载依赖。

## 如何低成本补全

先复用现有 Zotero／采集记录；再以确定的公开 DOI 获取登记元数据，核对标题、作者与年份，保留冲突。仍然缺项时，再让当前 DSH 配置中选定的模型提取少量首页文字，输出字段、原文证据和未确定项。按 PDF 哈希与标识符缓存，缺失项去重后再排队，不逐个重复副本调用模型。

模型提取应使用单独的“只整理资料”流程，固定模型、字符数、并发与调用上限，返回待审阅草稿，失败不自动升级到昂贵模型。不得从凭据文件发现新 key 或把已有 key 转发到新服务。是否可外发正文按文件来源及授权决定；持有模型 key 不代表任意私人文档已获外发授权。

当前插件的 `paper_analysis_start` 是全文分析流程，还会生成图谱／笔记并可能补写管理副本；不应把它当作元数据清点入口。本脚本没有调用该流程，也没有实现云端批量补全执行器。
