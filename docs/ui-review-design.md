# Compact literature workbench

## Current reading workspace revision

Accepted 2026-09-14 from the owner's next nine browser comments; implemented and verified separately from the earlier workbench milestone. Reading is the primary work surface. The library table remains for catalog management and the graph remains for exploring evidence relationships.

- A single import entry belongs to the library context. Dragging PDFs and pasting links continue to work. Scope and sort controls perform real server queries; decorative scope/sort captions are removed.
- A compact contextual ribbon follows reading, annotation, citation/export and catalog actions. The current paper title remains in its first row. Metadata edit is a top-ribbon control.
- PDF pages scroll continuously. Page geometry is inexpensive and bounded to 2,000 pages; at most three page images/text layers are retained, with one page/layout request in flight. Far pages are evicted, scroll positions remain, and failures have local retry controls. No full-document rasterization or resident worker is added.
- Highlighter, underline, strikeout and note modes and annotation color are chosen in the ribbon. PDF-native annotations keep page coordinates and persist with the managed PDF. Existing source files are unchanged.
- Annotation lists share the reading workspace in a left/right movable sidebar. Metadata uses a quick-edit sidebar; drafts survive closing and switching papers under an explicit bounded cache. Selecting catalog rows continues to be metadata-only.
- The per-paper DSH conversation is a floating, resizable reading panel, with its existing reference collection, drafts, model routing and native main-conversation bridge. Closing the panel stops its history polling; preparing references never sends them.
- Fullscreen keeps the toolbar available and expands the PDF workspace. Escape or the fullscreen button restores the normal view; a reading-focus fallback is visible if the host denies native fullscreen.
- Tool instructions and loading/errors occupy a compact toolbar status line. The old static paragraph below a page is removed.

Acceptance requires rendered narrow/wide reading checks, free scrolling and bounded residency, all four portable annotation types, left/right sidebars, metadata draft recovery, floating conversation/reference regression checks, fullscreen recovery and preserved catalog/graph flows. Synthetic documents only; no user annotations or provider requests are used in UI tests.

The initial workbench was accepted 2026-09-14 from seven owner browser comments. The target collection is about 2,000 records / 1,000 PDFs, including use in a 741 × 597 pane. Its original contract follows; single-page reading and separate annotation/conversation pages are superseded by the revision above.

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
