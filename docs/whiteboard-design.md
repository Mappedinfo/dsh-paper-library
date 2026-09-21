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

- **A node's children are drawn in its own coordinates.** Dragging used to rewrite only the
  shape's geometry, so the labels (and the resize/connect handles) stayed behind until the next
  click forced a full render. Each node now keeps its children around its own origin, positioned
  by one `transform`: a drag rewrites that single attribute, so shape, text and handles move as
  one, and a resize only rewrites the local size and handle offsets. The browser receipt asserts
  the label travels with the drag and does not jump again on release.
- **The per-paper controls are created in JS.** The static block they first lived in is moved
  and then removed by the workbench module on every setup pass, and the destination is a
  collapsed citation menu, so a static button silently disappeared and took the app's boot with
  it.

## P10: reading projects

Completed 2026-09-18, in the order the owner chose (board-side first, then reading projects).
P9 left `links.projects` validated but with nothing to point at; P10 supplies the thing itself.

- **A project is a catalog scope, not a container.** `projects` + `project_papers` +
  `project_archive` (SQLite `user_version` 3) hold the many-to-many edge. It lives in the managed
  library rather than the private state store because a project is bibliographic: it must be
  backed up, searched and exported with the papers, and the agent must be able to read it. The
  private store is the right home for a canvas; it is the wrong home for a reading list.
- **Archive, never delete** — the same rule as papers. Archiving a project keeps its edges and
  hides it: it leaves `project_list`, it stops claiming papers in `project_for_paper`, and every
  mutation is refused until it is restored. Unlinking removes exactly one edge and can never
  archive or delete a paper.
- **The scope composes.** `resource_list` gained an optional `project` filter that restricts to
  paper members and composes with query, sort, order, paging and `archived`. An unknown project id
  is an error rather than a silent unfiltered listing.
- **Membership is edited where the paper is.** The paper ribbon's 「项目 N」 opens a checkbox list
  (tick joins, untick leaves) with an inline "new project and join". The board toolbar's project
  picker is the same idea for a canvas.

### What implementation changed here too

- **A button pressed during a paper load was a silent no-op — in three places.** `openPaper`
  clears `state.active` while it awaits the catalog, and controls decided both their enabled state
  and their action from whatever `state.active` was at render time. The paper ribbon's project
  button, its board buttons and the board shelf's 「关联本篇／解除」 were all affected; the shelf
  case reproduced in the P9 browser fixture, where the click produced no request at all and the
  receipt timed out. They now fall back to the id the view already has (`state.openedId`) and say
  so when no paper is open, which is also what made the board receipt pass again.
- **The board's project controls could never appear.** They were hidden during the panel's
  `bind()`, which runs before the catalog's first status reply, and nothing revealed them
  afterwards. Visibility now belongs to `setProjects`, which is the moment the catalog actually
  answers.

## P11: an entry of its own in DSH

Added 2026-09-19, because a canvas buried inside the library tab is not really decoupled — the
owner asked for a 画板 entry next to 文献库 on the right sidebar's start page.

- **Two tab types, one plugin.** `ctx.sidebarRightTabs` takes as many registrations as a plugin
  has surfaces; the registry refuses a duplicate `id` or an immovable kind, not a second type from
  the same package. The client bundle now registers 文献库 (`paper-library`) *and* 画板
  (`paper-library-whiteboard`), each with its own start-page capsule (`order` 15 and 16, each with
  a glyph), its own stage-two body in the `sidebar.right.pane.tab` seat, and its own tab.
- **One page, two entry views.** The whiteboard tab loads the same page with `?view=board`; the
  page opens the board and enters focus mode, so the entry shows a pure canvas and the library,
  reader and annotations never render. A second copy of the canvas would have been the alternative,
  and the two would drift.
- **The bridge is bound in both.** The board tab keeps the theme, settings, model and conversation
  bindings, so 「放入对话」 freezes a snapshot and drops its reference chip into the composer from
  either entry.

### What implementation changed here too

- **The entry decides before it paints.** Switching to the board at the end of `initialize()` showed
  the library first and then jumped; the entry now resolves at module scope (hiding the rest of the
  page before the first paint) and opens the board right after `loadStatus()`, reading no paper list
  and restoring no reader position. The browser receipt samples the boot and asserts the library is
  never visible.
