"""Selected-page evidence and explicit, sourced metadata fill for background jobs.

This module never invokes a model, discovers another paper, or edits a PDF.
Optional preprocessing/rendering stays on selected pages in the private library.
"""
import json

from .core import PaperConflictError, normalize_research_metadata, now
from . import library_knowledge as knowledge
from . import pdf_preprocessing as preprocessing

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
            "modified_ns": str(value.st_mtime_ns)}


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


def batch(library, request):
    """Advance through one PDF with a bounded, restartable text cursor.

    All pages are the default scope, but each worker accesses at most eight
    pages and returns at most eight chunks / 24,000 characters. Dense pages
    continue from their exact Unicode offset in the next batch.
    """
    input_format = request.get("input_format", "text")
    include_images = request.get("include_images", False)
    if input_format not in ("text", "markdown") or not isinstance(include_images, bool):
        raise ValueError("PAPER_ANALYSIS_INVALID: input_format must be text or markdown; include_images must be boolean")
    cursor_version = preprocessing.cursor_version() + ("/annotation-free-text" if input_format == "text" and include_images else "")
    pages = request.get("pages")
    if pages is not None:
        if not isinstance(pages, list) or not 1 <= len(pages) <= 2000 or any(isinstance(p, bool) or not isinstance(p, int) or not 1 <= p <= 2000 for p in pages) or len(set(pages)) != len(pages):
            raise ValueError("PAPER_ANALYSIS_INVALID: select unique PDF pages from 1 to 2000")
    cursor = request.get("cursor")
    if cursor is None:
        cursor = {"index": 0, "offset": 0}
    cursor_keys = {"index", "offset"}
    if isinstance(cursor, dict) and "input_format" in cursor:
        cursor_keys |= {"input_format", "preprocessing_version"}
        if cursor.get("input_format") != input_format or cursor.get("preprocessing_version") != cursor_version:
            raise ValueError("PAPER_ANALYSIS_INVALID: reading cursor belongs to another input format or preprocessing version")
    elif request.get("cursor") is not None and (input_format == "markdown" or include_images):
        raise ValueError("PAPER_ANALYSIS_INVALID: preprocessed reading cursor requires its input format and preprocessing version")
    if not isinstance(cursor, dict) or set(cursor) != cursor_keys or any(isinstance(cursor.get(k), bool) or not isinstance(cursor.get(k), int) or cursor[k] < 0 for k in ("index", "offset")):
        raise ValueError("PAPER_ANALYSIS_INVALID: invalid reading cursor")
    paper = library.get(request.get("id"))
    if not paper.get("pdf") or paper.get("archived"):
        raise ValueError("PAPER_ANALYSIS_INVALID: select an active paper with a PDF")
    path = library.pdf_path(paper["id"])
    version = file_version(path)
    if request.get("file_version") is not None and request["file_version"] != version:
        raise ValueError("PAPER_ANALYSIS_SOURCE_CHANGED: PDF changed between batches; saved results are retained")
    extracted, read, completed, blank = [], [], [], []
    no_text, image_only, empty_markdown, page_details = [], [], [], {}
    images, image_warnings = [], ["Page images are bounded to 1600 pixels on the long edge; small text and fine figure details may require local PDF inspection."]
    page_limit = preprocessing.MAX_IMAGES if include_images else MAX_PAGES
    characters = 0
    index, offset = cursor["index"], cursor["offset"]
    with library._open_pdf(path) as doc:
        pages = pages if pages is not None else list(range(1, doc.page_count + 1))
        if len(pages) > 2000 or any(p > doc.page_count for p in pages) or index >= len(pages):
            raise ValueError("PAPER_ANALYSIS_INVALID: selected PDF page or cursor does not exist")
        page_count = doc.page_count
        while index < len(pages) and len(read) < page_limit and len(extracted) < MAX_PAGES and characters < MAX_CHARACTERS:
            number = pages[index]
            if input_format == "markdown":
                prepared = preprocessing.prepare_page(library, paper["id"], doc, number, version)
                content = prepared["markdown"]
                page_details[number] = preprocessing.page_provenance(prepared)
                if not prepared["has_extractable_text"]:
                    no_text.append(number)
                    if prepared["has_images"]:
                        image_only.append(number)
                elif not content:
                    empty_markdown.append(number)
            else:
                if include_images:
                    raw, has_images = preprocessing.raw_page(doc, number)
                    content = raw.strip()
                else:
                    page = doc.load_page(number - 1)
                    content = page.get_text("text", sort=True).strip()
                    has_images = None
                if not content:
                    no_text.append(number)
                    if has_images:
                        image_only.append(number)
            if offset > len(content):
                raise ValueError("PAPER_ANALYSIS_INVALID: text cursor exceeds page length")
            read.append(number)
            if not content and input_format == "text" and not include_images:
                blank.append(number)
            while offset < len(content) and len(extracted) < MAX_PAGES and characters < MAX_CHARACTERS:
                end = min(len(content), offset + MAX_PAGE_CHARACTERS, offset + MAX_CHARACTERS - characters)
                excerpt = content[offset:end]
                if excerpt.strip():
                    extracted.append((number, offset, end, excerpt))
                characters += len(excerpt)
                offset = end
            if offset == len(content):
                completed.append(number)
                index, offset = index + 1, 0
            else:
                break
        if include_images:
            for number in read:
                images.append(preprocessing.page_image(library, paper["id"], doc, number, version))
                if images[-1]["reduced_for_byte_limit"]:
                    image_warnings.append(f"Page {number}: reduced resolution to fit the 1 MiB image limit")
    if file_version(path) != version:
        raise ValueError("PAPER_ANALYSIS_SOURCE_CHANGED: PDF changed during extraction")
    current = library.get(paper["id"])
    if current["modified"] != paper["modified"]:
        raise PaperConflictError(current)
    knowledge.setup(library)
    saved = []
    for number, start, end, excerpt in extracted:
        provenance = {"kind": "selected-pdf-page", "file_version": version,
                      "scope": "markdown-batch" if input_format == "markdown" else "text-batch",
                      "full_document": False, "character_start": start, "character_end": end,
                      "truncated": False, "extraction": "plain-text", "ocr": False}
        if input_format == "markdown":
            provenance.update(extraction="pymupdf4llm-markdown", representation="normalized-markdown",
                              raw_verbatim=False, exact_quote_basis="saved-source-text",
                              **preprocessing.engine(), **page_details[number])
        saved.append(knowledge.source_put(library, {
            "entity": {"kind": "paper", "id": paper["id"]}, "kind": "source-note", "text": excerpt,
            "title": f"PDF page {number} · {paper['title']}"[:500],
            "locator": {"page": number, "section": f"PDF {'normalized Markdown' if input_format == 'markdown' else 'text'} characters {start}–{end}"},
        }, trusted_provenance=provenance, preserve_text=input_format == "markdown" or include_images))
    next_cursor = {"index": index, "offset": offset} if index < len(pages) else None
    if next_cursor is not None and (input_format == "markdown" or include_images):
        next_cursor.update(input_format=input_format, preprocessing_version=cursor_version)
    result = {"paper": paper, "expected_modified": paper["modified"], "file_version": version,
            "input_format": input_format,
            "sources": saved, "source_ids": [s["id"] for s in saved],
            "next_cursor": next_cursor,
            "coverage": {"scope": "markdown-batch" if input_format == "markdown" else "text-batch", "selection": "explicit" if request.get("pages") else "all-pages",
                         "full_document": False, "requested_pages": pages, "read_pages": read,
                         "completed_pages": completed, "blank_pages": blank, "truncated_pages": [], "omitted_pages": [],
                         "no_extractable_text_pages": no_text, "image_only_pages": image_only,
                         "empty_markdown_pages": empty_markdown,
                         "characters": characters, "page_count": page_count}}
    if input_format == "markdown":
        result["preprocessing"] = {**preprocessing.engine(), "representation": "normalized-markdown",
                                   "raw_verbatim": False, "exact_quote_basis": "saved-source-text",
                                   "warnings": ["Markdown is a derived layout representation; quotes match saved Markdown, not literal PDF text.",
                                                "No OCR or full-document header detection; formulas, tables and layout may need visual verification."],
                                   "pages": [{"page": n, **detail} for n, detail in page_details.items()]}
    if include_images:
        result.update(images=images, visual_coverage={
            "requested": True, "rendered_pages": [image["page"] for image in images], "omitted_pages": [],
            "scaled_pages": [{"page": image["page"], "width": image["width"], "height": image["height"],
                              "scale": image["scale"]} for image in images], "warnings": image_warnings,
            "annotations_included": False, "ocr": False, "full_document": False,
            "max_pages": preprocessing.MAX_IMAGES, "max_edge": preprocessing.MAX_IMAGE_EDGE,
            "max_image_bytes": preprocessing.MAX_IMAGE_BYTES,
            "max_total_bytes": preprocessing.MAX_IMAGES * preprocessing.MAX_IMAGE_BYTES})
    return result


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
    if request.get("action") == "paper_analysis_batch":
        return batch(library, request)
    if request.get("action") == "paper_analysis_sources":
        return sources(library, request)
    if request.get("action") == "paper_analysis_apply_metadata":
        return apply_metadata(library, request)
    raise ValueError("PAPER_ANALYSIS_INVALID: unsupported analysis action")
