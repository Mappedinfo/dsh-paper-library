# Validation, 2026-09-14

The native-paper-conversation update has passed automated checks, an isolated native Harness browser walkthrough and authenticated checks after upgrading the existing installation. The native PWA was also refreshed, showed the updated conversation entry and reopened the library pane. Reading interactions used synthetic papers in the isolated browser; no user paper was opened in the installed app. Earlier plugin installation, browser and capacity evidence is retained below with its scope. User literature was not migrated. Tests and capacity fixtures are synthetic. Original code and dependency licenses are distinguished in `THIRD_PARTY.md`.

## Native conversation checks

The current run passes **101 JavaScript tests and 39 Python tests**; the [automated receipt](validation/automated.json) also records the client build, browser syntax and CSL integrity checks. The JavaScript suite adds cold Session creation, stable per-paper identity, first-use model inheritance without changing global defaults, serialized native prompt retries, bounded history, safe main-composer draft appends, reader-state restoration and inline conversation behavior. The Python suite adds explicit native-conversation replies saved as portable PDF notes, provenance recovery, empty annotation associations, parameter rejection and duplicate-save behavior. Reproduce with `node scripts/validate.mjs`, or run the suites with `npm test` and `uv run --offline pytest -q`.

[Ten isolated Harness checks](validation/paper-chat-harness.json) passed with one deterministic model generation and **zero external model requests**. The fixture imported fresh synthetic PDFs, saved a page-two annotation, created cold Sessions listed by the native API with the correct cached titles and `blank:true`, reused a paper's identity, kept a second paper distinct and inactive, then submitted a native prompt and read the committed assistant reply. Retrying the same request did not duplicate the turn or generation. Saving the completed reply wrote its Session/message provenance to a native PDF note; repeating the save reused that note and ignored browser-supplied fake text.

The fixture starts an isolated Harness profile and uses real Session persistence, prompt admission and PDF operations. Its deterministic model replaces the external provider only. Reproduction is documented in [the native-chat fixture](../tests-js/fixtures/harness-chat/README.md), with `tests-js/paper-chat-harness-smoke.mjs` as the executable entry. This proves the cold Session can be adopted by the native conversation controller; it is not a paid-model quality evaluation or a browser usability study.

A separate test opens 100 synthetic paper identities through a service fixture and checks that it retains zero Agents and zero active history followers. An actual built Harness Session and persistence validator accept the cold title/model seed. These are lifecycle/format checks, not measured RSS for a real collection. Once the user opens a native main conversation or sends a message, that Agent's residency belongs to Harness; the plugin claims no idle eviction of those Agents.

The list-cache regression checks that the optional native projection checkpoint occurs only after the seed log is flushed and closed, does not activate an Agent, and remains nonfatal on cache failure. Source inspection confirms that Harness intentionally hides noncurrent zero-turn Sessions and presents the selected one as “New Session” with a hidden main header. The stored paper title is retained and becomes the ordinary row title after the first prompt; this empty-session UI is not changed by the plugin.

The [native browser walkthrough](validation/paper-chat-manual.json) passes ten checks using fresh three-page synthetic PDFs and a deterministic local model. The rendered controls preserved the current main conversation while opening a paper, continued the same history inline and on the main page, appended to the correct main composer without erasing either paper's draft, restored an unsaved page-two note after closing and reopening the pane, saved that note and prepared readable citation context, and explicitly saved a completed assistant reply to PDF. The page and selected annotation context survived the native Session remount. Automatic annotation sending was initially unchecked. No external model request or real document was used. Development restarts caused expected reconnect warnings; this is an agent walkthrough, not a formal usability study.

The existing `web` profile was upgraded with the additive installer, preserving its other plugins and configuration. After confirming native conversations were idle, the host was restarted on its existing port. [Installed-host checks](validation/paper-chat-install.json) confirm authenticated library availability, native paper-conversation capability and the served chat script. The native PWA was refreshed, displayed the updated “检索、引用、PDF 批注与论文对话” guide and reopened the library pane, which was left open. The check made zero model requests and read no private PDFs. The full reading interaction is covered by the separate synthetic browser walkthrough.

## Earlier functional evidence

