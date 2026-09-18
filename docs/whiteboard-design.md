# Literature whiteboard (画板)

## Scope decision

Accepted 2026-09-18 from the owner's request for "a whiteboard like Excalidraw or draw.io that can
interact with DSH's built-in references". The owner selected, explicitly:

- **Shape** — a free canvas first (shapes, text, free placement, pan/zoom) that can be *snapped* into
  a mind-map tree on demand. Not a pure auto-layout graph and not a graph-only tool.
- **Reference interaction** — (1) board → conversation: selected board content becomes a reference
  chip in the DSH composer; (2) library/graph → board: papers drag into the canvas as nodes and
  double-click back into the reader; (3) the DSH agent can read and write boards through a host tool.
  Node ↔ `@file`/`@session` binding was explicitly **not** selected and is out of scope.
- **Implementation** — a self-contained SVG canvas with no new runtime dependency. Excalidraw and
  tldraw were rejected for bundle size and (for tldraw) licence review.
- **Placement** — a new view inside this project's own `web/` application, which DSH already embeds as
  the same-origin `sidebar.right.pane.tab` iframe, with a fullscreen mode for narrow sidebars.

## Verified basis for not installing an existing plugin

The board is built here rather than installed because no published plugin provides the requested
combination. Names were checked against the public npm registry on 2026-09-18, not asserted from
memory:

| Package | Registry | What it actually is |
| --- | --- | --- |
| `dsh-plugin-canvas` | 0.1.0 | infinite **session** canvas: workspaces, agent presets and session cards |
| `omnimux-workflow` | 0.1.1 | workflow DAG editor with node/edge execution |
| `dsh-plugin-freecanvas` | 0.2.0 | app shell that embeds a local Canvas Agent; split layouts |
| `dsh-wf` | 2.4.5 | UI **sketch** pad in the composer that emits a JSONL description |
| `dsh-comfyui-canvas` | 0.1.7 | embeds a ComfyUI instance for image/video/3D generation |
| `dsh-with-pencil` | 0.5.5 | session-aware Pencil (pen.dev) design integration |
| `@huanlin/dsh-plugin-aigc-canvas` | 0.1.9 | AIGC node canvas (text→image/video/audio) |
| `@xiaohe-store/dsh-canvas` | 0.1.15 | e-commerce content canvas with templates |
| `canvas-agent-dsh` | **404** | not published |
| `dsh-ramify` | **404** | not published |

None of the published packages is a free-form Excalidraw/draw.io-style board, and none reads or
writes DSH's `@` reference system or the paper library. Two names that circulated in an earlier
assistant reply do not exist at all, so that reply is treated as unverified and is not a basis for
installation.

## Data model

One board is one host-owned record under the plugin's existing private state store
(`$DSH_HOME/paper-library/<library-hash>/state`), keyed `board:<id>`. This reuses the store's existing
guarantees instead of adding a second persistence path: 256 KiB per record, revision-checked writes
(`expected_revision`, first write `0`), atomic replacement, private directory. Listing reads at most
50 board records through the store's own bounded `list({ prefix: 'board:' })`; no separate index
record exists, so a listing can never drift from the boards themselves.

```jsonc
{
  "schema": 1,
  "board": {
    "id": "b-<12 hex>",              // [A-Za-z0-9_-]{1,60}
    "title": "…",                     // 1–200 characters
    "created_at": "…", "updated_at": "…",
    "origin": "user" | "llm",         // who created the record
    "status": "saved" | "needs-review", // AI writes are reviewable, like every other AI draft
    "view": { "x": 0, "y": 0, "zoom": 1 },
    "nodes": [{
      "id": "n-<12 hex>", "kind": "text|note|concept|paper|rect|ellipse|diamond",
      "x": 0, "y": 0, "w": 240, "h": 120, "text": "…", "color": "#rrggbb",
      "paper": { "id": "…", "title": "…", "year": 2025, "citekey": "…" }
    }],
    "edges": [{ "id": "e-<12 hex>", "from": "n-…", "to": "n-…", "label": "…",
                "kind": "arrow|line|elbow",
                "relation": "related|supports|contradicts|cites|explains|extends" }]
  }
}
```

