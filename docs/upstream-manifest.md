# Skill adaptation provenance

## Dataset knowledge workflow, 2026-09-15

`paper-library-knowledge` and `paper-library-notes` are independently authored MIT project adaptations of the contracts in `research-knowledge-os` and `knowledge-note`. Reviewed canonical entry SHA-256 values: `d8d440d75adff009d98635ae34431307193784c7003e45af800a8400e8c0c5be` and `b317f9a72c499c4d3fc0ca486bc4fa6268227a23523537ed16843441b0854fd9`. The implementation preserves explicit selected inputs, evidence levels, typed atomic relations, mandatory user review for AI proposals and readable source-bounded Markdown.

No upstream Python CLI, private notes, expert registry, bibliography, quality event or personal path is redistributed. The original canonical skills are unchanged. Both project skills are registered under distinct names through the real Harness skill service and use actual plugin tools. Model tools cannot accept a draft or overwrite a knowledge note.

`src/dsh_paper_library/library_knowledge.py` implements an independent bounded v3 subset mapper. Its export includes file roles, mapping and explicit losses. It does not call upstream auto-discovery or an APA bridge. The [synthetic upstream validation](validation/rkos-subset.json) invokes only the explicitly selected parser's pure parse/build/lint functions, with no private graph input. This checks a supported example, not every future graph or complete upstream interoperability.

## PDF acquisition

Verified 2026-09-14. The bundled `skills/paper-library-fetch/SKILL.md` is a project-maintained adaptation of Shiqi's canonical `paper-fetch-skill`, integration version1. Canonical entry SHA-256 at adaptation: `6897894dec45abe806150c9032c6421f4f9df2b65804649aaef618d6a8695627`.

The adaptation retains identifier resolution, actual-PDF verification, bounded sequential acquisition, clear partial results and access limits. The user explicitly selected this independent library as the destination, so the bundled version uses `library_import` and portable PDF metadata. The original skill's Zotero-first routing does not apply to this plugin. The canonical skill was not edited.

The runtime name is `paper-library-fetch`. Actual host verification showed that using the upstream name selected the user's existing filesystem skill before the bundled registration. A distinct plugin name keeps both skills available and makes the independent-library route unambiguous; host tests assert the resolved skill's full packaged path as well as its name.

This package implements public acquisition in `src/paper-fetch.mjs`; it does not redistribute or require external ScanSci, paper-fetch MCP, CloakBrowser, or publisher-specific browser providers. The bundled skill names only tools supplied by this plugin, plus conditional use of whatever discovery tools the calling session already has. It is registered through the actual local Harness skill service, without a global installation or file watcher.

Protocol references:

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) and [full-text links](https://www.crossref.org/documentation/retrieve-metadata/text-and-data-mining/).
- [arXiv API manual](https://github.com/arXiv/arxiv-docs/blob/develop/source/help/api/user-manual.md); explicit versions are retained.
- [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml) inform public-address validation.

These are retrieval/transport references, not promises that any publisher permits anonymous PDF downloads. Source receipts and identity checks remain attached to each acquisition.