- **The toolbar needed containment, not more contrast.** Two freely wrapping rows of ~35 controls
  became ~11 rows at sidebar width and took 40% of the pane. It is now a tool row, a quick row and a
  「更多」 panel; at wide widths `display:contents` flattens that panel back into the same inline
  toolbar (44 controls, 133 px, previously 180 px), while a 420 px pane keeps 121 px of toolbar and
  gives the canvas the rest (previously the canvas kept 280 px).
- **A narrow pane gives the board the whole column.** Below 620 px the app is single-pane, so the
  board used to stack *under* the shelf while `board-mode` hid the reader — half a canvas and a
  hidden annotation rail. Whenever the board is open in a narrow container the shelf now steps aside
  and the canvas fills the pane.

## P12: how a line meets a node

Added 2026-09-20 from the owner's report that an arrow (and the line behind it) sometimes hugs the
target node, running along one of its sides.

- **An incidence angle, not a clip.** Clipping the centre-to-centre segment to the border lands the
  end wherever that segment crosses, which for a wide, short node can be a ~10° graze along its top
  edge. The end is now placed so the drawn segment meets the side it lands on at the edge's
  **angle**: perpendicular by default (90°), adjustable to 75/60/45/30, with a **30° floor** —
  a shallower request is clamped, never honoured. The lean follows the centre line and the position
  is clamped to the side, so an end stops at a corner rather than leaving the shape.
- **Both ends, settled.** Sliding one end moves the line the other end measures against, so the pair
  is settled over a few passes (a pass that changes nothing ends it, with a four-pass bound). The
  property that matters is measured, not assumed: 17,448 non-overlapping arrangements across five
  settings keep a worst incidence of 29.99° (coordinates are rounded to 0.01 px), and the drawn path
  itself is measured in the browser receipt, where the old geometry reports 10.4°.
- **`angle` is an edge field.** It travels in the board record and the readable source file, omitted
  when it is the perpendicular default, and the host accepts only integers in 30–90. Two shapes in
  the same place have no side to attach to, so the floor is stated for non-overlapping nodes.

## P13: Mermaid in and out

Asked for 2026-09-20: "can we add Mermaid parsing, converting into our internal structure?"

- **A parser, not the package.** `mermaid` ships a renderer and dagre; the whiteboard needs the
  text understood, not drawn, and this plugin adds no runtime dependency. `web/board-mermaid.js` is
  therefore our own bounded parser, and what it does not understand is reported with a line number
  rather than guessed.
- **It feeds the existing source path.** The output is a whiteboard source document plus a layout
  direction, so a pasted diagram goes through `fromSource` → host validation → 「校验并应用」 like a
  hand-written `board.json`. That keeps one write path, and lets a reader see and edit what the
  parser produced before it reaches the canvas.
- **The understood subset is written down**: shapes (`[]`, `()`, `(())`, `{}`, `>…]`, `[[]]`,
  `[()]`, `[[//]]`), link styles (`-->`, `---`, `-.->`, `-.-`, `==>`, `===`, `<-->`, `o--o`, `x--x`),
  both label forms, `&` groups, chained statements, `<br/>`, entities, quoted ids, `%%` comments and
  a `direction` override. Ignored: styling and interaction directives, with `subgraph` flattened and
  `~~~` dropped; thick and circle endpoints import as documented approximations, and identical links
  merge. The direction becomes the layout direction.
- **The reverse direction exists too**, because a canvas that can only consume is half a bridge:
  `format(board)` writes `flowchart` text, and a round trip is asserted to keep the graph.

## P14, revised: an unnamed shape *is* content

Two reports shaped this, and the second reversed the first.

The first (2026-09-20, from the sidebar): several `（空）` shapes and a red 「第 4 个节点既没有文本也没有
文献。」 left the whole board unsaveable. The host required every node to carry text or a paper, so the
panel's fix was to **discard** a shape whose editor closed empty, prune any stray one before a write,
and hold saves while an editor was open.

The second (2026-09-22, from the owner): 「新建了文本…如果没有输入文字，切到 dsh 对话页面，就会自动删除，
这个不对的，有时候就是要空文字的形状」. The discard was the wrong trade: switching panes blurs the
editor, so merely *looking* at the conversation deleted the shape the reader had just drawn. A
rectangle drawn to hold a place is a legitimate board element — Excalidraw stores an element with no
text and never deletes one behind the reader's back.

What the revision does:

- **The host accepts an unnamed shape.** `board-store.mjs` no longer requires text or a paper; only
  the geometry, kind and identifier are validated. One shape without content can no longer take the
  whole board down with it, which was the real problem behind the first report.