Bounds are enforced by the store module before any write, with explicit messages rather than silent
truncation: ≤ 400 nodes, ≤ 800 edges, ≤ 2000 characters of node text, coordinates within ±1e6,
zoom 0.2–4, and the store's own 256 KiB record cap. A board node that points at a paper stores a
**denormalized, at-write-time copy** of that paper's title/year/citekey: the board stays readable when
the paper is archived, and the reader is always the authority for current metadata. Node `paper.id`
is the only identity that matters; a missing paper degrades to a plain node, never to a fabricated
title.

## Reference interaction contract

A board reference reuses the plugin's proven reference shape rather than DSH's generic file
references, because only the plugin owns immutable snapshots and the `agent/pre-step` expansion:

1. **Freeze.** "放入对话" writes one immutable, content-addressed snapshot record
   `board-ref:<sha256>` (key grammar allowed by the store) containing the rendered outline text plus
   node/edge identity, the board revision it came from, and `created_at`. Sending again creates a new
   snapshot; nothing mutates an existing one.
2. **Token.** The inserted chip carries `[[paper-library-board:v1:<boardId>:<snapshotHash>]]`, whose
   canonical text *is* its clipboard form, exactly like `[[paper-library-ref:v1:…]]`.
3. **Chip.** A second registered `@` source (`paper-library-boards`, order 30) owns the token: it
   lists at most five recent board references for the current session, and implements
   `codec.serialize`/`clipboardText` plus `openReference` for the editor. Chips route by source name,
   so annotation chips and board chips cannot be confused.
4. **Expansion.** The host expands board tokens in `agent/pre-step`. The visible draft keeps a short
   `〔引用画板 …〕` marker, and the frozen text is appended as a **separate** user message from source
   `paper-library-board`. The rendering is bounded by the same character budget as annotation
   references, and a truncation is stated in the text itself rather than silently applied.
5. **Distinguishability.** Board material is user-authored source, never model output; the appended
   message carries its own source name and no AI provenance. Snapshot loading does not call a model.

Unlike annotation snapshots, a board snapshot is **not bound to one paper conversation**: a board is
cross-paper by nature, so it may be referenced from any session. Session identity is recorded for
provenance only and is not an authorization gate. Board snapshots are shape-validated before use; a
malformed or missing snapshot fails the turn with a readable message instead of dropping the material
silently.

## Phases

- **P1 — record and agent tool (model-free).** `src/harness/board-store.mjs` (validation, CRUD,
  bounded listing, snapshots), HTTP actions `board_list|board_get|board_put|board_delete`, the native
  `library_board` tool (AI writes marked `origin:'llm'`, `status:'needs-review'`), and the `status`
  capability flag. No canvas yet.
- **P2 — free canvas.** `web/board.js` + `web/board.css`: SVG canvas with pan/zoom, text/note/shape
  nodes, drag, resize, edge drawing, multi-select, delete, bounded undo/redo, debounced
  revision-checked saving, board switcher, fullscreen. Wired into `index.html`, `app.js`, the
  `src/http.mjs` asset allowlist, and `scripts/validate.mjs` syntax checks.
- **P3 — library integration and snapping.** Drag papers from the catalog onto the canvas (paper
  nodes), double-click back into the reader, deterministic tidy-tree layout for a selection, and
  "generate a board from selected papers". The knowledge graph lives in the same column as the
  board, so a graph node is handed over with an explicit control instead of a drag.
- **P4 — reference chips.** Snapshot store, token family, the `paper-library-boards` `@` source, the
  bridge `board_draft` action, host `agent/pre-step` expansion, and the frozen-material inspector.

## P6–P8: edges, automatic layout and a readable source

