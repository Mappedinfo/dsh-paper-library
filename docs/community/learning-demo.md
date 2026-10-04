# Generic learning demonstration

These current UI screenshots use only generic methods for reading, thinking and
writing. The three documents are titled **How to read a paragraph**, **How to ask
a clear question**, and **How to revise a draft**. Their author is **Learning
Demo**. Every document is generated locally and visibly labelled as a synthetic
reading example.

| Image | Content |
| --- | --- |
| `../images/learning-library.jpg` | The current library with exactly three learning documents and one learning-loop board. There are no reading projects. Captured at 1440 × 720. |
| `../images/learning-annotations.jpg` | A paragraph about restating what was read, asking a question and clarifying a sentence. The highlight, underline and two learning comments are standard PDF annotations. Captured at 1440 × 1000. |
| `../images/learning-board.jpg` | A new linear loop: 阅读（预览／提问／复述）→ 思考（列出理由／找反例／保留疑问）→ 写作（列提纲／写短稿／校对）→ 返回阅读. The first three stages link to the corresponding practice documents. Captured in the existing focus mode at 1440 × 900. |

## Reproduce

With the normal project Python environment and Playwright available:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-learning-demo.mjs
```

The script calls `scripts/create-demo.py` and creates a fresh
`.local/learning-demo-*` directory with an isolated library and local-state home.
It does not read an existing document collection, profile, live host or private
configuration. It seeds the learning annotations and learning board through the
normal APIs, then navigates the actual Chromium UI. No DOM/style override,
retouching or simulated model output is used.

The positive content checks compare every generated metadata field and every
page's extracted PDF text with the explicitly allowed learning content. They
also read back both native PDF annotations and the saved board, matching the
learning quotations, comments, author, node text, document bindings and edges.
The source PDF hashes must remain unchanged. Local readback files stay inside
the ignored run directory.

`learning-demo.json` records the image hashes, dimensions, checks and observed
API actions. `models` reads availability and `feedback` reads saved PDF
feedback; neither makes a model-generation request in this standalone host.
The completed run made no external requests or model calls and raised no browser
errors. The browser, HTTP service and queue are closed after capture.

All three images were visually inspected against this generic-learning content
boundary. They demonstrate current UI behavior with deliberate example data;
they do not establish physical Pencil input or live model behavior. The
coordinator also inspected all three final images before publication.