- **Nothing is discarded and nothing is faked.** The editor commits whatever is there, empty
  included; `discardEmptyNode`, `pruneEmptyNodes` and the 「忽略了 N 个没有内容的节点」 status are
  gone. The canvas shows 「（空）」 inside the shape and the outline names it by kind — `（空矩形）`,
  not an opaque `n-…` id — so a reader and the model both see what it is.
- **Saves are still held while an editor is open**, and closing the board or switching boards still
  commits the open edit first. That part of the original fix was right: the node being typed into is
  empty *at that moment*, and writing it mid-keystroke is what would drop text.
- **A rejection repeats the host's own reason.** The panel still selects the node the host names by
  position, but it no longer assumes the reason is emptiness — that assumption would have described,
  say, an unsupported kind as 「还没有内容」.

## P15: shape vocabulary and a toolbar that stops growing

Asked for 2026-09-20 with a screenshot of a five-row toolbar: shapes have no character (a rounded
"rectangle"), a diamond is briefly a rectangle, style settings are always on screen, projects,
layout, paper binding, source and the view controls are all in the open, and the board's files are
one dropdown.

- **Every kind looks like what it is.** Rectangle square-cornered, sticky note warm paper with a
  turned-up corner and a soft lift, concept and paper the rounded containers, ellipse and diamond
  their own shapes. The PNG export shares the same radius table, so the file matches the canvas.
- **The naming box must not hide the shape.** The inline editor was an opaque rounded rectangle
  covering the node, which is why a new diamond read as a rectangle until the reader clicked away.
  It is now a translucent dashed box, and the shape is visible throughout (the DOM was a `polygon`
  all along — the report was a rendering illusion, and the receipt-free fix is the styling).
- **Context, not inventory.** Node settings appear for a selected node, link settings for a selected
  link, and nothing when the canvas is empty. Projects and layout each get a dropdown panel,
  paper binding plus source/Mermaid content live in a ☰ menu, and the view controls (fit, full
  screen, focus — with zoom) sit together. Menus are overlays: opening one never reflows the canvas,
  Escape or a click outside closes it, and only one is open at a time.
- **Files are a list.** 「画板 ▾」 opens the board's own file list — title, node and link counts,
  open, delete — with rename and 「＋ 新建画板」 at the bottom. The old `<select>` survives as the
  hidden value the receipts read; the interface no longer presents a lone dropdown.

## P16: an overlay has to move with the scene

Reported 2026-09-22: after drawing a text shape, panning the canvas with a trackpad showed **two**
text boxes, both typeable; clicking once left only the newest, and further pans were fine.

The inline text editor is a DOM `textarea` in `.board-editor-layer`, positioned in *screen*
coordinates from its node (`node.x * zoom + view.x`). It was placed once, when it opened. Panning or
zooming moves the SVG scene and leaves the overlay where it was, so the node appeared in its new
place and a detached, still-focused input box stayed behind — the second box. A click then commits
that editor and opens a fresh one on the node, which is why only one survived.

The fix gives the renderer an `onViewApplied` hook, fired whenever the viewport transform is really
written, and the panel repositions the open editor there. One rule (`placeTextEditor`) serves both
opening and tracking, so the box cannot drift from its node; the panel test asserts a pan moves it by
exactly the pan distance and a zoom resizes it, with never more than one editor in the layer, and the
browser receipt asserts the same against real geometry (offset inside the node preserved, zoom
restored afterwards).

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
  **Implemented, 30 cases** (geometry — including by-identity assertions that `board.geometry`'s
  edge helpers *are* `board-source.js`'s functions — model bounds, paper nodes, outline, panel
  persistence, conflict recovery, listing failure, tidy arranging, settle-on-close, graph-node
  conversion and the closed-board graph path, the late reveal of the project picker, the 「更多」
  toggle, and the loading gate that keeps the drawing tools off until a record has loaded).
- `tests-js/board-vocabulary.test.mjs` — the one-owner contract: the node kinds, edge kinds,
  relations, arrow ends, layout modes and directions that `web/board-source.js` states must equal
  the private sets `src/harness/board-store.mjs` validates with, its limits must equal
  `BOARD_LIMITS` under the host's longer names, every kind must have a positive default size and
  survive the source codec, and the panel must still read them through `sourceApi()` rather than
  restating a literal. **Implemented, 5 cases.** The host constants are read from its source
  because they are deliberately not exported, and a missing declaration fails the test rather than
  being skipped.