Accepted 2026-09-18 from the owner's follow-up: add real connection editing, automatic layout,
and make the board's source readable with an auxiliary file for presentation and special
positions.

- **P6 — connections.** A dedicated connect tool (click source, click target) joins the
  existing handle drag. Lines carry `kind` (`arrow|line|elbow`), `arrow`
  (`forward|none|both`), `dashed` and up to eight `waypoints`. Dragging a line inserts a bend
  point at that leg, Alt-click or double-click removes one, and a click without movement never
  touches the board (which is also what keeps double-click on a handle working). The line
  style chosen in the inspector becomes the default for the next connection, and the tool
  returns to selection after drawing one.
- **P7 — automatic layout.** Three deterministic modes: `tree` (respects the vertical order
  you arranged, in four directions), `radial` (mind map) and `layered` (longest-path layering
  with barycenter ordering). Gaps are adjustable. **Pinned nodes never move**, which is the
  escape hatch for deliberate placement; the layout scope is the selection when it holds more
  than one node. Every mode emits its own bounding box anchored at the origin, so applying the
  same layout twice is a no-op instead of a slow drift.
- **P8 — readable source and a style sidecar.** `board.json` holds the title, nodes and edges
  with short ids, stable key order and **no pixel coordinates**; `board.style.json` holds
  colours, sizes, fonts, per-relation edge styling, the layout mode/gaps and the pinned
  positions. The panel can generate, edit, validate, apply, download and import the pair, and
  the standalone site can render a repository file directly with `?src=boards/name.json`.

### What implementation changed here too

- **Presentation never rides on the node.** The first version baked a style fill into each
  node; the host validator rejected it, which is exactly what the new parity test is for. Fills
  now live only in the style block, which the renderer reads anyway.
- **Elbow paths needed their own geometry.** The drawn orthogonal path and the straight
  polyline used for hit-testing diverged, so the visible line could not be grabbed. There is
  now one `edgeRenderPoints` that inserts the corner, and hit-testing, label placement and
  dragging all measure the shape on screen.
- **Layout modes had to be anchored to structure, not to the current picture.** Radial placed
  its centre from the input bounding box and layered broke ties on current coordinates, so a
  second pass shifted or swapped nodes. Both now derive local coordinates from the tree and
  the node order alone.
- **The connect tool hands back to selection.** Leaving it armed swallowed the next gesture,
  which is how "drag a bend point into the line you just drew" failed the first time.
- **Error messages were glued together** (`类型 notew 必须在…`); the field labels are now
  separate words in both validators.

## P9: decoupling, many-to-many links and a pure canvas

Accepted 2026-09-18 from the owner's follow-up. A board is a file that may sit under several
papers and reading projects without becoming part of them:

- **`links: { papers: [...], projects: [...] }`** on the board record — associative only,
  many-to-many, at most 50 papers and 20 projects, duplicate identifiers rejected, and an empty
  list dropped rather than stored. Linking never copies board content and unlinking never
  touches it. The same two arrays appear in the readable `board.json`, so one file states what
  the board belongs to; `projects` is already validated and round-tripped, and reading projects
  themselves land in the next phase.
- **The library lists boards as their own files.** A 「画板」 shelf in the library pane shows
  each host record with its node/edge/link counts, opens one, and links or unlinks it to the
  currently open paper. Linking goes through the authenticated host API rather than switching
  the app into the board view. The paper toolbar offers 「＋ 画板」 (new board, already linked)
  and 「这张论文的画板 N」.
- **Focus mode is a pure canvas.** 「专注 ⤢」 hides the topbar, the library, the reader and the
  annotations — and the standalone page's header and footer — without the Fullscreen API, so it
  also works inside the DSH sidebar. Escape leaves focus first (a second Escape clears the
  selection), and closing the board leaves focus.

### What implementation changed here too

