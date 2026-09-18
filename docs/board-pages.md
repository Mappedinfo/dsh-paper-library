# Independent whiteboard on GitHub Pages

The whiteboard has two hosts and one canvas.

| | DSH plugin (main platform) | GitHub Pages (this service) |
| --- | --- | --- |
| Canvas code | `web/board.js` | the same file, copied at build time |
| Markup | `web/index.html` `#board-view` | extracted from that same section by `scripts/build-site.mjs` |
| Storage | host records under `$DSH_HOME/paper-library/<library-hash>/state` | the browser's `localStorage` |
| Papers, reader, conversation references | yes | no (the controls are hidden, not faked) |
| Model use | only through explicit DSH actions | none |

Nothing about the page is a fork: `site/index.html` is a thin shell, `site/standalone.js`
implements the same eight board actions the plugin host does, and the markup is injected at
build time so an edit to the plugin's toolbar cannot leave the public page behind.

## Build and deploy

```sh
node scripts/build-site.mjs        # writes _site/ (ignored by Git)
node scripts/board-standalone-fixture.mjs   # real Chromium receipt, needs a static server
```

`.github/workflows/pages.yml` runs the same build on every push to `main` that touches the
site inputs and deploys `_site` through `actions/deploy-pages`. The published site is
`https://<owner>.github.io/<repo>/`; every asset path is relative, so the project subpath
needs no configuration. Enabling Pages once is a repository setting (Source: GitHub
Actions); after that the workflow self-deploys.

## What the service does

Free canvas with pan/zoom, text/note/rectangle/ellipse/diamond nodes, drag and resize,
connecting by dragging a handle, marquee selection, undo/redo, delete, tidy-tree arranging,
multiple boards, fullscreen, and export to PNG (painted from the model, so no stylesheet or
font dependency leaks into the image) and JSON (all boards, for backup and transfer).

## Storage honesty

`localStorage` is convenient, not durable: a browser or user can clear it, it is per-origin
and per-profile, and it holds roughly 5 MB — the store caps itself at 40 boards and 4 MiB and
says so instead of failing silently. **The exported JSON is the backup.** Importing a file
whose board id already exists never overwrites: the duplicate becomes a new board and the
page says so. Deleting a board writes a local tombstone rather than destroying it in place.

## Deliberately not here yet

No accounts, no server, no shared or multi-user boards, no freehand ink, no image import, and
no model access. An independent AI discussion surface would need a real backend (or a
user-supplied key) and belongs in a separate design; keeping this page model-free is what
lets it stay a static host.
