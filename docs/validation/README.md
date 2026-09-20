# Validation receipts

Every receipt in this directory came from real execution. This index records **which command reproduces each one**, because a receipt nobody can re-run is not evidence: `board-browser.json` was already red on `main` while sitting here unnoticed (the “Discard an unnamed shape…” and toolbar-IA entries in `CHANGELOG.md` describe what had actually broken).

The narrative of each round — what was checked, what it proves, and what it does not — is in [../validation.md](../validation.md); this file is only the index.

## How to reproduce

```bash
export PLAYWRIGHT_MODULE=/opt/homebrew/lib/node_modules/playwright/index.mjs   # any Playwright install
npm test                                     # node --test tests-js/*.test.mjs
node scripts/validate.mjs                    # writes automated.json; also runs the Python suite
npm run test:board && npm run test:standalone && npm run test:projects
npm run verify:pages                         # refreshes board-pages-live.json from the deployed site
```

Rows marked **native host** boot a second DeepSeek Harness with an isolated profile and need extra environment:

```bash
DSH_CHECKOUT=/path/to/deepseek-harness \
DSH_TEST_HOME=$PWD/.local/paper-chat-test-home \
DSH_TEST_PROFILE=paper-chat-test npm run test:reference
```

They stay out of `npm test` (which is browser-free) for that reason; browser-only fixtures are wired as `test:*` scripts in `package.json`.

## No-argument fixtures (30 of 57)

| Receipt | Command | Verified | Scope |
|---|---|---|---|
| `annotation-reference-browser.json` | `node scripts/reference-browser-fixture.mjs`（native host） | 2026-09-20 | — |
| `annotation-replies-browser.json` | `node scripts/annotation-replies-browser-fixture.mjs` | 2026-09-18 | 5 项检查（回执未写 scope 字段） |
| `automated.json` | `node scripts/validate.mjs` | 2026-09-20 | Synthetic fixtures, source/runtime integration and checks listed below; excludes WPS and real provider completion |
| `bibliography-browser.json` | `node scripts/bibliography-browser-fixture.mjs` | 2026-09-20 | Synthetic catalog in an isolated standalone server; browser build button, audit dialog and exports files; no model calls or network requests |
| `board-browser.json` | `node scripts/board-browser-fixture.mjs` | 2026-09-20 | Synthetic catalog in an isolated standalone server; free canvas drawing, text editing, connecting, moving, paper drag-in and picker, undo/redo, delete, zoom/fit/fullscree |
| `board-harness.json` | `node scripts/board-harness-smoke.mjs`（native host） | 2026-09-20 | Isolated native DSH profile with a deterministic keyless model and a synthetic library; authenticated whiteboard records, immutable snapshot, revision-checked writes, too |
| `board-pages-live.json` | `node scripts/verify-pages.mjs` | 2026-09-20 | The deployed GitHub Pages site, read over the public network and exercised in real Chromium: asset delivery, draw/persist/reload, tidy-tree arranging, PNG export, hidden  |
| `board-standalone.json` | `node scripts/board-standalone-fixture.mjs` | 2026-09-20 | The GitHub Pages build served by a local static server: browser-local persistence with a content revision, reload restore, tidy-tree arranging, JSON export/import across  |
| `catalog-layout-browser.json` | `node scripts/catalog-layout-browser-fixture.mjs` | 2026-09-18 | Actual Chromium with synthetic metadata, isolated host disk storage, explicit text bounds and full-title hover/focus checks. Not formal user validation. |
| `challenge-mining-browser.json` | `node scripts/challenge-panel-browser-fixture.mjs` | 2026-09-20 | Synthetic catalog in an isolated standalone server; corpus panel, P1 scan receipts, P3 aggregation, review gate, P4 structural check/comparison/review packet and exports  |
| `challenge-mining-harness.json` | `node scripts/challenge-harness-smoke.mjs`（native host） | 2026-09-18 | Actual isolated DSH profile with a synthetic library: authenticated challenge routes, delivered panel assets, P1 scan, P3 aggregation with the review gate, P4 check/compa |
| `companion-browser.json` | `node scripts/companion-browser-fixture.mjs` | 2026-09-16 | 4 项检查（回执未写 scope 字段） |
| `feedback-browser.json` | `node scripts/feedback-browser-fixture.mjs` | 2026-09-20 | Synthetic standalone UI: per-annotation feedback write-back rendering and PDF linking; no model call or external request |
| `harness-smoke.json` | `node tests-js/adapter-web-smoke.mjs`（native host） | 2026-09-15 | 9 项检查（回执未写 scope 字段） |
| `language-browser.json` | `node scripts/language-browser-fixture.mjs` | 2026-09-14 | Actual Chromium UI and file storage with deterministic local model double; not real provider quality or formal user validation |
| `language-harness.json` | `node scripts/language-harness-smoke.mjs`（native host） | 2026-09-14 | 6 项检查（回执未写 scope 字段） |
| `markup-mode-browser.json` | `node scripts/markup-mode-browser-fixture.mjs` | 2026-09-20 | Synthetic standalone UI: ask/auto markup modes, picker-to-PDF colour contract, rail flash colour and persisted layout. Chromium only; no model call or external request. |
| `paper-analysis-browser.json` | `node scripts/paper-analysis-browser-fixture.mjs` | 2026-09-18 | Actual Chromium + disk-backed source/job/metadata APIs with deterministic model adapter. Native subagent lifecycle checked separately; no real provider or private documen |
| `paper-analysis-harness.json` | `node scripts/paper-analysis-harness-smoke.mjs`（native host） | 2026-09-16 | 9 项检查（回执未写 scope 字段） |
| `paper-chat-harness.json` | `node scripts/companion-browser-fixture.mjs` + `node tests-js/paper-chat-harness-smoke.mjs`（native host） | 2026-09-16 | 16 项检查（回执未写 scope 字段） |
| `project-ui.json` | `node scripts/project-ui-fixture.mjs` | 2026-09-20 | Synthetic catalog in an isolated standalone server; reading-project creation, project-scoped library lists, many-to-many paper membership with create-and-join, rename and |
| `publication.json` | `node scripts/check-publication.mjs` | 2026-09-20 | Pre-publication source, history, manifest and package checks; not remote publication or a legal opinion |
| `reader-browser.json` | `node scripts/reader-browser-fixture.mjs` | 2026-09-18 | Synthetic standalone UI behavior only; native model integration and long-session memory measured separately; no formal user validation |
| `resource-browser.json` | `node scripts/resource-browser-fixture.mjs` | 2026-09-18 | Actual Chromium and disk APIs with synthetic dataset, CSV, PDF and API-seeded model candidate. Not a real provider generation or formal user test. |
| `resource-harness.json` | `node scripts/resource-harness-smoke.mjs`（native host） | 2026-09-16 | 7 项检查（回执未写 scope 字段） |
| `selection-browser.json` | `node scripts/selection-browser-fixture.mjs` | 2026-09-20 | Synthetic two-page fixture in an isolated standalone server: invisible text layer alignment, multi-line capture completeness, gap and line-end releases, and a rotated pag |
| `settings-browser.json` | `node scripts/settings-browser-fixture.mjs`（native host） | 2026-09-15 | Actual Chromium and isolated native DSH settings-file provider; official Plugins inventory/card and authenticated standalone library settings page. Empty synthetic librar |
| `sidebar-browser.json` | `node scripts/sidebar-browser-fixture.mjs` | 2026-09-18 | Actual Chromium with isolated synthetic library and host file storage. Shared sidebar layout and reader recovery; no real library or provider and no formal user validatio |
| `theme-browser.json` | `node scripts/theme-browser-fixture.mjs` | 2026-09-16 | Actual Chromium UI, standalone system appearance, real plugin bridge and Harness CSS in an isolated host fixture. No live user library, provider quality or formal usabili |
| `workbench-browser.json` | `node scripts/workbench-browser-fixture.mjs` | 2026-09-18 | Synthetic catalog and PDF only; no external metadata lookup, no formal user validation |

