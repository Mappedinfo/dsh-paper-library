---
name: paper-library-radar
description: "Build a rapid source-backed research view inside Paper Library: define a topic, distinguish concepts, trace researchers and institutions, import evidence, request a reviewable AI analysis, and render local frequency, yearly publication, citation and geographic charts."
---
# Integrated research view

Use when the user asks for rapid field investigation or topic analysis. This workflow is separate from a personal close-reading lesson: do not require the user to read papers first. Work inside the existing Paper Library, not a new dashboard.

## Evidence first, then explicit analysis

1. Clarify the question only when needed. Separate generation, prediction, explanation and evaluation rather than conflating them.
2. Call `library_field_radar` with `operation:list` and `input_json:{}` to find an existing topic, then `get` with its exact id. Retain its revision.
3. Collect bounded metadata or supplied excerpts with existing library/search tools. `library_search` searches metadata only; `library_get` reads metadata. When the user requested paper-content inspection, use `library_paper_search` and `library_paper_read` for selected papers/pages, not an unrequested full-library scan. Public source search, when available, does not authorize downloads or private-data uploads. Never invent source URLs, access dates, affiliations or identities.
4. Form an explicit topic document using the schema below. Import through `library_field_radar_import` with `{document,expected_revision}`. Initial revision is numeric 0. Update requires the exact revision from get. Never blindly retry a conflict. Tool input is at most 128 KiB including its JSON envelope; for larger documents use the existing radar UI JSON import (max1MiB), or genuinely scope a smaller topic. Do not silently omit sources to fit.
5. `library_field_radar` operation `match` accepts `{papers:[{id,title,doi?}],offset?,limit?}`. It queries existing library metadata only. Multiple candidates remain ambiguous; an incomplete search is not an exact identification. Do not merge people by name, attach papers by fuzzy names, or treat an imported local_paper_id as verified.
6. After the user asks for AI analysis, use `library_field_radar_analyze` with `{id,expected_revision,request_id}`. This makes one configured DSH model call and consumes quota. Preserve request_id to retrieve the result using `library_field_radar` operation `analysis_get` with `{id,request_id}`. Reusing it never regenerates. Pending after interruption is uncertain; failed/pending must not trigger automatic new IDs or spending. A new explicit retry uses a fresh ID. Respect host approval.
7. Show the saved draft in the integrated radar UI or summarize the returned sourced draft. Drafts are AI inferences needing review, never verified findings and never automatically applied to the topic. State metadata/excerpt limits. Do not claim to have read full texts that were not provided.

## Document shape

Use `{schema_version:1,topic:{id,title,question,scope},sources:[],papers:[],scholars:[],claims:[]}`. IDs are 1–120 letters, digits, dots, underscores or hyphens.

- Source: `{id,url,title,evidence_level,accessed_at,excerpt?}`. HTTP(S) URL without credentials. Missing access date stays null. Record whether the evidence is metadata, abstract, full text or a supplied quotation.
- Paper: `{id,title,authors,year,doi,url,task,method,source_ids,reading_status}`. Missing year/DOI stays null. Supported extensions include abstract, summary, dataset, evaluation, evidence_scope and organization_at_publication. Cite source IDs.
- Scholar: `{id,name,aliases,organization,identity_status,source_ids,contributions:[{year,paper_id,summary,source_ids}]}`. Separate uncertain identities even when names match. Current affiliation is not historical affiliation. Add groups, institutions, collaboration, dates and places only when supported.
- Claim: `{id,text,source_ids,confidence}`. Distinguish reported evidence and tentative interpretation.

Limits: 500 papers, 300 scholars, 1000 sources, 1000 claims, 1MiB document. Analysis uses bounded saved metadata/excerpts and claims, not arbitrary local files, PDFs, hidden context or the complete legacy database. Over-budget context is rejected visibly, not silently truncated.

## Analysis questions

Define the topic; distinguish adjacent concepts and tasks; map who studied what, when and where, with whom; identify research groups and institutions; describe conceptual distinctions, data used and relations studied; expose evidence gaps. The draft has summary, concepts, distinctions, research_lines, relations and gaps. Entries cite source_ids, optionally scholar_ids/paper_ids. Inference and needs-review markers must remain visible.

## Automation boundary

These tools enable requested agent-driven workflows, not an autonomous schedule. Do not invent periodic checks, monitoring, downloads, publication, model runs or profile updates. The user must request recurring work before a scheduling system is used. Topic imports do not alter PDFs/catalog metadata. Model generation creates a separate durable draft only. No credentials or runtime configuration can be supplied in tool arguments.

## Headless images

Use `library_field_radar_render` for requested PNG/SVG research images from the saved topic. Pass topic ID, view, filters and pagination; rendering is local and does not call a model, fetch sources or require a browser. The receipt includes the exact local output path, evidence version, source IDs and coverage. Use the authorized attachment channel to send that existing file; never publish or claim delivery merely because rendering succeeded. Long text remains in the same private JSON sidecar. Reuse existing filters rather than silently expanding the corpus.


