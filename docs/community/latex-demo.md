# Current LaTeX workspace demonstration

`docs/images/project-latex.jpg` is a direct Chromium capture of the current
standalone interface. The source on the left and PDF on the right belong to one
original synthetic manuscript, **From Reading Notes to a Manuscript**. Clicking
the actual Compile button runs the installed `latexmk` and `xelatex`; the image
shows their generated PDF, not a prepared illustration.

The DSH writing controls occupy the same reading sidebar as the current product.
This isolated standalone server has no DSH model connection, and the visible
message says so. No model reply, proposal or success state is simulated. The
manuscript contains no published excerpt, empirical result or private material.

## Reproduce

After installing the project's Python environment, Playwright and a local TeX
distribution with `latexmk` and `xelatex`:

```sh
node scripts/capture-latex-demo.mjs
```

If Playwright is installed elsewhere, set `PLAYWRIGHT_MODULE` to its
`playwright/index.mjs` when running the same command.

The script creates an isolated library, manuscript and host state under a new
`.local/latex-demo-*` directory, serves the shipped page on an unused loopback
port, and compiles through the real plugin worker. It checks the source, loaded
PDF, shared sidebar, disconnected model status, browser errors and external
requests. The browser and temporary server close after the capture.

`latex-demo.json` records the actual date, screenshot hash, compilation result
and checks. This JPEG is not retouched and uses no injected layout styles.
Earlier `latex-workspace*.jpg` images are retained as historical artifacts and
are not the image produced by this script.
