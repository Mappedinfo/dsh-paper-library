# Validation, 2026-09-14

The compact workbench passes **184 JavaScript tests, 82 Python tests, 13 workbench browser flows and 11 rerun native-reference browser flows**. The installed host was restarted after an authenticated idle check; new capabilities and assets pass [installation verification](validation/workbench-install.json). The existing standalone review page was visibly refreshed. No external model was used. The previous reference milestone's 13 native checks and 2,000-record/1,000-PDF memory run retain their original scope; they are not new workbench capacity measurements. Original code and dependency licenses remain distinguished in `THIRD_PARTY.md`.

The [workbench browser receipt](validation/workbench-browser.json) covers metadata-only table selection, 40-row search/sort pagination, create/edit/archive/restore, affiliation-source preservation, scientific node and edge CRUD, filtering, page return and fresh-page persistence. Screenshots cover 741 × 597, 430 × 800 and 1400 × 950 layouts without document horizontal overflow; tables and toolbars have bounded internal horizontal scrolling. Reproduce with `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/workbench-browser-fixture.mjs`. All mutations use synthetic documents in an ignored isolated library. This is functional/rendered acceptance evidence, not a formal usability study.

## Native conversation checks

The current **184 JavaScript / 82 Python** run is recorded in the [automated receipt](validation/automated.json), including client build, browser syntax and CSL integrity. New cases cover catalog sort/archive races, metadata schemas and source preservation, read-only identity-checked lookup drafts, graph projection identity, bounded CRUD and actual Harness tool registration. Existing cases cover exact source extraction, changed/deleted sources, duplicate annotation IDs, source budgets, immutable snapshots, native source/body hashes, durable usage, additive selection and draft recovery. Cold Sessions, model inheritance, PDF feedback and acquisition cases continue to pass. Reproduce with `node scripts/validate.mjs`, or `npm test` and `uv run --offline pytest -q`.

[Thirteen isolated Harness checks](validation/paper-chat-harness.json) passed with two deterministic model generations and **zero external model requests**. The fixture imports fresh synthetic PDFs, saves a page-two annotation, creates cold Sessions, reuses one paper's identity and keeps another paper inactive. It prepares a reference without marking it sent, edits the PDF, and verifies that the submitted model input still contains the frozen original source. Logged usage identifies the later PDF version as updated. Native main-composer plain-token submission also resolves the source and updates usage without the plugin's send operation. Retrying one logical request does not duplicate a turn or generation. Explicit PDF reply saving retains Session/message provenance, is idempotent, and ignores browser-supplied fake text.

The fixture starts an isolated Harness profile and uses real Session persistence, prompt admission and PDF operations. Its deterministic model replaces the external provider only. Reproduction is documented in [the native-chat fixture](../tests-js/fixtures/harness-chat/README.md), with `tests-js/paper-chat-harness-smoke.mjs` as the executable entry. This proves the cold Session can be adopted by the native conversation controller; it is not a paid-model quality evaluation or a browser usability study.

A separate test opens 100 synthetic paper identities through a service fixture and checks that it retains zero Agents and zero active history followers. An actual built Harness Session and persistence validator accept the cold title/model seed. These are lifecycle/format checks, not measured RSS for a real collection. Once the user opens a native main conversation or sends a message, that Agent's residency belongs to Harness; the plugin claims no idle eviction of those Agents.

The list-cache regression checks that the optional native projection checkpoint occurs only after the seed log is flushed and closed, does not activate an Agent, and remains nonfatal on cache failure. Source inspection confirms that Harness intentionally hides noncurrent zero-turn Sessions and presents the selected one as “New Session” with a hidden main header. The stored paper title is retained and becomes the ordinary row title after the first prompt; this empty-session UI is not changed by the plugin.

The current [reference browser walkthrough](validation/annotation-reference-browser.json) passes **11 flows** using fresh three-page synthetic PDFs and 46 user annotations. It selects three of 45 notes across pagination, switches papers without losing each draft, adds note 46 without changing the chosen set, adopts an edited version explicitly, and checks wide/narrow selection views. Inline sending records exact sources and updates pending counts; new and sent notes can be mixed. All 46 notes become one native chip while preserving an existing draft. After reload, the plain token still opens the frozen inspector, navigates to the PDF and submits through the main composer with usage reconciled inline. Missing snapshots show errors and do not make the composer uneditable or start a model generation. Expanded inspector and PDF-frame bounds are asserted against the viewport after correcting horizontal overflow. The run makes three deterministic local generations, zero external calls and records no browser errors. It is an agent walkthrough, not a formal usability study.

The previous [ten-flow conversation walkthrough](validation/paper-chat-manual.json) retains earlier evidence for page-two annotation drafts and explicit reply-to-PDF saving. Those older results are not relabeled as current reference checks.

