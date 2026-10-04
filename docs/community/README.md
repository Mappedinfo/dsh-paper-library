# Community showcase

`showcase.md` and `showcase.json` are the reviewed post for the upstream
[plugin category](https://github.com/deepseek-ai/deepseek-harness/discussions/2004).
`discussion.json` records the published topic only after remote readback succeeds.

## Reproduce the screenshots

The project showcase leads with the complete literature-to-writing workflow.
Its current screenshots are direct Chromium captures, using only synthetic
documents and isolated state:

| Views | Reproduction | Provenance and checks |
| --- | --- | --- |
| Library, PDF annotations and literature whiteboard | `node scripts/capture-project-demo.mjs` | [Project demo](project-demo.md) and `project-demo.json` |
| Current LaTeX workspace with a successfully compiled PDF | `node scripts/capture-latex-demo.mjs` | [LaTeX demo](latex-demo.md) and `latex-demo.json` |
| Contextual handwriting, saved preview and ink location | `node scripts/capture-handwriting-demo.mjs` | [Handwriting demo](handwriting-demo.md) and `handwriting-demo.json` |

The scripts use the shipped pages, controls and persistence paths. Images have
no retouching or injected layout; no private library or real model reply is
shown. LaTeX compilation uses a real local TeX installation. Handwriting uses
deterministic browser pen input, not a physical Pencil trial. The model rail in
the standalone LaTeX demonstration accurately reports its missing connection.

The old `paper-library-reading.jpg` and `paper-library-annotations.jpg` remain
as historical assets and are no longer used to illustrate the current UI.
Their original synthetic seed can still be reproduced:

```sh
node scripts/prepare-promotion-demo.mjs
node src/server.mjs --library .local/promotion/library --port 0
```

Open the printed loopback URL in a browser, select **Reading urban change**, and
scroll the reading pane until its synthetic PDF title and highlighted passage
are visible. Capture that page and the **批注** tab. Those two historical JPEGs
are unedited browser screenshots from standalone preview mode.
The fixture generator identifies every document as synthetic. No actual user
library, conversation, model credentials, or generated AI reply is shown.

The demonstration seed is idempotent and refuses unrelated library contents.
Stop only this temporary server when done; the user's Harness host is separate.

## Release announcements

`release-v0.1.0.md` and `release-v0.2.0.md` are the reviewed comments that
announce one release each on the existing discussion (`showcase.json` points at
the newest one); `discussion-comments.json` records each published comment only
after remote readback. `node scripts/announce-release.mjs` runs preflight
without arguments, posts only when no comment with the same body hash exists
(`--publish`) and re-reads the recorded comment (`--verify`). The discussion is
never recreated and a published comment is never rewritten: a changed body needs
a new reviewed file and a new receipt, so history stays auditable.

## Publication

Publish the reviewed screenshots to the source repository before running the
discussion tool. With maintainer authorization, `--publish` creates a missing
discussion; `--update` updates only the existing topic in a verified local
receipt. Project showcase updates edit Discussion #6623 in place, keeping
its comments and release history.

```sh
node scripts/publish-discussion.mjs --update
node scripts/publish-discussion.mjs --verify
```

An update checks the recorded identity and the last verified title/body before
writing. Unexpected remote changes stop the update for review. GitHub does not
offer an atomic revision condition on this mutation; the script checks the
latest remote copy immediately before the request. A retry after uncertain
readback recognizes an already-applied update and does not submit it again.
The tool compares public image bytes, title, body, author, repository and category
before recording success. `--verify` reads the saved topic without changing it.