- `tests-js/board-references.test.mjs` — token parse/render, chip codec round-trip, snapshot
  integrity, and `agent/pre-step` expansion including the malformed and over-budget paths.
  **Implemented, 6 cases** (including the incidence sweep).
- `tests-js/board-source.test.mjs` — edge geometry (waypoints, elbow corners, bend-point
  editing), the three layout modes across four directions and two node orders, the source and
  style validators, and a **parity check that everything the source module emits passes the
  host's own validator**. **Implemented, 5 cases.**
- `scripts/board-browser-fixture.mjs` — real Chromium receipt for draw/drag/zoom/connect/save/reload,
  library drag-in, tidy-tree snapping, and the standalone refusal of the conversation chip.
  **Implemented, 32 checks** in `docs/validation/board-browser.json` (including a knowledge-graph node joining a board, the connect tool, a bend point, automatic layout with a pinned node, the source/style pair, the plugin's own board entry opening as a pure canvas, and the drawing-cost guard that counts DOM work).
- `scripts/board-harness-smoke.mjs` — native DSH check that the tool is offered, that a board token
  reaches a turn as frozen material, and that an unresolvable reference fails the turn.
  **Implemented, 7 checks** in `docs/validation/board-harness.json`.
- `tests-js/projects.test.mjs` — the project tables and the bridge/tool surface: create, scope,
  link, rename, archive/restore, the many-to-many edge, `resource_list`'s project filter, the
  `library_projects` mapping (including refused host-owned fields), and the allowlist.
  **Implemented, 4 cases** against a temporary synthetic library.
- `scripts/project-ui-fixture.mjs` — real Chromium receipt for the project view: creation and a
  scoped library list, one paper in several projects, tick-to-join/untick-to-leave membership, the
  inline create-and-join, rename, archive-without-touching-papers, the board-to-project link, and
  the ribbon button pressed while the paper is still loading. **Implemented, 9 checks** in
  `docs/validation/project-ui.json`.

## Renderer: what Excalidraw does, and what this board took from it

Excalidraw is the reference implementation for this surface, so its renderer was read directly
(`packages/excalidraw/renderer/staticScene.ts`, `interactiveScene.ts`, `renderer/helpers.ts`,
`components/canvases/StaticCanvas.tsx`, `packages/element/src/renderElement.ts`,
`collision.ts`) rather than from a summary. What it does, and where this project stands:

| Excalidraw | This board | Decision |
| --- | --- | --- |
| Two canvases: a **static** scene and an **interactive** one, so a selection drag repaints only the selection layer | One SVG tree per board; selection adds handles to the node's own group | Kept SVG. The board is bounded at 400 nodes/800 edges, and one tree is what makes text selection, CSS theming, `getComputedStyle`-based receipts and the PNG export straightforward. A second layer would buy little at this scale. |
| **Persistent scene**: element elements are reused across renders; `StaticCanvas` is memoised on `elementsMap`/`visibleElements` identity plus a shallow app-state compare | **Adopted.** `render()` reconciles keyed by board id instead of `replaceChildren()`, and writes an attribute only when its value actually differs | This was the one real gap. Rebuilding threw away ~1,200 elements and wrote ~3,700 attributes for every selection, rename or save-status change. |
| Per-element **bitmap cache** in a `WeakMap`, regenerated only when the element object or zoom/theme changes, blitted on whole device pixels | Not applicable: SVG has no bitmap to cache, and the browser already caches rasterisation per element | Documented as a deliberate non-adoption. The equivalent win is element identity, which is what the reconciliation above provides. |
| Viewport **culling** (`visibleElements` computed from scroll/zoom before painting) | None; every node is drawn | **Measured and rejected.** Hiding every off-screen node of a 200-node board in Chromium changed the drag frame not at all (median 8.1 ms before and after, p95 8.8 → 8.4 ms — the browser already skips painting what is clipped). The receipts also assert on the drawn tree (`document.querySelectorAll('.board-node')`). Revisit only if the node cap rises. |
| `requestAnimationFrame` **throttling** (`renderStaticSceneThrottled`, `throttleRAF`) | None: a render runs synchronously in the event that caused it | Deliberately deferred. `redrawGeometry` is already the cheap drag path, and coalescing changes when the DOM is readable — which several browser receipts rely on. Worth doing together with a receipt that measures frame timing, not before. |
| Hit-testing: **rotated bounding box first, precise test second, cached by (point, threshold, element version)** | Bounding-box scan for nodes (`hitNode`), segment-distance scan for edges | Equivalent in effect at this size; the early-out is already the bounding box. The cache is unnecessary for ≤400 items. |
| DPR-aware canvas sizing (`getNormalizedCanvasDimensions`, `scale`), whole-device-pixel grid snapping for the background | `applyView` scales the SVG group and sets the grid's `background-size`/`background-position` | SVG scales natively; the grid follows the same transform. No action needed. |

### The two changes that came out of the comparison

- **The connect gesture no longer leaks a DOM node per pointer move.** Dragging from a node's
  connect handle appended a fresh dashed preview path on every `pointermove` and never removed the
  previous one; a 40-step drag left 40 identical paths in the edge layer for the browser to repaint.
  It is now one element per gesture whose `d` is rewritten, removed when the pointer leaves every
  node, and removed unconditionally by the single `cancelDrag()` teardown (which also covers closing
  the board or disposing the panel mid-gesture). Measured before/after in Chromium: 11 paths during a
  40-move drag → 1.
- **The scene is reconciled, and writes are conditional.** `render()` used to discard and rebuild
  every node and edge. It now keeps the element maps as a keyed index, creates only what is new,
  updates in place, and removes what left the board — the same persistent-scene property Excalidraw
  relies on, expressed for SVG. On top of that, `attr()`/`textOf()` compare before writing, because a
  `setAttribute` that writes the same string still invalidates the element it was written to.

  Measured on a 150-node/149-edge board in Chromium (one `render()` after load):

  | | elements created | `setAttribute` calls | `render()` |
  | --- | --- | --- | --- |
  | before | 1,197 | 3,743 | 1.9 ms |
  | after | 0 | 151 | 1.4 ms |

  The JavaScript time was never the problem — the DOM mutations were, and they are what invalidate
  style, layout and paint. The remaining 151 writes are the per-node class strings, which change
  because the selection changed; a render with no change at all now writes nothing.

  The same measurement applied to a *drag* found the same pattern once more. `redrawGeometry` is the
  cheap path, but it rewrote every node and every edge on every pointer move. It now takes the ids
  the gesture touched (a move passes the dragged set, a resize its one node, a bend-point drag the
  two endpoints, and the connect gesture — which moves nothing on the board — no longer calls it at
  all). Dragging one node on a 150-node/149-edge board:

  | per pointer move | attribute writes | median | p95 |
  | --- | --- | --- | --- |
  | before | 1,504 | 8.1 ms | 11.1 ms |
  | after | 9.3 | 7.9 ms | 9.8 ms |

  The frame time is dominated by the browser's own layout and paint of a 150-node SVG, not by this
  renderer's JavaScript; what the change removes is the invalidation of ~300 elements per frame, which
  is also what keeps a drag smooth on a slower machine or a bigger board. The full-board pass is still
  one call away (`redrawGeometry()` with no argument) for a layout or a marquee.

  Measuring from *inside* the page — a Playwright round-trip per mouse move costs milliseconds of its
  own — puts the remaining picture plainly: dragging one node of a 200-node board, the panel's whole
  synchronous pointermove handler (board update, scoped geometry rewrite, viewport transform) takes
  **0.1 ms at p90**, while the interval between frames sits at the display's own 8.3 ms. The drawing
  path is therefore no longer the limit at the board sizes the record format allows, which is why the
  work stopped here rather than adding `requestAnimationFrame` coalescing on top: coalescing would
  move when the DOM becomes readable, and several receipts depend on reading it after an action.

  One more redundant write fell out of the same reasoning: `applyView` rewrote the transform of the
  group that holds the entire scene on every drag frame, even though moving a node does not move the
  view. It now writes only when the view actually changed, which keeps the whole scene out of style
  and paint invalidation on those frames. A panel case pins it: a node drag and a repaint write nothing
  to the viewport group, one zoom writes it exactly once with the new scale, and two view changes write
  it twice.

  The guard that keeps this honest lives in the browser receipt instead of a timing test: it
  instruments `createElementNS` and `Element.prototype.setAttribute`, asserts that re-rendering an
  unchanged 60-node board creates nothing and writes nothing, and that a six-step drag of one node
  stays under 200 attribute writes. Counts are deterministic; a wall-clock budget in a test is a flake
  waiting for a loaded machine.

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

