# Skill adaptation provenance

Verified 2026-09-14. The bundled `skills/paper-library-fetch/SKILL.md` is a project-maintained adaptation of Shiqi's canonical `paper-fetch-skill`, integration version1. Canonical entry SHA-256 at adaptation: `6897894dec45abe806150c9032c6421f4f9df2b65804649aaef618d6a8695627`.

The adaptation retains identifier resolution, actual-PDF verification, bounded sequential acquisition, clear partial results and access limits. The user explicitly selected this independent library as the destination, so the bundled version uses `library_import` and portable PDF metadata. The original skill's Zotero-first routing does not apply to this plugin. The canonical skill was not edited.

The runtime name is `paper-library-fetch`. Actual host verification showed that using the upstream name selected the user's existing filesystem skill before the bundled registration. A distinct plugin name keeps both skills available and makes the independent-library route unambiguous; host tests assert the resolved skill's full packaged path as well as its name.

This package implements public acquisition in `src/paper-fetch.mjs`; it does not redistribute or require external ScanSci, paper-fetch MCP, CloakBrowser, or publisher-specific browser providers. The bundled skill names only tools supplied by this plugin, plus conditional use of whatever discovery tools the calling session already has. It is registered through the actual local Harness skill service, without a global installation or file watcher.

Protocol references:

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) and [full-text links](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/).
- [arXiv API manual](https://github.com/arXiv/arxiv-docs/blob/develop/source/help/api/user-manual.md); explicit versions are retained.
- [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) inform public-address validation.

These are retrieval/transport references, not promises that any publisher permits anonymous PDF downloads. Source receipts and identity checks remain attached to each acquisition.
