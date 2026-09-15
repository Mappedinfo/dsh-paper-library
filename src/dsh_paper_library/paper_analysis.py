"""Selected-page evidence and explicit, sourced metadata fill for background jobs.

This module never invokes a model, discovers another paper, renders a page, or
edits a PDF while preparing sources. The host owns short-lived job scheduling.
"""
import json

from .core import PaperConflictError, normalize_research_metadata, now
from . import library_knowledge as knowledge

MAX_PAGES = 8
DEFAULT_PAGES = 3
MAX_PAGE_CHARACTERS = 8000
MAX_CHARACTERS = 24000
METADATA_FIELDS = {
    "title", "author", "editor", "issued", "container-title", "publisher",
    "publisher-place", "abstract", "volume", "issue", "page", "URL",
    "language", "ISSN", "ISBN", "publication_dates",
}
STRUCTURED_FIELDS = {"author", "editor", "issued", "publication_dates"}


def file_version(path):
    value = path.stat()
    # No path or whole-file hash is needed to preserve the extracted snapshot.
    return {"device": value.st_dev, "inode": value.st_ino, "bytes": value.st_size,
            "modified_ns": value.st_mtime_ns}


def selected_pages(value):
    if value is None:
        return None
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_PAGES:
        raise ValueError("PAPER_ANALYSIS_INVALID: select 1–8 PDF page numbers")
    if any(isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 2000 for page in value) or len(set(value)) != len(value):
        raise ValueError("PAPER_ANALYSIS_INVALID: page numbers must be unique integers from 1 to 2000")
    return value


def sources(library, request):
    pages = selected_pages(request.get("pages"))
    paper = library.get(request.get("id"))
    limits = {"pages": MAX_PAGES, "default_pages": DEFAULT_PAGES,
              "page_characters": MAX_PAGE_CHARACTERS, "characters": MAX_CHARACTERS}
    result = {"paper": paper, "expected_modified": paper["modified"], "sources": [],
              "source_ids": [], "limits": limits}
    coverage = {"scope": "selected-pages", "full_document": False, "requested_pages": [],
                "read_pages": [], "blank_pages": [], "truncated_pages": [], "omitted_pages": [],
                "characters": 0, "page_count": 0, "selection": "explicit" if pages is not None else "first-pages"}
    result["coverage"] = coverage
    if not paper["pdf"]:
        if pages is not None:
            raise ValueError("PAPER_ANALYSIS_INVALID: cannot select pages without an attached PDF")
        coverage["scope"] = "metadata-only"
        return result

    path = library.pdf_path(paper["id"])
    before = file_version(path)
    extracted = []
    with library._open_pdf(path) as doc:
        page_count = doc.page_count
        pages = pages if pages is not None else list(range(1, min(DEFAULT_PAGES, page_count) + 1))
        if any(page > page_count for page in pages):
            raise ValueError("PAPER_ANALYSIS_INVALID: selected PDF page does not exist")
        coverage.update(requested_pages=pages, page_count=page_count)
        for page_number in pages:
            remaining = MAX_CHARACTERS - coverage["characters"]
            if not remaining:
                coverage["omitted_pages"].append(page_number)
                continue
            # Access only requested pages. Plain text extraction omits images;
            # the native worker's process deadline also bounds parser lifetime.
            content = doc.load_page(page_number - 1).get_text("text", sort=True).strip()
            coverage["read_pages"].append(page_number)
            if not content:
                coverage["blank_pages"].append(page_number)
                continue
            limit = min(MAX_PAGE_CHARACTERS, remaining)
            truncated = len(content) > limit
            excerpt = content[:limit].rstrip()
            if truncated:
                coverage["truncated_pages"].append(page_number)
            coverage["characters"] += len(excerpt)
            extracted.append((page_number, excerpt, truncated))
    if file_version(path) != before:
        raise ValueError("PAPER_ANALYSIS_SOURCE_CHANGED: PDF changed during extraction; select again")
    current = library.get(paper["id"])
    if current["modified"] != paper["modified"]:
        raise PaperConflictError(current)
    knowledge.setup(library)
    for page_number, excerpt, truncated in extracted:
        source = knowledge.source_put(library, {
            "entity": {"kind": "paper", "id": paper["id"]}, "kind": "source-note",
            "text": excerpt, "title": f"PDF page {page_number} · {paper['title']}"[:500],
            "locator": {"page": page_number, "section": "Selected PDF page excerpt"},
        }, trusted_provenance={"kind": "selected-pdf-page", "file_version": before,
                               "scope": "selected-pages", "full_document": False,
                               "truncated": truncated, "extraction": "plain-text", "ocr": False})
        result["sources"].append(source)
        result["source_ids"].append(source["id"])
    return result


def empty(value):
    return value is None or value == [] or value == {} or isinstance(value, str) and not value.strip()


