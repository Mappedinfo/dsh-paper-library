# Development contract

Read README.md and HANDOFF.md first. This is an independent DeepSeek Harness plugin, not a Zotero extension.

- Python worker runs on demand. No embedding model, background full-library parse, or always-on PDF engine. Bound every result and page render.
- Managed PDFs and private catalogs live under a user-selected library directory, excluded from Git. Never modify imported originals or live Zotero databases.
- Write annotations as standard PDF objects; reading must recover them from the PDF with no catalog annotation rows. Preserve external annotations. Back up before writing and atomically replace after successful serialization.
- Metadata errors stay visible; never invent missing authors, dates or DOI values. APA formatting uses CSL, not hand-written strings.
- AI output is generated commentary, distinguishable from source annotations. No model/key discovery from private config. Reuse configured Harness model services.
- Tests use synthetic documents only. Keep reproducible validation scripts and docs. Commit task changes after passing checks. The public source repository is `mappedinfo/dsh-paper-library`; never publish managed libraries, local configuration or runtime dependencies.
- Original project code uses MIT. Preserve the separate licenses of dependencies and bundled CSL assets; the default PyMuPDF runtime is AGPL/commercial and must not be presented as MIT-only.