## Charts and spatial evidence

Use the existing 「领域研究 → 图表与地图」 and `library_field_radar_render`, not a separate site or app. Keep the selected topic revision and query/task/year filters. Choose the chart that answers the user's question:

- `view:frequency`, `frequency_by:task|method|dataset`: document-level label counts. Multiple labels can exceed the paper count. Do not treat a missing label as a measured zero.
- `view:publications`, `group_by:subtopic|task|research_group`: stacked annual counts. Use explicit subtopic or group records; do not infer a stable group from shared authors or institutions. Overlapping memberships use fractional 1/k weights so each paper totals one; explain fractional bars. Missing years/groups remain visible.
- `view:citations`: only sourced, verified, directed citation edges. Never substitute shared keywords, authors, lineage relations or aggregate citation counts for edges.
- `view:geography`: supplied coordinates/GeoJSON/spatial values only. If only study-area geometry exists, highlight that area and label it as study-area coverage, not observations. If only a place name is available, report missing geometry rather than invent coordinates, boundaries or density.

Use `format:png|svg`. Inspect the returned `available`, `warnings`, `coverage` and source/version receipt before describing the chart. An unavailable-data figure is a useful gap report, not a completed citation network or empirical map. Existing timeline, concept, research-line and scholar views remain available. For executable CLI examples and input data conventions, read `docs/field-radar.md` in this plugin. Rendering and deterministic aggregation do not need an additional AI analysis request.


## Presentation language editions

For requested English presentations, pass `language:en` to `library_field_radar_render`; use `language:zh` for the Chinese-primary edition with original English terms. The integrated chart toolbar exposes the same choice. Preserve topic revision, filters, data, evidence markers and counting rules across editions.

Before an English render, prepare faithful `document.translations.en.labels` mappings from exact saved source strings to English text when needed. Preserve names, quantities, affiliations, dates and uncertainty; translations must not add findings. Save mappings through the existing version-checked topic import, retaining original fields and source IDs. Rendering never calls a model or performs automatic translation. Unmapped Chinese fields are replaced by neutral entity IDs or `Translation unavailable` and reported as missing; tell the user what remains untranslated instead of presenting these placeholders as a finished translation. Inspect receipt.language and translation warnings, and verify the delivered English chart has no residual Chinese text. Keep original evidence in the private sidecar even when the figure is English-only.

## Imported multidimensional relations

Use the existing 「领域研究 → 多维关系」 for a supplied offline relations report. Import its structured `relation-input.json` through `field_radar_relations_import` with the exact `expected_revision` from `field_radar_relations_get`, or `scripts/import-field-radar-relations.mjs INPUT.json LIBRARY REVISION [STATE_HOME]`. Initial revision is 0; state home must match the host. Never execute arbitrary supplied HTML or open unrestricted local-file routes. The bundled renderer regenerates bilingual Sankey/circular views from validated JSON; the snapshot is private and independent of the selected research topic.

Keep source dates, IDs, uncertainty and classification evidence. Filtering highlights matches while chart widths retain the complete corpus, and paper cards are paginated. Rebuild and explicitly reimport JSON for corpus changes; no automatic scraping/model request is implied. Limits: 1 MiB, 200 records, 2–6 dimensions with at most 24 categories each; excessive circular tracks are rejected. Read docs/field-radar.md for the input/CLI contract. No PDF, source HTML or existing topic is overwritten by relation import.


## 文献表格与 Slides 复制

用户需要按研究组、论文简称、具体任务／输出、数据集及开放性、方法、年份和 OD 生成设定比较时，复用「领域研究 → 文献对照表」，不创建另一个工具台。先用 `library_field_radar_table` 读取当前主题与筛选的七列表格；需要文件时用 `library_field_radar_table_export`，格式为 html、tsv、csv 或 markdown。传入主题 ID、准确 expected_revision、filters、offset 和 limit（最多 100），检查 count/total/has_more，不把一页说成完整主题。界面提供每页 20 篇和「复制到 Slides」。

表格不调用模型。若用户要求自动提取，复用原有 `library_field_radar_analyze`；新草稿最多提供 20 篇 `paper_comparisons`，仍为 AI 待核。表格工具可显式传同主题、同版本、已完成的 analysis_request_id 复用草稿；不因旧分析缺字段自动消耗模型，不覆盖主题或 PDF。现有逐篇分析可按原证据流程加入主题，未提供的全文不假装已读。

OD 标准为生成 OD 流量，目标区域推理不输入其历史 OD；训练可使用历史 OD，评估真值不算推理输入。需要目标历史／部分 OD 的补全或校准不符合。缺直接字段证据时保留未知，不凭 Deep Gravity 等名称判断。研究组不能由机构／共著猜测，数据开放不能由代码开源推出，简称缺失保留全称。逐格 source_ids、证据、审阅状态和来源范围必须保留。完整 comparison schema 与 CLI 见 docs/field-radar.md。