def field_evidence(library, paper_id, supplied, fields):
    if not isinstance(supplied, dict) or set(supplied) != fields:
        raise ValueError("PAPER_ANALYSIS_INVALID: field_sources must cover exactly the proposed metadata fields")
    result, total = {}, 0
    for field, refs in supplied.items():
        if not isinstance(refs, list) or not 1 <= len(refs) <= 4:
            raise ValueError("PAPER_ANALYSIS_INVALID: each metadata field requires 1–4 exact source excerpts")
        normalized = []
        for ref in refs:
            if not isinstance(ref, dict) or set(ref) != {"source_id", "quote"}:
                raise ValueError("PAPER_ANALYSIS_INVALID: metadata evidence accepts source_id and quote")
            quote = ref["quote"]
            if not isinstance(quote, str) or not quote.strip() or len(quote) > 2000:
                raise ValueError("PAPER_ANALYSIS_INVALID: evidence excerpt must contain 1–2000 characters")
            total += len(quote)
            if total > 12000:
                raise ValueError("PAPER_ANALYSIS_INVALID: metadata evidence exceeds 12000 characters")
            source = knowledge.get(library, "sources", ref["source_id"])
            if source["entity"] != {"kind": "paper", "id": paper_id}:
                raise ValueError("PAPER_ANALYSIS_INVALID: metadata evidence belongs to another item")
            if quote not in source["text"]:
                raise ValueError("PAPER_ANALYSIS_INVALID: metadata evidence must be an exact saved excerpt")
            normalized.append({"source_id": source["id"], "quote": quote,
                               "content_hash": source["content_hash"], "locator": source["locator"]})
        result[field] = normalized
    return result


def apply_metadata(library, request):
    expected = request.get("expected_modified")
    if not isinstance(expected, str) or not expected:
        raise ValueError("PAPER_ANALYSIS_INVALID: expected_modified is required")
    proposed = request.get("metadata")
    if not isinstance(proposed, dict) or not proposed or set(proposed) - METADATA_FIELDS:
        raise ValueError("PAPER_ANALYSIS_INVALID: metadata accepts only bibliographic fill fields; identities and DOI are protected")
    if len(json.dumps(proposed, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 64000:
        raise ValueError("PAPER_ANALYSIS_INVALID: proposed metadata exceeds 64000 bytes")
    for field, value in proposed.items():
        if empty(value):
            raise ValueError("PAPER_ANALYSIS_INVALID: proposed metadata fields must not be empty")
        if field not in STRUCTURED_FIELDS and (not isinstance(value, str) or "\x00" in value):
            raise ValueError("PAPER_ANALYSIS_INVALID: bibliographic scalar fields must be text")
        if field == "issued" and (not isinstance(value, dict) or set(value) - {"date-parts", "literal"} or not value):
            raise ValueError("PAPER_ANALYSIS_INVALID: issued requires a CSL date object")
        if field == "issued" and "literal" in value and (not isinstance(value["literal"], str) or not value["literal"].strip()):
            raise ValueError("PAPER_ANALYSIS_INVALID: issued.literal must be text")
    proposed = normalize_research_metadata(dict(proposed))
    old = library.get(request.get("id"))
    if old["modified"] != expected:
        raise PaperConflictError(old)
    knowledge.setup(library)
    evidence = field_evidence(library, old["id"], request.get("field_sources"), set(proposed))
    patch, applied, skipped = {}, [], []
    retained = dict(old.get("analysis_metadata_sources") or {})
    for field, value in proposed.items():
        if field == "publication_dates":
            dates = dict(old.get(field) or {})
            for part, date in value.items():
                name = f"publication_dates.{part}"
                if empty(dates.get(part)):
                    dates[part] = date
                    applied.append(name)
                    retained[name] = {"sources": evidence[field], "origin": "llm", "review_status": "needs-review", "applied_at": now()}
                else:
                    skipped.append(name)
            if dates != old.get(field):
                patch[field] = dates
        elif empty(old.get(field)):
            patch[field] = value
            applied.append(field)
            retained[field] = {"sources": evidence[field], "origin": "llm", "review_status": "needs-review", "applied_at": now()}
        else:
            skipped.append(field)
    if applied:
        patch["analysis_metadata_sources"] = retained
        paper = library.update(old["id"], patch, expected_modified=expected)
    else:
        # A no-op must not rewrite the PDF or modification stamp, but still
        # reports a concurrent metadata edit consistently with a real save.
        with library.lock():
            paper = library.get(old["id"])
            if paper["modified"] != expected:
                raise PaperConflictError(paper)
    return {"paper": paper, "applied_fields": applied, "skipped_fields": skipped}


def dispatch(library, request):
    if request.get("action") == "paper_analysis_sources":
        return sources(library, request)
    if request.get("action") == "paper_analysis_apply_metadata":
        return apply_metadata(library, request)
    raise ValueError("PAPER_ANALYSIS_INVALID: unsupported analysis action")