The existing `web` profile was previously upgraded with the additive installer for the per-paper conversation version. Its [installed-host receipt](validation/paper-chat-install.json) verifies authenticated library availability, native conversation capability and served assets; the native PWA was refreshed and the library reopened. This earlier check made zero model requests and read no private PDF. The current [reference installation receipt](validation/annotation-reference-install.json) separately confirms the additive upgrade, preserved user patch and plugin registrations, idle restart, `annotationReferences:true`, authenticated assets and refreshed native PWA/library pane. This check opened no private PDF and requested no model.

## Earlier functional evidence

- The preceding intake milestone recorded **26 Python tests**: catalog/import batching and interruption recovery, bounded PDF inspection, Unicode filenames/collision and rename-journal recovery, metadata-only item attachment evidence, FTS updates, exact dedup/conflict handling, native annotations, rotations, concurrent writes, source preservation, fresh-catalog PDF recovery, encrypted/signed refusal and atomic feedback context validation.
- That milestone recorded **60 JavaScript tests**: public acquisition, DNS/redirect checks and pinned connections, byte/deadline/concurrency budgets, raw PDF upload, title identity and enrichment provenance, UI drop/paste/queue continuation, actual Harness skill registry, ToolRuntime and lazy client, shared composer model subscriptions, AI terminal/cancellation handling, citation rules, paginated metadata import and complete PDF/feedback copy/reimport flow. AI responses were deterministic test responses, not live provider evaluations.
- Nine isolated Harness web checks: plugin load, session skill catalog with exact bundled skill path, browser bundle, authenticated page, authentication refusal, cross-origin refusal, model metadata, worker and deployment-library isolation. No model request was made; see [host receipt](validation/harness-smoke.json).
- Full capacity-library export: all 2,000 records re-parsed from BibLaTeX with 2,000 unique original keys and no missing keys; see [export receipt](validation/export-2000.json).
- Browser walkthrough through Codex computer-use tools: loaded three synthetic papers; opened a PDF; copied APA text to clipboard; saved a Chinese page note and selection highlight; refreshed and observed persisted notes; created a relation and observed its recorded reason in the graph. This is an agent walkthrough, not a formal usability study.
- Earlier Harness sidebar walkthrough with the 2,000-record fixture: opened the reader, observed inherited model A, changed the Harness composer to model B and observed the standalone-feedback route follow it. An unsaved Chinese annotation draft survived switching back to A. The selection-only fixture refused generation before network I/O. This covers the previous continuously-following route, not the new per-paper model selection. Reproduce setup with [the model fixture](../tests-js/fixtures/harness-models/README.md).
- Automatic intake browser walkthrough: pasted the [W3C dummy PDF](https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf), observed real network download, saved filename and readable page; selected two generated PDFs together and observed sequential automatic saving; rejected a nonstandard-port target with input/retry retained. No browser error/warning logs were recorded. The OS drag gesture itself was not automated; synthetic events exercise the actual application drop handler. See [intake walkthrough](validation/intake-manual.json).
- WPS attempt did not complete because native application automation failed to maintain a usable file dialog. WPS viewing/saving remains unverified; no existing user document was edited for this test.

