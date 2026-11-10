"""Bounded, read-only native markup geometry for one paper's reading strip.

This is a distribution of locatable root marks, not evidence that any page was
read or understood. ``other`` means nonmatching/unknown source, never proven
human. ``ai_style`` reuses the native blue-dashed style classifier and does not
prove authorship either. No annotation contents, PDF text, images, or rendering
are read. Each usable root mark contributes one unit at its displayed rect's
vertical midpoint; the frontend may smooth the fixed-size histograms.
"""
from __future__ import annotations

import math

from .ai_annotation_style import native_style

BIN_COUNT = 96
MAX_PAGES = 2000
MAX_ANNOTATIONS = 20000
# PDF native Highlight, Underline, Squiggly and StrikeOut. Replies and other
# shapes (including AI-reading rectangles and notes) are deliberately excluded.
MARK_TYPES = {8, 9, 10, 11}


def _response():
    def group():
        return {"bins": [0] * BIN_COUNT, "annotation_count": None, "marked_pages": None}
    return {"status": "unknown", "reason": None, "reasons": [],
            "page_count": None, "bin_count": BIN_COUNT,
            "other": group(), "ai_style": group(),
            "total_marks": None, "marked_pages": None,
            "coverage": {"scanned_pages": 0, "visited_pages": 0,
                         "scanned_annotations": 0, "skipped_marks": 0},
            "limits": {"pages": MAX_PAGES, "annotations": MAX_ANNOTATIONS, "bins": BIN_COUNT}}


def _reason(result, reason):
    if reason not in result["reasons"]:
        result["reasons"].append(reason)
    result["reason"] = result["reasons"][0]


def _unknown(reason):
    result = _response()
    _reason(result, reason)
    return result


def _fingerprint(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def _position(page, annot):
    """Return the visible midpoint in native displayed-page coordinates.

    Annot.rect is unrotated in PyMuPDF. Apply the actual page rotation before
    normalization, and clip to that page's own crop/size, not a nominal A4 page.
    No vertex list is materialized; even a huge multi-line mark costs one rect.
    """
    bounds = page.rect
    rect = annot.rect * page.rotation_matrix
    if (not all(math.isfinite(v) for v in (*bounds, *rect))
            or bounds.is_empty or bounds.is_infinite or rect.is_empty or rect.is_infinite):
        raise ValueError("Invalid mark geometry")
    visible = rect & bounds
    if visible.is_empty:
        raise ValueError("Mark is outside the visible page")
    return ((visible.y0 + visible.y1) / 2 - bounds.y0) / bounds.height


def _scan(doc):
    result = _response()
    page_count = doc.page_count
    result["page_count"] = page_count
    if page_count <= 0:
        _reason(result, "empty_pdf")
        return result
    groups = {"other": set(), "ai_style": set()}
    for name in groups:
        result[name]["annotation_count"] = 0
        result[name]["marked_pages"] = 0
    result["total_marks"] = result["marked_pages"] = 0
    coverage = result["coverage"]
    if doc.is_repaired:
        _reason(result, "repaired_pdf")
    if page_count > MAX_PAGES:
        _reason(result, "page_limit")
    stopped = False
    for number in range(min(page_count, MAX_PAGES)):
        coverage["visited_pages"] += 1
        try:
            page = doc[number]
            # Page.annots() first allocates the complete annotation-xref list.
            # Traverse the native chain instead, with at most one lookahead.
            annot = page.first_annot
            seen = set()
            broken_chain = False
            while annot is not None:
                if coverage["scanned_annotations"] >= MAX_ANNOTATIONS:
                    _reason(result, "annotation_limit")
                    stopped = True
                    break
                xref = annot.xref
                if xref in seen:
                    # A malformed native chain must not count the same mark
                    # repeatedly, even though the overall budget also bounds it.
                    coverage["skipped_marks"] += 1
                    _reason(result, "invalid_annotation")
                    broken_chain = True
                    break
                seen.add(xref)
                coverage["scanned_annotations"] += 1
                try:
                    # Any non-null /IRT is a reply, even if malformed/dangling.
                    # Content/author/subject are neither read nor classifiers.
                    if (annot.type[0] in MARK_TYPES
                            and doc.xref_get_key(annot.xref, "IRT")[0] == "null"):
                        position = _position(page, annot)
                        index = min(BIN_COUNT - 1, max(0, int((number + position) / page_count * BIN_COUNT)))
                        try:
                            name = "ai_style" if native_style(annot)["ai_reading_style"] else "other"
                        except Exception:
                            name = "other"
                            _reason(result, "style_unavailable")
                        result[name]["bins"][index] += 1
                        result[name]["annotation_count"] += 1
                        groups[name].add(number)
                except Exception:
                    coverage["skipped_marks"] += 1
                    _reason(result, "invalid_annotation")
                annot = annot.next
            if stopped:
                break
            if not broken_chain:
                coverage["scanned_pages"] += 1
        except Exception:
            # A broken page/chain never becomes a measured zero-mark page.
            _reason(result, "page_read_error")
    for name, pages in groups.items():
        result[name]["marked_pages"] = len(pages)
    result["total_marks"] = sum(result[name]["annotation_count"] for name in groups)
    result["marked_pages"] = len(groups["other"] | groups["ai_style"])
    result["status"] = "partial" if result["reasons"] else "ready"
    return result


def read_distribution(library, id):
    """Read one requested PDF, preserving files and all external annotations.

    Ready zero counts mean an inspected PDF contains no eligible root marks.
    Unknown counts are null. Partial counts/bins are observed lower bounds, not
    a complete reading percentage. Missing/archived IDs still follow Library's
    normal validation. No cache, catalog rows, or persistent files are written.
    """
    item = library.get(id)
    if not item.get("pdf"):
        return _unknown("no_pdf")
    try:
        path = library.pdf_path(id)
        before = _fingerprint(path)
    except (OSError, ValueError):
        return _unknown("pdf_unavailable")
    try:
        with library._open_pdf(path) as doc:
            result = _scan(doc)
    except ValueError as error:
        # Preserve the existing opener's page/encryption guards. An oversized
        # document is unknown rather than claiming the first pages are empty.
        message = str(error)
        reason = ("page_limit" if "2000-page limit" in message else
                  "unsupported_pdf" if "Encrypted or non-PDF" in message else "invalid_pdf")
        return _unknown(reason)
    except Exception:
        return _unknown("pdf_unavailable")
    try:
        if before != _fingerprint(path):
            return _unknown("pdf_changed")
    except OSError:
        return _unknown("pdf_changed")
    return result
