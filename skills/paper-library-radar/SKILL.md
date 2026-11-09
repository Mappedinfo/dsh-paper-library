---
name: paper-library-radar
description: "Build a rapid source-backed research view inside Paper Library: define a topic, distinguish concepts, trace researchers and institutions, import evidence, and request a reviewable AI analysis."
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
