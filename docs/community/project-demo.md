# Current project screenshots

These screenshots show the current shipped UI in real Chromium, using a fresh
standalone host and an isolated synthetic library. They are direct JPEG captures
at 1440 × 1000 CSS pixels in the light theme, without retouching or DOM/style
overrides.

| Image | What it shows |
| --- | --- |
| `../images/project-library.jpg` | Eight synthetic catalog records, two reading projects, and a saved board linked to three papers and both projects. Three records have generated PDFs; the other five are metadata-only examples. |
| `../images/project-annotations.jpg` | A generated PDF beside the current annotation rail. The highlight, underline, source quotations and comments are recovered from standard PDF annotation objects. |
| `../images/project-board.jpg` | The real whiteboard in its existing focus mode: one organizing question, three bound paper nodes, three reading-question notes, a provenance note, and six links. The host has saved the board before capture. |

## Reproduce

After preparing the project's normal Python environment and Playwright:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-project-demo.mjs
```

The script uses `scripts/create-demo.py`, the same synthetic PDF generator used
by `scripts/prepare-promotion-demo.mjs`. Every run creates a fresh
`.local/project-demo-*` directory with its own library and local-state home. It
does not open the user's library, DSH profile, Zotero database or live host.
The generated document header labels the content as a synthetic reading
example. Author names in the three fixture PDFs come from the generator, not
from private research records.

The script seeds deliberate reading comments and board content through the
normal core/HTTP APIs, then navigates the real browser UI to capture each view.
It does not simulate an AI reply, transcription, model proposal or empirical
finding. Board links organize demonstration reading questions; they are not
claims of real citation or scientific support.

`project-demo.json` records the screenshot hashes, capture time, runtime
directory, visible-content checks and observed API actions. `models` is an
availability read and `feedback` reads saved PDF feedback; neither is a model
generation call in this standalone fixture. The run verifies that the original
three generated PDFs remain byte-for-byte unchanged, the saved annotations and
board match the displayed content, and there are no external requests or browser
errors. The browser, synthetic HTTP service and queue are closed after capture.

These images demonstrate the library, reading/annotation and board surfaces.
They do not establish physical Pencil/Sidecar behavior, live DSH model output,
or performance on a user's device.