## Scripts that take arguments or data (5)

These measure capacity or memory on this machine and are parameterised (a library path, an output path, a worker mode). Run them with their own arguments; the receipt records what that run produced.

| Receipt | Script | Verified | Scope |
|---|---|---|---|
| `annotation-reference-memory.json` | `node scripts/benchmark-annotation-references.mjs` | 2026-09-14 | — |
| `dataset-preview-memory.json` | `.venv/bin/python scripts/benchmark-dataset-preview.py` | 2026-09-15 | One 1 GiB sparse synthetic CSV with a valid first 200 rows; true worker peak RSS only. Excludes browser and host; not a real-library capacity comparison. |
| `export-2000.json` | `node scripts/verify-library-export.mjs` | 2026-09-14 | — |
| `harness-memory.json` | `node scripts/benchmark-harness.mjs` | — | — |
| `rkos-subset.json` | `.venv/bin/python scripts/validate-rkos-subset.py` | 2026-09-15 | 4 项检查（回执未写 scope 字段） |

## Records without a script (22)

Produced by one-off install or manual sessions; each `scope` field says what it measured. Evidence for that date only.

| Receipt | Verified | Scope |
|---|---|---|
| `annotation-reference-install.json` | 2026-09-14 | — |
| `annotation-replies-install.json` | 2026-09-15 | — |
| `capacity.json` | — | — |
| `companion-install.json` | 2026-09-16 | — |
| `companion-settings.json` | 2026-09-16 | — |
| `full-analysis-install.json` | 2026-09-15 | — |
| `full-analysis-settings.json` | 2026-09-15 | — |
| `install-preservation.json` | — | — |
| `install.json` | — | — |
| `intake-manual.json` | 2026-09-14 | 5 项检查（回执未写 scope 字段） |
| `language-install.json` | 2026-09-14 | — |
| `manual.json` | — | 14 项检查（回执未写 scope 字段） |
| `node-memory.json` | — | — |
| `paper-analysis-install.json` | 2026-09-15 | — |
| `paper-chat-install.json` | 2026-09-14 | — |
| `paper-chat-manual.json` | 2026-09-14 | 10 项检查（回执未写 scope 字段） |
| `reader-install.json` | 2026-09-14 | — |
| `resource-install.json` | 2026-09-15 | — |
| `settings-install.json` | 2026-09-15 | — |
| `sidebar-install.json` | 2026-09-15 | — |
| `theme-install.json` | 2026-09-14 | — |
| `workbench-install.json` | 2026-09-14 | — |
