# Compact literature workbench

## Shared reading rail and compact cards

Accepted 2026-09-15: the reading rail contains “文献库” and “批注” tabs, using the original library and annotation nodes. The rail can sit on either side; changing its tab preserves search, list scroll, annotation state and PDF position. Ctrl/Cmd + K opens library search. Catalog mode restores the full library controls and returning to reading restores the tab. Narrow/fullscreen close returns space to the PDF. Metadata keeps its quick-edit surface and chat keeps its floating panel.

Cards have a 12 px title capped at two lines, an 11 px author/year row and a shared journal/PDF/citekey row, with 7 × 8 px padding. Full metadata remains inspectable; tags and rankings remain available in table/detail views. DSH theme behavior and host-owned state/side preferences retain their existing contracts.

Acceptance: the [13-flow browser fixture](validation/sidebar-browser.json) checks light/dark layouts, card height below 90 px, stable reading across repeated tab switches, PDF note editing, catalog controls and narrow/fullscreen recovery. The observed synthetic maximum is 84.06 px; 12 switches produce zero PDF scroll offset. This supersedes the earlier separate annotation overlay in the reading workspace.

## DSH appearance and theme ownership

Accepted 2026-09-15: Paper Library should feel like part of DSH while retaining its reading workflow. The interface uses neutral layered surfaces, system sans-serif typography, compact controls, restrained borders and familiar sidebar selection states. Annotation, language, metadata, graph and import surfaces share those tokens. PDF document pixels and the reader's chosen annotation colors retain their original appearance.

The DSH theme service owns the embedded palette and content font size. The visible iframe follows its resolved light/dark mode, CSS palette values and 12–17 px content setting without reloading, changing the current paper or replacing unsaved input. The plugin reads the official theme snapshot and change event; it does not write appearance settings. A standalone page follows `prefers-color-scheme` with a DSH-based fallback palette. No theme preference is stored in browser storage or another plugin record.

Acceptance: verify both modes at 430, 741 and 1400 px; retain usable catalog, sidebars, language, graph and dialogs; check visible keyboard focus, recoverable errors and representative text contrast; preserve reading and drafts across live changes. The 12-check browser receipt uses actual DSH CSS and the real plugin bridge with an isolated theme event source. Authenticated assets on the restarted local host are checked separately. These checks do not establish a full native-settings walkthrough or formal accessibility certification.

## Language learning and host-owned data

Accepted 2026-09-15: a reader can translate a selected passage directly, improve an expression without changing its meaning or evidence strength, and revisit difficult words encountered while reading. The selected paper's DSH model is authoritative. Opening the language panel, reading history, or reviewing vocabulary does not call a model; a translation or polish action does. Results remain AI-generated commentary and retain the source text, known PDF page, paper, model and request identity. Difficult terms must occur in the original selection; AI-suggested meanings start as “待学习”, and only the reader marks mastery.

The language panel floats above the reading surface, with processing, per-paper history and shared vocabulary views. Selection actions offer “直接翻译” and “优化表述”; the top ribbon offers “语言” and “难词本”. A result can be copied or added to the correct paper's existing conversation draft. Preparing that draft does not send it.

Durable content belongs to the host running DSH. UI drafts, references, preferences, reading positions, language history and vocabulary use private files under `$DSH_HOME/paper-library/<library-hash>/state`; standalone mode follows the same home resolution. PDFs/catalogs stay in the configured library, and conversation history stays in native Session persistence. Browser memory holds a bounded working set only. Browser caches, localStorage and sessionStorage are not authoritative stores.

Each disk record uses atomic replacement and version-checked writes. A cross-browser conflict keeps the saved host version and the current unsaved input visible, with an export recovery action. Reads and edits are paginated/bounded; durable records are not evicted after twelve papers. Old browser data is migrated once, verified on disk before removal, with conflicting versions retained as separate local backups. Invalid or oversized legacy data remains explicitly unresolved rather than deleted.

Acceptance: two independent browser contexts recover the same data with browser storage writes disabled; translation and polish use the paper model; source-grounded words accumulate and retain edits/mastery; retries avoid duplicate completed generations; stale async results do not overwrite a different paper or new draft. Existing reading and native-reference flows remain covered by regression checks. This supersedes browser-local draft storage in the preceding reading milestone.

## Current reading workspace revision

Accepted 2026-09-14 from the owner's next nine browser comments; implemented and verified separately from the earlier workbench milestone. Reading is the primary work surface. The library table remains for catalog management and the graph remains for exploring evidence relationships.

- A single import entry belongs to the library context. Dragging PDFs and pasting links continue to work. Scope and sort controls perform real server queries; decorative scope/sort captions are removed.
- A compact contextual ribbon follows reading, annotation, citation/export and catalog actions. The current paper title remains in its first row. Metadata edit is a top-ribbon control.
- PDF pages scroll continuously. Page geometry is inexpensive and bounded to 2,000 pages; at most three page images/text layers are retained, with one page/layout request in flight. Far pages are evicted, scroll positions remain, and failures have local retry controls. No full-document rasterization or resident worker is added.
- Highlighter, underline, strikeout and note modes and annotation color are chosen in the ribbon. PDF-native annotations keep page coordinates and persist with the managed PDF. Existing source files are unchanged.
- Annotation lists use the shared library/annotation rail described above. Metadata retains quick editing; drafts survive closing and switching papers in host-owned storage. Selecting catalog rows continues to be metadata-only.
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