- **The per-paper controls are created in JS.** The static block they first lived in is moved
  and then removed by the workbench module on every setup pass, and the destination is a
  collapsed citation menu, so a static button silently disappeared and took the app's boot with
  it.

## Invariants

- No new runtime dependency, no model call while opening, listing or drawing a board, and no
  background worker. The canvas runs only while its view is visible.
- Every write is revision-checked; a conflicting write reports the conflict and preserves both the
  saved board and the local unsaved edit rather than overwriting.
- A board never becomes the authority for paper metadata, and a paper node never invents a title it
  did not read from the catalog.
- Board content that reaches a conversation is frozen at send time, labelled as user material, and
  bounded; the outline rendering states its own truncation.
- Board records are user data: they are not evicted, and browser `localStorage`/`sessionStorage` is
  never authoritative.

## Acceptance

Synthetic-only validation, following the existing project discipline:

- `tests-js/board-store.test.mjs` — schema bounds, revision conflicts, forbidden keys, bounded
  listing, snapshot immutability, and AI-write review marking, all against an in-memory/temporary
  store with no private data. **Implemented, 8 cases.**
- `tests-js/board-panel.test.mjs` — canvas reducer behavior (create/drag/connect/delete/undo/redo,
  tidy-tree layout determinism) through the same fake-DOM harness the other panels use.
  **Implemented, 20 cases** (geometry, model bounds, paper nodes, outline, panel persistence,
  conflict recovery, listing failure, tidy arranging, settle-on-close, graph-node conversion and
  the closed-board graph path).
- `tests-js/board-references.test.mjs` — token parse/render, chip codec round-trip, snapshot
  integrity, and `agent/pre-step` expansion including the malformed and over-budget paths.
  **Implemented, 5 cases.**
- `tests-js/board-source.test.mjs` — edge geometry (waypoints, elbow corners, bend-point
  editing), the three layout modes across four directions and two node orders, the source and
  style validators, and a **parity check that everything the source module emits passes the
  host's own validator**. **Implemented, 5 cases.**
- `scripts/board-browser-fixture.mjs` — real Chromium receipt for draw/drag/zoom/connect/save/reload,
  library drag-in, tidy-tree snapping, and the standalone refusal of the conversation chip.
  **Implemented, 23 checks** in `docs/validation/board-browser.json` (including a knowledge-graph node joining a board, the connect tool, a bend point, automatic layout with a pinned node, and the source/style pair).
- `scripts/board-harness-smoke.mjs` — native DSH check that the tool is offered, that a board token
  reaches a turn as frozen material, and that an unresolvable reference fails the turn.
  **Implemented, 7 checks** in `docs/validation/board-harness.json`.

## What implementation changed in this design

Four decisions were revised while building, each for an observed reason:

- **The board is the workspace's second column, not a fixed overlay.** A full-view overlay hid the
  library shelf, which made the chosen "drag a paper onto the canvas" interaction impossible. The
  board now takes the detail column while the shelf stays visible, and the Fullscreen API provides
  the large canvas. Opening a paper closes the board and settles its pending edits first.
- **Accepting AI proposals is an explicit action (`board_accept`), never a side effect of saving.**
  Saving is debounced and automatic, so "a reader save accepts everything" would have silently
  converted model proposals into reader content. Only edited or added items are marked, decided by
  comparing against the stored board.
- **Closing the board, switching boards or unloading the page settles the debounced write.** A
  fixture run showed a node disappearing when the page reloaded inside the debounce window; the
  panel now flushes (keepalive on unload) before it goes away, and deleting cancels the debounce so
  a pending save cannot resurrect a tombstoned board.
- **A failed board listing reports itself and creates nothing.** Producing a fresh empty board on a
  transient read failure would have fabricated data; the view now stays usable with a readable
  retry path.

Not claimed: Excalidraw feature parity (no freehand pressure curves, no image import, no
multiplayer), tldraw-style shape binding, real-library capacity numbers, or any provider-quality
claim.

