# Handwriting demonstration screenshots

The three JPEGs in `docs/images/` are direct Chromium captures of the current
standalone reading interface:

- `handwriting-inline.jpg`: a text highlight, circle, arrow and handwritten
  question on the PDF page, while the unified handwriting row shows saving
  progress.
- `handwriting-preview.jpg`: saved native PDF ink and the actual annotation
  card's SVG preview, with the original passage still visible.
- `handwriting-locate.jpg`: the result of clicking that preview. The temporary
  outline locates the saved ink; the toolbar offers a return to the preceding
  reading position.

The document, title and reading passage are original synthetic fixture content.
The PDF labels itself **SYNTHETIC READING EXAMPLE**. It contains no empirical
finding, real paper excerpt, personal library record or AI-generated response.
The question `same data?` is a deterministic collection of pen paths delivered
through Chromium's input interface. It is not evidence of physical Pencil,
Sidecar, pressure or palm-rejection behavior.

## Reproduce

With the project's Python environment and Playwright available:

```sh
node scripts/capture-handwriting-demo.mjs
```

If Playwright is provided by a separate runtime, set `PLAYWRIGHT_MODULE` to its
`playwright/index.mjs` path when invoking the same script.

Each run creates a new isolated library under `.local/handwriting-demo-*`, starts
its own loopback server on an unused port, and writes the three JPEGs above plus
`docs/community/handwriting-demo.json`. The receipt records the image hashes,
synthetic provenance and completed checks. The browser and temporary server
close at the end. The user's existing host and library are never opened.

The script uses the real highlight selection, linked handwriting, durable
queue, native PDF write, SVG preview and preview-navigation flows. It also
checks that the generated source file stays unchanged, all demonstration
strokes reach native Ink, no transcription appears, and no external or model
request occurs. The 1440 × 1080 captures have no retouching or injected layout
styles; the sidebar is widened with its existing resize control.
