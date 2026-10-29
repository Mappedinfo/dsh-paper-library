# Dependencies and provenance

Original project code, documentation and the project-maintained skill are licensed under [MIT](LICENSE), copyright 2026 Mappedinfo contributors. This grant does not relicense third-party dependencies, bundled CSL data, or third-party license texts.

The default installation uses PyMuPDF/MuPDF and the AGPL option of citeproc-js. Distribution or network deployment of the combined application must comply with the applicable AGPL terms; offering our own files under MIT does not make that installation MIT-only. Replacing the PDF dependency or obtaining an applicable Artifex commercial license would be separate work. A short-lived worker process is a memory-management choice, not a claimed license exemption. See [PyMuPDF's licensing notice](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright) and the retained [AGPL text](licenses/AGPL-3.0.txt).

Project scaffolding was generated through the author's `academic-templates/dev-project` Copier template on 2026-09-14. This Mappedinfo project carries no university affiliation.

| Component | Purpose | Upstream / license |
|---|---|---|
| PyMuPDF / MuPDF | Native PDF annotations, metadata, current-page render | [PyMuPDF](https://pymupdf.readthedocs.io/en/latest/) / AGPL or Artifex commercial license; default dependency uses AGPL |
| pymupdf4llm 0.2.9 | Opt-in PDF page-to-Markdown extraction | [PyMuPDF4LLM](https://github.com/pymupdf/RAG) / AGPL-3.0 or Artifex commercial license |
| tabulate 0.10.0 | Table formatting used by the Markdown extraction dependency | [tabulate](https://github.com/astanin/python-tabulate) / MIT |
| openpyxl 3.1.5、et_xmlfile 2.0.0 | 按需读取 XLSX 工作表已保存的值；不执行公式或外部链接 | [openpyxl](https://openpyxl.readthedocs.io/)、[et_xmlfile](https://et-xmlfile.readthedocs.io/) / MIT；Python 运行依赖独立安装，未随源码捆绑 |
| filelock 3.32.7 | 文献库跨进程写锁，使用 Windows／POSIX 原生锁并保留锁文件 | [filelock](https://py-filelock.readthedocs.io/) / MIT；Python 运行依赖独立安装，未随源码捆绑 |
| citeproc-js | CSL processor | [citeproc-js](https://github.com/Juris-M/citeproc-js) / CPAL-1.0-or-later or AGPL-3.0-or-later; default here uses the AGPL option, [upstream notice retained](licenses/citeproc-NOTICE.txt) |
| Citation.js core and BibTeX plugin | BibLaTeX parsing and output | [Citation.js](https://github.com/citation-js/citation-js) / MIT |
| CodeMirror 6、LaTeX 模式、Lezer 及配套包 | 本地打包的源码编辑器 | [CodeMirror](https://codemirror.net/) / MIT；依赖许可声明保存在 [codemirror-MIT.txt](licenses/codemirror-MIT.txt) |
| Silkscreen Regular | 用于文件路径的本地像素字体 | [Google Fonts](https://github.com/google/fonts/tree/main/ofl/silkscreen) / SIL Open Font License 1.1；[许可](licenses/silkscreen-OFL.txt) |
| Official APA CSL style | APA 7 rules | [CSL styles](https://github.com/citation-style-language/styles/blob/master/apa.csl) / CC BY-SA 3.0; embedded authors/rights retained |
| CSL en-US locale | Citation localization | [CSL locales](https://github.com/citation-style-language/locales) / CC BY-SA 3.0; embedded authors/rights retained |
| esbuild | Build the tiny Harness client adapter | [esbuild](https://github.com/evanw/esbuild) / MIT |
| DeepSeek Harness | Host plugin, tools and model APIs | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / MIT; installed separately |
| Zotero translation-server | Optional loopback metadata supply (translators for `/search` and `/web`) | [translation-server](https://github.com/zotero/translation-server) / AGPL-3.0; deployed separately by the operator, never bundled or started by this plugin |

`jgraph/drawio-mcp` (npm `@drawio/mcp`, Apache-2.0) was installed into a gitignored `.local/` directory and run once to read its tool surface and the `.drawio` files it writes. Our `.drawio` codec (`web/board-drawio.js`) and our MCP server (`mcp/server.mjs`) are our own implementations of the observed format and tool shape: no file from that project is copied, bundled or depended on, so nothing of it is redistributed here. License evidence, the observed format contract and our interop scope are recorded in [docs/mcp.md](docs/mcp.md).

The APA style and en-US locale are supplied by the [Citation Style Language project](https://citationstyles.org/), under CC BY-SA 3.0. Their original author/translator credits and rights links remain embedded in each unchanged file.

`vendor/csl/manifest.json` records retrieval date, upstream URLs and exact SHA-256 hashes. `scripts/fetch-csl.mjs` refreshes assets explicitly; tests verify recorded hashes. Lockfiles pin installed package versions. Third-party Python/Node runtime packages are installed separately, not vendored in this source repository. Preserve their full notices when distributing them.

The bundled `paper-library-fetch` is adapted for this plugin from the user's canonical `paper-fetch-skill`. Its source revision, retained behavior and independent-library changes are recorded in [the skill provenance manifest](docs/upstream-manifest.md).
