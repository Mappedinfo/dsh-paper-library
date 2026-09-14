# Validation, 2026-09-14

This is a local first version, installed in Harness's existing `web` profile. User literature was not migrated. Tests and capacity fixtures are synthetic.

## Functional checks

- 20 Python tests: catalog/import batching and interruption recovery, FTS updates, exact dedup/conflict handling, native annotations, rotations, concurrent writes, source preservation, fresh-catalog PDF recovery, encrypted/signed refusal and atomic feedback context validation.
- 28 JavaScript tests: real Harness ToolRuntime, bundled lazy client, shared composer model subscriptions, actual UI context handlers and stale/spoofed route rejection, reasoning-effort forwarding, streaming AI success/failure/cancellation, HTTP authentication boundaries, citation rules, 130-record paginated upload/full-library export and complete PDF/feedback copy/reimport flow. AI responses in these tests are deterministic test responses, not live provider evaluations.
- Eight isolated Harness web checks: plugin load, browser bundle, authenticated page, authentication refusal, cross-origin refusal, model metadata, worker and deployment-library isolation. No model request was made.
- Full capacity-library export: all 2,000 records re-parsed from BibLaTeX with 2,000 unique original keys and no missing keys; see [export receipt](validation/export-2000.json).
- Browser walkthrough through Codex computer-use tools: loaded three synthetic papers; opened a PDF; copied APA text to clipboard; saved a Chinese page note and selection highlight; refreshed and observed persisted notes; created a relation and observed its recorded reason in the graph. This is an agent walkthrough, not a formal usability study.
- Actual Harness sidebar walkthrough with the 2,000-record fixture: opened the reader, observed inherited model A, changed the Harness composer to model B and observed the reader follow it. An unsaved Chinese annotation draft survived switching back to A. The selection-only fixture refused generation before network I/O; the intentionally failed synthetic turn only made the normal conversation sidebar available. Reproduce setup with [the model fixture](../tests-js/fixtures/harness-models/README.md).
- WPS attempt did not complete because native application automation failed to maintain a usable file dialog. WPS viewing/saving remains unverified; no existing user document was edited for this test.

Machine-readable checks: [automated](validation/automated.json), [installed profile](validation/install.json), [preserved prior configuration](validation/install-preservation.json), [manual walkthrough](validation/manual.json).

## Capacity and memory

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

Metadata/abstract retrieval only; no full-text index, OCR or resident embeddings. One managed PDF per record. Metadata input is capped at 2,000 records / 32 MB, processed in batches of 100; larger exports must be split. PDF import is capped at 250 MB / 2,000 pages. Rendering is capped at 4 million pixels and 4,000 pixels per dimension. Annotation export is bounded; truncation is reported. AI receives at most 40 annotations / 12,000 source characters and requires a configured Harness model.

Local installation is verified. The running user host was not restarted; reopening Harness is required for the newly registered right-panel entry. Publication, remote push and actual-library migration were not performed.
