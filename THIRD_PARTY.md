# Dependencies and provenance

Project scaffolding was generated through the locally installed canonical `academic-templates/dev-project` Copier template on 2026-09-14. No university affiliation is implied by this Mappedinfo project.

| Component | Purpose | Upstream / license |
|---|---|---|
| PyMuPDF / MuPDF | Native PDF annotations, metadata, current-page render | [PyMuPDF](https://pymupdf.readthedocs.io/en/latest/) / AGPL or Artifex commercial license; this project uses AGPL |
| citeproc-js | CSL processor | [citeproc-js](https://github.com/Juris-M/citeproc-js) / CPAL-1.0 or AGPL-3.0 |
| Citation.js core and BibTeX plugin | BibLaTeX parsing and output | [Citation.js](https://github.com/citation-js/citation-js) / MIT |
| Official APA CSL style | APA 7 rules | [CSL styles](https://github.com/citation-style-language/styles/blob/master/apa.csl) / CC BY-SA 3.0; embedded authors/rights retained |
| CSL en-US locale | Citation localization | [CSL locales](https://github.com/citation-style-language/locales) / locale repository license; source retained verbatim |
| esbuild | Build the tiny Harness client adapter | [esbuild](https://github.com/evanw/esbuild) / MIT |
| DeepSeek Harness | Host plugin, tools and model APIs | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); host owns its runtime sources |

`vendor/csl/manifest.json` records retrieval date, upstream URLs and exact SHA-256 hashes. `scripts/fetch-csl.mjs` refreshes assets explicitly; tests verify recorded hashes. Lockfiles pin installed package versions. This repository is local and private; no remote or package publication was created.

The bundled `paper-library-fetch` is adapted for this plugin from the user's canonical `paper-fetch-skill`. Its source revision, retained behavior and independent-library changes are recorded in [the skill provenance manifest](docs/upstream-manifest.md).