The 26/60-test intake receipt is preserved in [Git history at the intake milestone](https://github.com/mappedinfo/dsh-paper-library/blob/8d7b4a5/docs/validation/automated.json). The 101/39 conversation and 151/48 reference runs are historical; current `automated.json` records 184/82. Other historical checks include [earlier installed profile](validation/install.json), [preserved prior configuration](validation/install-preservation.json) and [earlier manual walkthrough](validation/manual.json).

## Capacity and memory

The [current reference-memory receipt](validation/annotation-reference-memory.json) uses a verified copy of the synthetic **2,000-record/1,000-PDF** fixture and leaves the original unchanged. It reads one paper with 45 notes, creates 20 other cold paper Sessions, and performs 30 history polls. There are zero active Agents, zero model generations and zero remaining workers at the idle checkpoint. The history polls start short metadata workers but open zero PDFs.

| Current reference workflow | Observed memory |
|---|---:|
| Isolated Harness ready after authentication | 594.97 MiB RSS |
| After a five-second prework settle | 594.98 MiB RSS |
| After the 45-note catalog | 598.14 MiB RSS |
| After the exact 45-note snapshot | 602.17 MiB RSS |
| After 20 additional cold papers | 569.17 MiB RSS |
| After 30 history polls and five seconds idle | 569.88 MiB RSS |
| Metadata-only worker, maximum `ru_maxrss` | 23.05 MiB |
| Annotation catalog worker, `ru_maxrss` | 58.08 MiB |
| Exact annotation context worker, `ru_maxrss` | 58.14 MiB |

Host samples are taken every 200 ms; the observed maximum of 602.17 MiB is a sampled maximum, not a true high-water mark. Worker `ru_maxrss` is a per-process high-water measurement and includes the small standard-library diagnostic wrapper. Browser and benchmark-driver memory are excluded from this capacity run. No explicit GC or matched host-without-plugin baseline was used, so lower later RSS cannot be called a feature memory saving. The older Host figures below are from another run and are not a before/after comparison. This workflow does not measure scanned PDFs, activated long-lived Agents or large sent histories. Reproduce with `node scripts/benchmark-annotation-references.mjs` after preparing the capacity fixture and isolated profile described by [the native-chat fixture](../tests-js/fixtures/harness-chat/README.md).

The separate [46-note browser walkthrough](validation/annotation-reference-browser.json) samples startup, the reference drawer, the restored inspector and idle state after three completed local-model turns. Across those four samples, Host RSS reaches 598.5 MiB, the four Chromium processes' summed RSS reaches 759.734375 MiB, and the main-page JavaScript heap reaches 54.68736267089844 MiB. These are observed sample maxima. Multiprocess RSS double-counts shared pages; the heap measures only the main page renderer, and worker peaks are excluded. Do not add these values to claim total physical application memory or compare them with the separate cold-Session capacity run as a memory saving.

The following earlier measurements predate automatic link intake and native conversations. They remain historical capacity evidence.

Fixture: **2,000 CSL records, 1,000 PDFs**, four pages per PDF, 20,600 bytes per synthetic text PDF. Disk catalog was about 3.9 MB. These small PDFs do not represent scans or large embedded images.

| Scope / operation | Observed memory |
|---|---:|
| Python status worker peak RSS | 24.23 MiB |
| Python 100 exact/broad searches peak RSS | 26.72 / 26.80 MiB |
| Python one-page render peak RSS | 63.36 MiB |
| Python 30 document switches peak RSS | 68.38 MiB |
| Standalone Node adapter after 30 searches | 51.89 MiB |
| Standalone Node adapter after rendering and APA | about 60 MiB |

The CSL formatter originally raised the long-lived Node process to roughly 280 MiB in this fixture. It now runs in an isolated short-lived Node process. The host retains about 60 MiB after APA in the Node-only check; **the formatter's transient allocation still exists while formatting**. This change addresses retained memory, not a claim of zero allocation.

An additional test ran two isolated Harness Node hosts concurrently: baseline web and identical web plus this plugin. It took RSS snapshots at matching stages; there was no browser or explicit GC.

| Stage | Baseline Harness | Harness + plugin |
|---|---:|---:|
| Recently ready | 124.92 MiB | 466.39 MiB |
| After 100 catalog searches | 60.48 MiB | 92.72 MiB |
| After 20 PDF page renders | 60.58 MiB | 208.38 MiB |
| After APA export of 20 references | 60.56 MiB | 207.94 MiB |
| After another five seconds idle | 60.94 MiB | 201.50 MiB |

No Python or CSL child remained at the idle checkpoints. Startup, V8 GC and OS scheduling differ between processes; subtraction does not establish exact plugin allocation. RSS snapshots are not peaks. **Browser memory and simultaneous worker peaks are excluded**, so none of these rows is the total desktop application's memory. Long-duration use and the actual literature collection remain unmeasured.

Raw sanitized evidence: [Python capacity](validation/capacity.json), [Node adapter](validation/node-memory.json), [Harness hosts](validation/harness-memory.json). Reproduce using `scripts/benchmark.py`, `scripts/benchmark-node.mjs` and `scripts/benchmark-harness.mjs`. The host benchmark creates and stops only its own isolated hosts.

## Boundaries

Metadata/abstract retrieval only; no full-text index, OCR or resident embeddings. One managed PDF per record. Metadata input is capped at 2,000 records / 32 MB, processed in batches of 100; larger exports must be split. PDF import is capped at 250 MB / 2,000 pages. Rendering is capped at 4 million pixels and 4,000 pixels per dimension. Annotation export is bounded and reports truncation. Native reference catalogs hold at most 1,000 user-note identities with 240-character text/comment previews. Exact selected sources plus temporary selection default to 24,000 Unicode characters; deployment configuration permits 1,000–96,000, with explicit rejection on overflow. Temporary selection separately allows 8,000 characters and the question 4,000. No automatic batch reading or model-memory guarantee is claimed.

Inline history contains at most 20 committed human/assistant messages, 6,000 characters per message and 48,000 total; full tool output, approvals, stop controls and older history are on the main page. Explicit reply-to-PDF saves require an attached PDF and a completed assistant event in the current history window, with at most 28,000 text characters. They preserve Session/message provenance and do not infer annotation associations. Archived Sessions remain preserved, with an explicit unavailable state because the current Harness public API has no unarchive method. Moving the library directory does not automatically migrate the Session correspondence.

Automatic parsing uses at most three pages / 30,000 characters; unreliable or incomplete fields remain flagged for review. Public acquisition covers Crossref/DOI, arXiv, direct PDFs and generic citation meta tags. Network branches beyond the W3C direct PDF are tested with deterministic transport fixtures. Authenticated publisher access, browser providers and live model generation are not validated here. The API documents all intake limits.

The continuous-reference update has automated, native Host, browser and scoped memory evidence. The updated local deployment and refreshed native library pane are verified in the [installation receipt](validation/annotation-reference-install.json). Actual-library migration and reading tests were not performed. Public source publication uses the MIT license for original project files, preserving third-party terms and excluding runtime data.