- The preceding intake milestone recorded **26 Python tests**: catalog/import batching and interruption recovery, bounded PDF inspection, Unicode filenames/collision and rename-journal recovery, metadata-only item attachment evidence, FTS updates, exact dedup/conflict handling, native annotations, rotations, concurrent writes, source preservation, fresh-catalog PDF recovery, encrypted/signed refusal and atomic feedback context validation.
- That milestone recorded **60 JavaScript tests**: public acquisition, DNS/redirect checks and pinned connections, byte/deadline/concurrency budgets, raw PDF upload, title identity and enrichment provenance, UI drop/paste/queue continuation, actual Harness skill registry, ToolRuntime and lazy client, shared composer model subscriptions, AI terminal/cancellation handling, citation rules, paginated metadata import and complete PDF/feedback copy/reimport flow. AI responses were deterministic test responses, not live provider evaluations.
- Nine isolated Harness web checks: plugin load, session skill catalog with exact bundled skill path, browser bundle, authenticated page, authentication refusal, cross-origin refusal, model metadata, worker and deployment-library isolation. No model request was made; see [host receipt](validation/harness-smoke.json).
- Full capacity-library export: all 2,000 records re-parsed from BibLaTeX with 2,000 unique original keys and no missing keys; see [export receipt](validation/export-2000.json).
- Browser walkthrough through Codex computer-use tools: loaded three synthetic papers; opened a PDF; copied APA text to clipboard; saved a Chinese page note and selection highlight; refreshed and observed persisted notes; created a relation and observed its recorded reason in the graph. This is an agent walkthrough, not a formal usability study.
- Earlier Harness sidebar walkthrough with the 2,000-record fixture: opened the reader, observed inherited model A, changed the Harness composer to model B and observed the standalone-feedback route follow it. An unsaved Chinese annotation draft survived switching back to A. The selection-only fixture refused generation before network I/O. This covers the previous continuously-following route, not the new per-paper model selection. Reproduce setup with [the model fixture](../tests-js/fixtures/harness-models/README.md).
- Automatic intake browser walkthrough: pasted the [W3C dummy PDF](https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf), observed real network download, saved filename and readable page; selected two generated PDFs together and observed sequential automatic saving; rejected a nonstandard-port target with input/retry retained. No browser error/warning logs were recorded. The OS drag gesture itself was not automated; synthetic events exercise the actual application drop handler. See [intake walkthrough](validation/intake-manual.json).
- WPS attempt did not complete because native application automation failed to maintain a usable file dialog. WPS viewing/saving remains unverified; no existing user document was edited for this test.

The 26/60-test intake receipt is preserved in [Git history at the intake milestone](https://github.com/mappedinfo/dsh-paper-library/blob/8d7b4a5/docs/validation/automated.json); the current `automated.json` contains the 101/39-test run. Other historical machine-readable checks: [earlier installed profile](validation/install.json), [preserved prior configuration](validation/install-preservation.json), [earlier manual walkthrough](validation/manual.json).

## Capacity and memory

These capacity measurements were taken before automatic link intake and native paper conversations were added. New regression tests verify streaming, queue/concurrency limits and cold-session behavior, but do not establish a new peak-RSS result for concurrent downloads or long-running native conversations.

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

Metadata/abstract retrieval only; no full-text index, OCR or resident embeddings. One managed PDF per record. Metadata input is capped at 2,000 records / 32 MB, processed in batches of 100; larger exports must be split. PDF import is capped at 250 MB / 2,000 pages. Rendering is capped at 4 million pixels and 4,000 pixels per dimension. Annotation export is bounded; truncation is reported. A native reading prompt includes at most 40 annotations / 12,000 annotation text-and-comment characters, an optional selection of up to 8,000 characters and a question of up to 4,000 characters. It continues the paper's existing Harness conversation and configured model.

Inline history contains at most 20 committed human/assistant messages, 6,000 characters per message and 48,000 total; full tool output, approvals, stop controls and older history are on the main page. Explicit reply-to-PDF saves require an attached PDF and a completed assistant event in the current history window, with at most 28,000 text characters. They preserve Session/message provenance and do not infer annotation associations. Archived Sessions remain preserved, with an explicit unavailable state because the current Harness public API has no unarchive method. Moving the library directory does not automatically migrate the Session correspondence.

Automatic parsing uses at most three pages / 30,000 characters; unreliable or incomplete fields remain flagged for review. Public acquisition covers Crossref/DOI, arXiv, direct PDFs and generic citation meta tags. Network branches beyond the W3C direct PDF are tested with deterministic transport fixtures. Authenticated publisher access, browser providers and live model generation are not validated here. The API documents all intake limits.

The current local installation passes authenticated checks after its restart, its native PWA shows the updated entry and opens the library pane, and the conversation workflow passes the isolated native Harness browser walkthrough. Actual-library migration and reading tests were not performed. Public source publication uses the MIT license for original project files, preserving third-party terms and excluding runtime data.
