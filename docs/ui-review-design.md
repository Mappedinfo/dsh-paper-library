# Compact literature workbench

Accepted 2026-09-14 from seven owner browser comments. The primary workflow is selecting a paper, reading and annotating it, then asking questions in its existing DSH conversation. A separate table supports catalog maintenance. The target collection is about 2,000 records / 1,000 PDFs, including use in a 741 × 597 pane.

## Acceptance contract

1. A compact top toolbar follows the selected paper. Citation copy, export, metadata, attachment and reader controls live there; selection-specific highlighter controls remain beside the selection.
2. APA 7, BibLaTeX and annotated PDF download no longer occupy the detail header.
3. Compact library cards show title, author/year, journal, citekey, PDF and available tags/ranking.
4. Expand the library into a searchable, server-sorted and paginated table. Support manual creation, editing and reversible removal/restoration. Row selection reads metadata only; reading explicitly opens one PDF page.
5. Reduce the paper title and header footprint so the reading surface remains useful in a narrow pane.
6. Display author affiliations, publication/received/accepted dates and sourced JCR year/category/quartile. Missing values remain missing. Public metadata lookup prepares an editable draft; it does not silently overwrite the catalog or manufacture journal rankings. Registration/deposit dates are not receipt dates; arXiv submission is not journal publication.
7. Persist methods, datasets, claims, evidence, concepts, authors and institutions with typed directed relationships, evidence and known page locations. Metadata-derived nodes remain distinguishable from reader assertions. Preserve existing paper/tag links; bound projections and rendering, with explicit truncation.

## Storage and validation

Catalog operations do not parse PDFs. Archive state is separate from paper identity and leaves managed files, annotations and relationships intact. The short-lived worker handles bounded queries; there is no background full-text index or resident graph engine. Metadata edits continue to use existing portable PDF backup/atomic-write behavior.

Synthetic fixtures must cover CRUD/recovery, sort/search/pagination, metadata preservation, graph node/edge operations and persistence, current-paper toolbar routing, page navigation, and narrow/wide overflow. Preserve native conversation reference regression coverage. Actual user library data is excluded from fixtures, screenshots and published receipts. Formal usability, JCR subscription access, WPS roundtrip and real-provider answer quality remain outside these checks.

Official metadata semantics: [Crossref fields](https://github.com/CrossRef/rest-api-doc/blob/master/api_format.md), [JCR glossary](https://journalcitationreports.zendesk.com/hc/en-gb/articles/28351666061457-Glossary), [arXiv API](https://info.arxiv.org/help/api/user-manual.html).
