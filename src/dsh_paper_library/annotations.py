"""Annotation access for managed PDFs.

Annotations are read back from the PDF itself — there is no catalog table for them — so this mixin
is where the native object model becomes the shapes the reader and the agent consume. Writes go
through `PdfWrites`; the caps (`MAX_ANNOTATIONS` and the reference budgets) stay in `core.py`,
because the host validates against the same numbers.

Those caps are read through the `core` module at call time rather than imported by value: the suite
patches `dsh_paper_library.core.MAX_ANNOTATIONS` to prove the limit holds, and a copy taken at
import time would ignore the patch.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
from itertools import islice
import json
import math
import re
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from .handwriting import HandwritingAccess

READER_MAX_SCALE = 8.0
READER_MAX_PIXELS = 16_000_000
READER_MAX_SIDE = 8192
READER_MAX_PNG_BYTES = 16 * 1024 * 1024
READER_MAX_INTERNAL_LINKS = 1000
from .linked_handwriting import LinkedHandwritingAccess, LINKED_KINDS

def _constants():
    """The cap table from `core.py`, resolved when a method runs.

    A module-scope import is impossible (core imports this module to build `Library`) and reading
    the values once at import time would ignore the suite's `monkeypatch.setattr` of
    `dsh_paper_library.core.MAX_ANNOTATIONS`, so both the module and the values are looked up late.
    """
    import importlib
    return importlib.import_module("dsh_paper_library.core")

# Bound by `core.py` after import, like the other mixins: plain helpers that also belong to the rest
# of the library. The cap constants are deliberately *not* bound; `_constants()` reads them live.
safe_name = None

# A single pen session is finite; long handwriting is saved in several native
# annotations by the reader. These limits also bound external Ink projections.
MAX_INK_STROKES = 64
MAX_INK_POINTS = 4096
MAX_INK_BYTES = 128 * 1024


def install_helpers(**helpers):
    module = globals()
    for name, value in helpers.items():
        if name not in module:
            raise AttributeError(f"annotations does not use a helper named {name!r}")
        module[name] = value


class AnnotationAccess(HandwritingAccess, LinkedHandwritingAccess):
    @staticmethod
    def _readable_underline(doc, annot):
        """同步标准线型外观，并加粗本插件下划线；保留原生几何与文字范围。"""
        if annot.type[0] not in {9, 11, 4, 15}:
            return
        # MuPDF does not accept set_border for text markup. Its generated
        # underline appearance uses a font-height-dependent `w` operator;
        # adjust that operator in the standard /AP/N stream instead.
        kind, value = doc.xref_get_key(annot.xref, "AP/N")
        if kind != "xref":
            return
        appearance = int(value.split()[0])
        stream = doc.xref_stream(appearance)
        def width(match):
            current = float(match[1])
            return f"{max(current, min(3.0, max(1.6, current * 1.8))):.4f} w".encode("ascii")
        updated = stream
        if annot.type[0] == 9 and annot.info.get("subject", "").startswith("paper-library:"):
            updated = re.sub(rb"(?m)(?<!\S)(\d*\.?\d+)\s+w(?=\s|$)", width, updated)
        dashes = AnnotationAccess._style_border(annot).get("dashes") or []
        if dashes:
            command = ("[" + " ".join(str(float(v)) for v in dashes) + "] 0 d\n").encode("ascii")
            updated = re.sub(rb"\[[^\]]*\]\s+[\d.]+\s+d\b", b"", updated)
            updated = command + updated
        if updated != stream:
            doc.update_stream(appearance, updated)

    @staticmethod
    def _ink_paths(paths, page):
        import pymupdf as fitz
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_INK_STROKES:
            raise ValueError(f"Ink requires 1–{MAX_INK_STROKES} strokes")
        if any(not isinstance(stroke, list) or len(stroke) < 2 for stroke in paths):
            raise ValueError("Each ink stroke requires at least two points")
        if sum(len(stroke) for stroke in paths) > MAX_INK_POINTS:
            raise ValueError(f"Ink exceeds {MAX_INK_POINTS} points")
        result = []
        for stroke in paths:
            points = []
            for point in stroke:
                if not isinstance(point, (list, tuple)) or len(point) != 2 or not all(
                    isinstance(value, (int, float)) and not isinstance(value, bool) and (isinstance(value, int) or math.isfinite(value))
                    for value in point
                ):
                    raise ValueError("Ink points require two finite numeric coordinates")
                x, y = point
                if not (0 <= x <= page.rect.width and 0 <= y <= page.rect.height):
                    raise ValueError("Ink points must be inside displayed page")
                points.append(list(fitz.Point(x, y) * page.derotation_matrix))
            result.append(points)
        if len(json.dumps(paths, separators=(",", ":"), allow_nan=False).encode("utf-8")) > MAX_INK_BYTES:
            raise ValueError("Ink paths exceed 128 KiB")
        return result

    @staticmethod
    def _ink_geometry(page, annot):
        import pymupdf as fitz
        # PyMuPDF decodes vertices before Python can inspect their size. Avoid
        # additional copies / response expansion for oversized external objects;
        # their original geometry remains intact in the PDF and rendered page.
        vertices = annot.vertices or []
        width = annot.border.get("width", 1)
        if len(vertices) > MAX_INK_STROKES or sum(len(stroke) for stroke in vertices) > MAX_INK_POINTS:
            return {"paths": [], "width": width, "geometry_truncated": True}
        paths = [[list(fitz.Point(point) * page.rotation_matrix) for point in stroke] for stroke in vertices]
        if not all(math.isfinite(value) for stroke in paths for point in stroke for value in point) or len(json.dumps(paths, separators=(",", ":")).encode("utf-8")) > MAX_INK_BYTES:
            return {"paths": [], "width": width, "geometry_truncated": True}
        return {"paths": paths, "width": width}

    @staticmethod
    def _annotation_characters(value):
        return len(value["text"]) + len(value["comment"]) + len(value.get("subject", "")) + (len(json.dumps(value["paths"], separators=(",", ":"))) if "paths" in value else 0) + (len(json.dumps(value["handwriting"], ensure_ascii=False)) if "handwriting" in value else 0) + (len(json.dumps(value["linked_ink"], ensure_ascii=False)) if "linked_ink" in value else 0)

    @staticmethod
    def _page(doc, number):
        number = int(number)
        if number < 1 or number > doc.page_count:
            raise ValueError("Page number outside document (pages are one-based)")
        return doc[number - 1]

    @staticmethod
    def _rect(rect, page, inverse=False):
        import pymupdf as fitz
        if len(rect) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in rect):
            raise ValueError("Rectangle must have four finite PDF-point coordinates")
        result = fitz.Rect(rect)
        if result.is_empty or result.is_infinite:
            raise ValueError("Rectangle must have positive area")
        if inverse:
            if not page.rect.contains(result):
                raise ValueError("Annotation rectangle must be inside displayed page")
            result = result * page.derotation_matrix
        else:
            result = result * page.rotation_matrix
        return result

    @staticmethod
    def _annotation_metadata(annot):
        subject = annot.info.get("subject", "")
        # Explicit external AI declaration plus native reply identity. Author
        # names/prose alone never classify a human's note as generated content.
        if subject == "AI 伴学回复" and annot.irt_xref:
            return {"kind": "ai-feedback", "source_kind": "external-companion"}
        if subject.startswith("paper-library:") and len(subject) < 100000:
            try:
                extra = json.loads(subject[len("paper-library:"):])
                return extra if isinstance(extra, dict) else {}
            except ValueError:
                pass
        return {}

    @classmethod
    def _annotation(cls, page, annot, exact=False, handwriting=None, raw_words=None):
        import pymupdf as fitz
        info = annot.info
        extra = cls._annotation_metadata(annot)
        handwriting = cls._handwriting_page(page) if handwriting is None else handwriting
        linked_board = handwriting["parents"].get(annot.xref)
        own_board = handwriting["children"].get(annot.xref)
        linked_ink = handwriting["linked_parents"].get(annot.xref)
        linked_child = handwriting["linked_children"].get(annot.xref)
        rects = []
        vertices = annot.vertices if annot.type[0] in {8, 9, 10, 11} else None
        if vertices:
            for index in range(0, len(vertices), 4):
                quad = fitz.Quad(vertices[index:index + 4])
                rects.append(list(cls._rect(quad.rect, page)))
        if not rects:
            rects = [list(cls._rect(annot.rect, page))]
        kind = "highlight" if annot.type[0] == 8 else "note" if annot.type[0] == 0 else annot.type[1].lower()
        text = extra.get("text", "")
        if not text and kind in {"highlight", "underline", "strikeout", "squiggly"}:
            words = page.get_text("words") if raw_words is None else raw_words
            unrotated = [fitz.Rect(r) * page.derotation_matrix for r in rects]
            text = " ".join(word[4] for word in words if any(fitz.Rect(word[:4]).intersects(rect) for rect in unrotated))
            if not exact:
                text = text[:20000]
        reply_to = None
        if annot.irt_xref:
            try:
                parent = page.load_annot(annot.irt_xref)
                reply_to = parent.info.get("id") or f"external-{page.number + 1}-{parent.xref}"
            except (ValueError, RuntimeError):
                pass
        # 人工后续备注沿用原划线的选文与来源范围，但自身仍是原生 Text /IRT。
        source_rects = extra.get("source_rects") if extra.get("kind") == "reader-reply" or kind == "note" else None
        if isinstance(source_rects, list) and 0 < len(source_rects) <= 200:
            try:
                rects = [list(cls._rect(rect, page, inverse=True) * page.rotation_matrix) for rect in source_rects]
            except (TypeError, ValueError):
                pass
        return {"id": info.get("id") or f"external-{page.number + 1}-{annot.xref}", "page": page.number + 1, "type": kind, "text": text, "comment": info.get("content", ""), "author": info.get("title", ""), "subject": info.get("subject", "")[:1000] if not info.get("subject", "").startswith("paper-library:") else "", "rect": list(cls._rect(annot.rect, page)), "rects": rects, "created": info.get("creationDate"), "modified": info.get("modDate"), "color": annot.colors, **cls._annotation_style(annot), "source": "paper-library" if extra and extra.get("source_kind") != "external-companion" else "external-pdf", **(cls._ink_geometry(page, annot) if kind == "ink" else {}), **({"width": annot.border.get("width", 1)} if kind == "square" else {}), **({"handwriting": linked_board} if linked_board else {}), **({"linked_ink": linked_ink} if linked_ink else {}), **(linked_child or {}), **({"parent_id": own_board["parent_id"], "transcript": own_board["transcript"], "transcription_source": own_board["transcription_source"], "handwriting_version": own_board["version"]} if own_board else {}), **({"reply_to": reply_to} if reply_to else {}), **{key: extra[key] for key in ("kind", "model", "annotation_ids", "generated", "source_kind", "source_session_id", "source_message_id", "source_snapshot_ids", "parent_id", "question", "answered_at") if key in extra}}

    def companion_excerpt(self, id, page):
        """One explicitly selected page, text only; no persistent index or OCR."""
        with self._open_pdf(self.pdf_path(id)) as doc:
            text = self._page(doc, page).get_text("text", sort=True).strip()
            return {"page": int(page), "text": text[:7000], "truncated": len(text) > 7000}

    @staticmethod
    def _reference_annotation(value, identity_reliable):
        """Version semantic PDF content, not file hashes or reader timestamps.

        Geometry is normalized to a millipoint so lossless PDF serialization
        roundoff does not mark every annotation as edited. No source text is
        shortened here: preview limits belong only to the catalogue projection.
        """
        # PyMuPDF must decode an object's strings before their lengths are
        # available. Bound further normalization/hash copies of external data;
        # this is not a guarantee against arbitrary PDF decompression costs.
        if len(value["text"]) + len(value["comment"]) > _constants().REFERENCE_ANNOTATION_BYTES or len(value["text"].encode("utf-8")) + len(value["comment"].encode("utf-8")) > _constants().REFERENCE_ANNOTATION_BYTES:
            raise ValueError("ANNOTATION_TEXT_LIMIT: a PDF annotation exceeds the 2 MiB parsing budget; reduce that annotation in a PDF reader before refreshing")
        def text(value):
            return unicodedata.normalize("NFC", str(value or "").replace("\r\n", "\n").replace("\r", "\n"))
        normalized = {"page": value["page"], "type": value["type"],
                      "text": text(value["text"]), "comment": text(value["comment"]),
                      "rects": [[round(float(v), 3) for v in rect] for rect in value["rects"]]}
        if value["type"] == "square":
            normalized.update(width=round(float(value["width"]), 3), color=value.get("color"))
        if value["type"] == "ink":
            if value.get("geometry_truncated"):
                raise ValueError("ANNOTATION_GEOMETRY_LIMIT: an ink annotation exceeds the bounded geometry budget; split it in a PDF editor before referencing")
            normalized.update(paths=[[[round(float(v), 3) for v in point] for point in stroke] for stroke in value["paths"]],
                              width=round(float(value["width"]), 3), color=value.get("color"))
        if value.get("handwriting"):
            normalized["handwriting"] = value["handwriting"]
        if value.get("linked_ink"):
            if value["linked_ink"].get("truncated"):
                raise ValueError("ANNOTATION_GEOMETRY_LIMIT: linked handwriting exceeds the bounded geometry budget")
            normalized["linked_ink"] = {key: entry for key, entry in value["linked_ink"].items() if key != "annotations"}
        if value.get("handwriting_version"):
            normalized["handwriting_version"] = value["handwriting_version"]
        version = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {**value, "version": version, "identity_reliable": identity_reliable,
                "identity_source": "pdf-nm" if identity_reliable else "page-xref",
                "text_characters": len(value["text"]), "comment_characters": len(value["comment"]),
                "source_characters": len(value["text"]) + len(value["comment"]) + len(value.get("handwriting", {}).get("transcript", "")) + len(value.get("linked_ink", {}).get("transcript", ""))}

    @staticmethod
    def _reference_limits(max_characters=None):
        # `None` rather than the constant as a default: a default is evaluated at import time, which
        # would freeze the budget before anything could change it.
        if max_characters is None:
            max_characters = _constants().REFERENCE_SOURCE_CHARACTERS
        return {"annotations": _constants().REFERENCE_CATALOG_LIMIT, "source_characters": max_characters,
                "selection_characters": 8000, "preview_characters": _constants().REFERENCE_PREVIEW_CHARACTERS,
                "scanned_annotations": _constants().REFERENCE_SCAN_LIMIT, "annotation_bytes": _constants().REFERENCE_ANNOTATION_BYTES}

    def annotation_catalog(self, id, annotation_id=None):
        """Bounded current-paper metadata for selection; never a resident index."""
        if annotation_id is not None and (not isinstance(annotation_id, str) or not 1 <= len(annotation_id) <= 160 or re.search(r"[\x00-\x1f]", annotation_id)):
            raise ValueError("Annotation identity is invalid")
        item = self.get(id)
        values, seen, duplicate_ids = [], set(), set()
        total, scanned, characters, total_exact = 0, 0, 0, True
        if item["pdf"]:
            with self._open_pdf(self.pdf_path(id)) as doc:
                stop = False
                for page in doc:
                    handwriting = self._handwriting_page(page) if annotation_id is None else None
                    for annot in page.annots() or []:
                        if scanned >= _constants().REFERENCE_SCAN_LIMIT:
                            total_exact, stop = False, True
                            break
                        scanned += 1
                        if annotation_id is not None:
                            if (annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}") != annotation_id:
                                continue
                            if annotation_id in seen:
                                duplicate_ids.add(annotation_id)
                            seen.add(annotation_id)
                        if self._annotation_metadata(annot).get("kind") in {"ai-feedback", "handwriting-note"} | LINKED_KINDS:
                            continue
                        total += 1
                        if handwriting is None:
                            handwriting = self._handwriting_page(page)
                        value = self._reference_annotation(self._annotation(page, annot, exact=True, handwriting=handwriting), bool(annot.info.get("id")))
                        characters += value["source_characters"]
                        if annotation_id is None:
                            if value["id"] in seen:
                                duplicate_ids.add(value["id"])
                            seen.add(value["id"])
                        if len(values) < _constants().REFERENCE_CATALOG_LIMIT:
                            projected = {key: value[key] for key in ("id", "version", "page", "type", "source", "identity_reliable", "identity_source", "text_characters", "comment_characters", "source_characters")}
                            projected.update({key: value[key][:_constants().REFERENCE_PREVIEW_CHARACTERS] for key in ("text", "comment")})
                            projected["preview_truncated"] = any(len(value[key]) > _constants().REFERENCE_PREVIEW_CHARACTERS for key in ("text", "comment"))
                            if value.get("handwriting"):
                                projected["handwriting"] = {**value["handwriting"], "transcript": value["handwriting"]["transcript"][:_constants().REFERENCE_PREVIEW_CHARACTERS]}
                                projected["preview_truncated"] |= len(value["handwriting"]["transcript"]) > _constants().REFERENCE_PREVIEW_CHARACTERS
                            if value.get("linked_ink"):
                                projected["linked_ink"] = {key: entry for key, entry in value["linked_ink"].items() if key != "annotations"}
                                projected["linked_ink"]["transcript"] = value["linked_ink"]["transcript"][:_constants().REFERENCE_PREVIEW_CHARACTERS]
                                projected["preview_truncated"] |= len(value["linked_ink"]["transcript"]) > _constants().REFERENCE_PREVIEW_CHARACTERS
                            values.append(projected)
                    if stop:
                        break
        for value in values:
            if value["id"] in duplicate_ids:
                value.update(identity_reliable=False, identity_source="duplicate-pdf-nm")
            elif annotation_id is not None and not total_exact:
                value.update(identity_reliable=False, identity_source="incomplete-pdf-scan")
        return {"annotations": values, "total": total, "returned": len(values),
                "total_exact": total_exact, "truncated": not total_exact or total > len(values),
                "source_characters": characters, "source_characters_exact": total_exact,
                "ambiguous_ids": sorted(duplicate_ids)[:_constants().REFERENCE_CATALOG_LIMIT], "limits": self._reference_limits()}

    def annotation_context_exact(self, id, annotation_refs, selection=None, max_characters=None):
        """Freeze complete selected versions or fail; never silently omit text."""
        # `None` resolves here rather than in the signature: a default is evaluated at import time,
        # which would freeze the budget before the host could set it.
        if max_characters is None:
            max_characters = _constants().REFERENCE_SOURCE_CHARACTERS
        if not isinstance(annotation_refs, list) or len(annotation_refs) > _constants().REFERENCE_CATALOG_LIMIT:
            raise ValueError(f"Choose at most {_constants().REFERENCE_CATALOG_LIMIT} annotation references")
        if isinstance(max_characters, bool) or not isinstance(max_characters, int) or not 1 <= max_characters <= _constants().REFERENCE_MAX_CHARACTERS:
            raise ValueError(f"Source character budget must be 1–{_constants().REFERENCE_MAX_CHARACTERS}")
        requested = {}
        for ref in annotation_refs:
            if not isinstance(ref, dict) or not isinstance(ref.get("id"), str) or not 1 <= len(ref["id"]) <= 160 or re.search(r"[\x00-\x1f]", ref["id"]) or not isinstance(ref.get("version"), str) or not re.fullmatch(r"[0-9a-f]{64}", ref["version"]):
                raise ValueError("Annotation reference requires an ID and SHA-256 content version")
            if ref["id"] in requested:
                raise ValueError("Duplicate annotation references are not allowed")
            requested[ref["id"]] = ref["version"]
        item = self.get(id)
        if selection is not None:
            if not isinstance(selection, dict) or isinstance(selection.get("page"), bool) or not isinstance(selection.get("page"), int) or selection["page"] < 1 or not isinstance(selection.get("text"), str) or not selection["text"].strip() or len(selection["text"]) > 8000:
                raise ValueError("Selection requires a PDF page and 1–8000 text characters")
            selection = {"page": selection["page"], "text": selection["text"]}
        if not item["pdf"] and (requested or selection is not None):
            raise ValueError("This paper has no PDF for annotation references")
        found, stale, seen = {}, [], set()
        total, scanned, total_exact = 0, 0, True
        characters = len(selection["text"]) if selection else 0
        geometry_characters = 0
        if item["pdf"]:
            with self._open_pdf(self.pdf_path(id)) as doc:
                if selection and selection["page"] > doc.page_count:
                    raise ValueError("Selection page is outside the current PDF")
                stop = False
                for page in doc:
                    handwriting = self._handwriting_page(page)
                    for annot in page.annots() or []:
                        if scanned >= _constants().REFERENCE_SCAN_LIMIT:
                            total_exact, stop = False, True
                            break
                        scanned += 1
                        annotation_id = annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}"
                        if annotation_id in requested:
                            if annotation_id in seen:
                                raise ValueError("ANNOTATION_AMBIGUOUS: selected PDF annotation identity occurs more than once")
                            seen.add(annotation_id)
                        if self._annotation_metadata(annot).get("kind") in {"ai-feedback", "handwriting-note"} | LINKED_KINDS:
                            continue
                        total += 1
                        if annotation_id not in requested:
                            continue
                        raw_value = self._annotation(page, annot, exact=True, handwriting=handwriting)
                        if raw_value.get("linked_ink"):
                            geometry_characters += len(json.dumps(raw_value["linked_ink"]["annotations"], separators=(",", ":")))
                            if geometry_characters > 2_000_000:
                                raise ValueError("SOURCE_GEOMETRY_BUDGET_EXCEEDED: selected handwriting exceeds the 2 MB geometry budget")
                        if "paths" in raw_value:
                            geometry_characters += len(json.dumps(raw_value["paths"], separators=(",", ":")))
                            if geometry_characters > 2_000_000:
                                raise ValueError("SOURCE_GEOMETRY_BUDGET_EXCEEDED: selected ink exceeds the 2 MB geometry budget; reduce the selection")
                        if characters + len(raw_value["text"]) + len(raw_value["comment"]) + len(raw_value.get("handwriting", {}).get("transcript", "")) + len(raw_value.get("linked_ink", {}).get("transcript", "")) > max_characters:
                            raise ValueError(f"SOURCE_BUDGET_EXCEEDED: selected source exceeds {max_characters} characters; reduce the selection (no text was sent)")
                        value = self._reference_annotation(raw_value, bool(annot.info.get("id")))
                        if value["version"] != requested[annotation_id]:
                            stale.append(annotation_id)
                        characters += value["source_characters"]
                        if characters > max_characters:
                            raise ValueError(f"SOURCE_BUDGET_EXCEEDED: selected source exceeds {max_characters} characters; reduce the selection (no text was sent)")
                        found[annotation_id] = value
                    if stop:
                        break
        if not total_exact:
            raise ValueError("ANNOTATION_SCAN_LIMIT: PDF exceeds the bounded annotation scan; refresh a smaller document")
        missing = sorted(set(requested) - set(found))
        if missing:
            raise ValueError("ANNOTATION_MISSING: selected source annotations no longer exist or are AI feedback; refresh before sending: " + ", ".join(missing[:5]))
        if stale:
            raise ValueError("ANNOTATION_STALE: selected annotations changed; review and adopt current versions before sending: " + ", ".join(stale[:5]))
        if characters > max_characters:
            raise ValueError(f"SOURCE_BUDGET_EXCEEDED: selected source exceeds {max_characters} characters; reduce the selection (no text was sent)")
        annotations = [found[ref["id"]] for ref in annotation_refs]
        content = {"annotation_refs": annotation_refs, "annotations": annotations, "selection": selection}
        context_hash = hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {"item": item, **content, "source_characters": characters, "context_hash": context_hash,
                "coverage": {"requested": len(requested), "included": len(annotations), "total": total, "total_exact": total_exact, "all": len(annotations) == total},
                "limits": self._reference_limits(max_characters)}

    def _with_annotation_version(self, value, identity_reliable):
        # 编辑需要完整内容版本，即使备注已超过 AI 引用的 8000 字符预算。
        # 继续沿用有界完整哈希；无法完整解析时不提供可用于覆盖的版本。
        try:
            value["edit_version"] = self._reference_annotation(value, identity_reliable)["version"]
            if self._annotation_characters(value) <= 8000 and value.get("kind") != "ai-feedback":
                value["version"] = value["edit_version"]
        except ValueError:
            value["edit_unavailable"] = "批注内容或几何超过完整编辑范围"
            value["translation_unavailable"] = "批注内容或几何超过完整引用范围"
        return value

    def annotations(self, id):
        from .annotation_favorites import ids
        favorites = ids(self, id)
        result, characters = [], 0
        with self._open_pdf(self.pdf_path(id)) as doc:
            for page in doc:
                handwriting = self._handwriting_page(page)
                for annot in page.annots() or []:
                    if len(result) >= _constants().MAX_ANNOTATIONS:
                        return {"annotations": result, "truncated": True, "favorites": favorites}
                    value = self._annotation(page, annot, handwriting=handwriting)
                    value = self._with_annotation_version(value, bool(annot.info.get("id")))
                    characters += self._annotation_characters(value)
                    if characters > 2_000_000:
                        return {"annotations": result, "truncated": True, "favorites": favorites}
                    result.append(value)
        return {"annotations": result, "truncated": False, "favorites": favorites}

    @staticmethod
    def _document_layout(doc, id):
        pages = []
        for page in doc:
            width, height = page.rect.width, page.rect.height
            if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                raise ValueError(f"Invalid dimensions on PDF page {page.number + 1}")
            pages.append({"page": page.number + 1, "width": width, "height": height, "rotation": page.rotation})
        return {"id": id, "page_count": doc.page_count, "pages": pages,
                "coordinate_system": "displayed-pdf-points", "rotation_applied": True,
                "truncated": False, "limits": {"pages": 2000}}

    def page_layout(self, id):
        """Page-tree geometry only; no page pixels, text, images or annotations.

        The worker retains at most 2,000 small geometry records and closes the
        PDF before returning. Coordinates share page()'s displayed point space.
        """
        with self._open_pdf(self.pdf_path(id)) as doc:
            # _open_pdf rejects larger files before touching individual pages.
            return self._document_layout(doc, id)

    @staticmethod
    def _page_internal_links(doc, page):
        """读取有界的原生内页链接；不返回或执行外部 URI、文件或脚本。"""
        import pymupdf as fitz
        links = []
        link = page.first_link
        inspected = 0
        while link is not None and inspected < READER_MAX_INTERNAL_LINKS:
            inspected += 1
            try:
                if not link.is_external and link.dest.kind in {fitz.LINK_GOTO, fitz.LINK_NAMED}:
                    target_page, x, y = doc.resolve_link(link.uri)
                    rect = link.rect
                    if (isinstance(target_page, int) and 0 <= target_page < doc.page_count
                            and all(math.isfinite(value) for value in (*rect, x, y))):
                        # Link.rect / resolve_link 已是旋转、裁剪后的显示坐标，
                        # 不可再次应用 word/annotation 使用的 rotation_matrix。
                        rect = rect & page.rect
                        if not rect.is_empty and not rect.is_infinite:
                            target_rect = doc[target_page].rect
                            links.append({"rect": list(rect), "page": target_page + 1,
                                          "to": [max(0.0, min(target_rect.width, x)),
                                                 max(0.0, min(target_rect.height, y))]})
            except (ValueError, RuntimeError, TypeError, OverflowError):
                # 损坏或无法解析的单条链接不能阻止页面阅读。
                pass
            link = link.next
        return links, link is not None

    def annotation_preview(self, id, annotation_id, page, render_width=480):
        """只读渲染单个原生矩形内的正文；不提词、不改 PDF、不包含遮挡批注。"""
        import pymupdf as fitz
        if not isinstance(annotation_id, str) or not 1 <= len(annotation_id) <= 160:
            raise ValueError("Invalid annotation identifier")
        if isinstance(render_width, bool) or not isinstance(render_width, (int, float)) or not math.isfinite(render_width) or not 64 <= render_width <= 640:
            raise ValueError("Preview width must be between 64 and 640 pixels")
        with self._open_pdf(self.pdf_path(id)) as doc:
            current = self._page(doc, page)
            found = []
            for count, annot in enumerate(current.annots() or []):
                if count >= _constants().MAX_ANNOTATIONS:
                    raise ValueError("Preview exceeds the bounded page annotation scan")
                if (annot.info.get("id") or f"external-{page}-{annot.xref}") == annotation_id:
                    if annot.type[0] != fitz.PDF_ANNOT_SQUARE:
                        raise ValueError("Only rectangle annotations have a region preview")
                    found.append(fitz.Rect(annot.rect) * current.rotation_matrix)
            if len(found) != 1:
                raise ValueError("Rectangle annotation missing or ambiguous; refresh annotations")
            rect = found[0] & current.rect
            if rect.is_empty or rect.is_infinite:
                raise ValueError("Rectangle lies outside the PDF page")
            scale = min(render_width / rect.width, 4, 640 / max(rect.width, rect.height), math.sqrt(300000 / (rect.width * rect.height)))
            for attempt in range(4):
                pix = current.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, colorspace=fitz.csRGB, alpha=False, annots=False)
                if pix.width * pix.height > 303000 or max(pix.width, pix.height) > 642:
                    raise ValueError("Region preview exceeds the pixel budget")
                image = pix.tobytes("png")
                if len(image) <= 1024 * 1024:
                    break
                scale *= .65
            else:
                raise ValueError("Region preview exceeds the image byte budget")
            # 视觉来源只包含几何与实际裁图；备注输入、笔色及无关批注不使描述失效。
            source_version = hashlib.sha256(json.dumps([[round(v, 3) for v in found[0]], [round(v, 3) for v in rect], hashlib.sha256(image).hexdigest()], separators=(",", ":")).encode()).hexdigest()
            return {"annotation_id": annotation_id, "page": int(page), "rect": list(rect), "width": pix.width, "height": pix.height, "source_version": source_version, "mime_type": "image/png", "image": base64.b64encode(image).decode("ascii")}

    def page(self, id, page=1, scale=1.25, include_layout=False, render_width=None):
        import pymupdf as fitz
        if not isinstance(include_layout, bool):
            raise ValueError("include_layout must be a boolean")
        if render_width is not None:
            render_width = float(render_width)
            if not math.isfinite(render_width) or render_width <= 0 or render_width > 32000:
                raise ValueError("Render width must be positive and at most 32000 pixels")
        scale = float(scale)
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError("Render scale must be positive and finite")
        with self._open_pdf(self.pdf_path(id)) as doc:
            # First-open geometry and its selected raster share one short-lived
            # worker/document. Only the explicitly selected page is extracted.
            layout = self._document_layout(doc, id) if include_layout else None
            if include_layout:
                page = max(1, min(doc.page_count, int(page)))
            current = self._page(doc, page)
            width, height = current.rect.width, current.rect.height
            if width <= 0 or height <= 0:
                raise ValueError("Invalid page dimensions")
            if render_width is not None:
                scale = render_width / width
            requested_scale = scale
            scale = min(scale, READER_MAX_SCALE, math.sqrt(READER_MAX_PIXELS / (width * height)), READER_MAX_SIDE / width, READER_MAX_SIDE / height)
            # A fractional page edge rounds upwards in the raster. Keep the
            # allocation bounded after rounding, before asking the PDF engine.
            while math.ceil(width * scale) * math.ceil(height * scale) > READER_MAX_PIXELS or max(math.ceil(width * scale), math.ceil(height * scale)) > READER_MAX_SIDE:
                scale *= .999
            byte_limited = False
            for attempt in range(4):
                pix = current.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                if pix.width * pix.height > READER_MAX_PIXELS or max(pix.width, pix.height) > READER_MAX_SIDE:
                    raise ValueError("PDF raster exceeds the reading pixel budget")
                image = pix.tobytes("png")
                if len(image) <= READER_MAX_PNG_BYTES:
                    break
                byte_limited = True
                scale *= min(.85, math.sqrt(READER_MAX_PNG_BYTES / len(image)) * .95)
                if min(width, height) * scale < 1:
                    raise ValueError("页面图像超过传输上限，请降低缩放后重试。")
            else:
                raise ValueError("页面图像超过传输上限，请降低缩放后重试。")
            words = []
            raw_words = current.get_text("words")
            for word in raw_words[:20000]:
                words.append([*list(self._rect(word[:4], current)), *word[4:]])
            annotations = []
            handwriting = self._handwriting_page(current)
            annotation_characters = 0
            annotation_truncated = False
            for a in islice(current.annots() or [], 1001):
                value = self._with_annotation_version(
                    self._annotation(current, a, handwriting=handwriting, raw_words=raw_words),
                    bool(a.info.get("id")))
                annotation_characters += self._annotation_characters(value)
                if len(annotations) >= 1000 or annotation_characters > 2_000_000:
                    annotation_truncated = True
                    break
                annotations.append(value)
            internal_links, internal_links_truncated = self._page_internal_links(doc, current)
            return {"page": int(page), "page_count": doc.page_count, "width": width, "height": height, "scale": scale, "requested_scale": requested_scale, "limited": scale < requested_scale - 1e-6, "byte_limited": byte_limited, "pixel_width": pix.width, "pixel_height": pix.height, "limits": {"scale": READER_MAX_SCALE, "pixels": READER_MAX_PIXELS, "side": READER_MAX_SIDE, "png_bytes": READER_MAX_PNG_BYTES, "internal_links": READER_MAX_INTERNAL_LINKS}, "image": base64.b64encode(image).decode("ascii"), "words": words, "annotations": annotations, "internal_links": internal_links, "internal_links_truncated": internal_links_truncated, "words_truncated": len(raw_words) > 20000, "annotations_truncated": annotation_truncated, "rotation": current.rotation, **({"layout": layout} if layout is not None else {})}

    def _add_annotation(self, doc, page, type="highlight", rects=None, text="", comment="", author="Reader", color="#ffdb66", extra=None, paths=None, width=2, annotation_id=None, parent_id=None):
        import pymupdf as fitz
        current = self._page(doc, page)
        if type not in {"highlight", "underline", "strikeout", "note", "ink", "square"}:
            raise ValueError("Supported annotation types are highlight, underline, strikeout, note, ink and square")
        linked_parent = None
        if parent_id is not None:
            if type != "ink":
                raise ValueError("Only ink accepts parent_id")
            parent_page, linked_parent = self._handwriting_parent(doc, parent_id)
            if parent_page.number != current.number:
                raise ValueError("Linked handwriting and its parent must be on the same page")
            # Keep the annotation's owning Page alive throughout the mutation.
            current = parent_page
            extra = {**(extra or {}), "kind": "linked-handwriting"}
        if type in {"ink", "square"}:
            if isinstance(width, bool) or not isinstance(width, (int, float)) or not 0.5 <= width <= 8:
                raise ValueError(f"{'Ink' if type == 'ink' else 'Square'} width must be 0.5–8 PDF points")
        if type == "ink":
            strokes = self._ink_paths(paths, current)
        else:
            rects = rects or ([[20, 20, 40, 40]] if type == "note" else [])
            if type == "square" and (not isinstance(rects, list) or len(rects) != 1
                    or not isinstance(rects[0], (list, tuple)) or len(rects[0]) != 4
                    or any(isinstance(value, bool) for value in rects[0])):
                raise ValueError("Square requires exactly one rectangle with four numeric coordinates")
            if not rects or len(rects) > 200:
                raise ValueError("Provide 1–200 annotation rectangles")
            unrotated = [self._rect(rect, current, inverse=True) for rect in rects]
        if len(text) > 20000 or len(comment) > 30000:
            raise ValueError("Annotation text/comment exceeds limit")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Color must be a six-digit hex string")
        if type == "ink":
            annot = current.add_ink_annot(strokes)
            annot.set_border(width=float(width))
        elif type == "square":
            # 标准 /Square，只有边框；不以填色或图像遮盖框内细节。
            annot = current.add_rect_annot(unrotated[0])
            annot.set_border(width=float(width))
        elif type != "note":
            # Markup quad order follows the native text baseline. Transforming
            # an already ordered displayed quad rotates that baseline a second
            # time on 90/270-degree pages, putting underline on the wrong edge.
            # Our selection API supplies axis-aligned word rectangles, not
            # arbitrary in-page text-direction quads.
            quads = [rect.quad for rect in unrotated]
            creator = {"highlight": current.add_highlight_annot, "underline": current.add_underline_annot,
                       "strikeout": current.add_strikeout_annot}[type]
            annot = creator(quads)
        else:
            annot = current.add_text_annot(unrotated[0].tl, comment, icon="Note")
        rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
        payload = {"text": text, **(extra or {})}
        annot.set_info(content=comment, title=author[:200], subject="paper-library:" + json.dumps(payload, ensure_ascii=False), creationDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"), modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
        annot.set_colors(stroke=rgb)
        annot.update()
        self._readable_underline(doc, annot)
        annotation_id = annotation_id or uuid.uuid4().hex
        doc.xref_set_key(annot.xref, "NM", fitz.get_pdf_str(annotation_id))
        if linked_parent is not None:
            annot.set_irt_xref(linked_parent.xref)
            group = self._linked_handwriting_page(current)["linked_parents"][linked_parent.xref]
            if group.get("truncated"):
                raise ValueError("LINKED_HANDWRITING_LIMIT: a parent accepts at most 64 ink objects, 128 strokes, 8192 points and 256 KiB geometry")
        if extra and extra.get("annotation_ids"):
            for parent in current.annots() or []:
                if parent.info.get("id") == extra["annotation_ids"][0]:
                    annot.set_irt_xref(parent.xref)
                    break
        return {"annotation": self._with_annotation_version(self._annotation(current, annot), True)}

    def annotate(self, id, **kwargs):
        with self.lock():
            retry_id = kwargs.get("annotation_id")
            if retry_id is not None:
                if not isinstance(retry_id, str) or not re.fullmatch(r"(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", retry_id):
                    raise ValueError("annotation_id must be a lowercase UUID")
                if kwargs.get("type", "highlight") != "ink":
                    # 保存原始请求指纹，不以经过 PDF 序列化或后续编辑的
                    # 矩形／内容来猜测重试。相同 UUID 永远只代表一次创建。
                    defaults = {"page": None, "type": "highlight", "rects": None,
                                "paths": None, "width": 2, "parent_id": None,
                                "text": "", "comment": "", "author": "Reader", "color": "#ffdb66"}
                    payload = {key: kwargs.get(key, default) for key, default in defaults.items()}
                    identity = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                                         separators=(",", ":"), allow_nan=False).encode()).hexdigest()
                    with self._open_pdf(self.pdf_path(id)) as doc:
                        self._page(doc, kwargs["page"])
                        matches, count = [], 0
                        for page in doc:
                            for annot in page.annots() or []:
                                count += 1
                                if count > _constants().MAX_ANNOTATIONS:
                                    raise ValueError("Annotation retry exceeds the bounded annotation scan")
                                if annot.info.get("id") == retry_id:
                                    matches.append((self._annotation_metadata(annot).get("create_request_hash"),
                                                    self._with_annotation_version(self._annotation(page, annot), True)))
                        if matches:
                            if len(matches) != 1 or matches[0][0] != identity:
                                raise ValueError("Annotation annotation_id already exists with different content")
                            return {"annotation": matches[0][1], "duplicate": True}
                    kwargs["extra"] = {**(kwargs.get("extra") or {}), "create_request_hash": identity}
                    return self._write_pdf(id, lambda doc: self._add_annotation(doc, **kwargs))
                # A lost HTTP response must not turn retry into a second stroke.
                # Check /NM while holding the same lock as the atomic write;
                # returning an existing object leaves PDF bytes/timestamps alone.
                with self._open_pdf(self.pdf_path(id)) as doc:
                    page = self._page(doc, kwargs["page"])
                    self._ink_paths(kwargs.get("paths"), page)
                    matches = []
                    for count, annot in enumerate(page.annots() or []):
                        if count >= _constants().MAX_ANNOTATIONS:
                            raise ValueError("Annotation retry exceeds the bounded page scan")
                        if annot.info.get("id") == retry_id:
                            matches.append(self._annotation(page, annot))
                    if matches:
                        existing = matches[0]
                        expected_color = kwargs.get("color", "#ffdb66")
                        color = tuple(int(expected_color[i:i + 2], 16) / 255 for i in (1, 3, 5)) if isinstance(expected_color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", expected_color) else ()
                        paths = kwargs["paths"]
                        saved_paths = existing.get("paths", [])
                        width = kwargs.get("width", 2)
                        equal = (len(matches) == 1 and existing["type"] == "ink" and existing["source"] == "paper-library"
                                 and isinstance(width, (int, float)) and not isinstance(width, bool) and 0.5 <= width <= 8
                                 and abs(existing["width"] - width) < 0.00001
                                 and existing["text"] == kwargs.get("text", "") and existing["comment"] == kwargs.get("comment", "")
                                 and existing["author"] == kwargs.get("author", "Reader")[:200]
                                 and existing.get("parent_id") == kwargs.get("parent_id")
                                 and len(color) == 3 and len(existing["color"].get("stroke", [])) == 3
                                 and all(abs(a - b) < 0.00001 for a, b in zip(existing["color"]["stroke"], color))
                                 and len(paths) == len(saved_paths) and all(len(a) == len(b) for a, b in zip(paths, saved_paths))
                                 and all(abs(a - b) < 0.001 for original, saved in zip(paths, saved_paths) for point, other in zip(original, saved) for a, b in zip(point, other)))
                        if not equal:
                            raise ValueError("Ink annotation_id already exists with different content")
                        return {"annotation": existing, "duplicate": True}
            return self._write_pdf(id, lambda doc: self._add_annotation(doc, **kwargs))

    def _import_zotero_annotation(self, id, annotation):
        position = annotation.get("annotationPosition") or annotation.get("position")
        if isinstance(position, str):
            position = json.loads(position)
        if not isinstance(position, dict) or "pageIndex" not in position:
            raise ValueError("Zotero annotation has no pageIndex/position")
        kind = annotation.get("annotationType") or annotation.get("type")
        if kind not in {"highlight", "underline", "strikeout", "note"}:
            raise ValueError(f"unsupported Zotero annotation type {kind!r}")
        rects = position.get("rects")
        if not rects:
            raise ValueError("Zotero annotation has no rectangles")
        def operation(doc):
            import pymupdf as fitz
            page = self._page(doc, position["pageIndex"] + 1)
            # Zotero positions use PDF user space (bottom-left), PyMuPDF uses top-left.
            displayed = [list(fitz.Rect(rect) * page.transformation_matrix * page.rotation_matrix) for rect in rects]
            return self._add_annotation(doc, page.number + 1, kind, displayed, annotation.get("annotationText", annotation.get("text", "")), annotation.get("annotationComment", annotation.get("comment", "")), annotation.get("annotationAuthorName", "Zotero import"), annotation.get("annotationColor", annotation.get("color", "#ffdb66")), {"imported_from": "zotero-json"})
        return self._write_pdf(id, operation)

    def _find_annotation(self, doc, annotation_id):
        for page in doc:
            for annot in page.annots() or []:
                if (annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}") == annotation_id:
                    return page, annot
        raise ValueError("Annotation not found (refresh annotations if the PDF changed externally)")

    def annotation_reply_create(self, id, annotation_id, reply_id, comment=""):
        """为同一划线追加原生回复；UUID 重试只读返回，不复制划线。"""
        import pymupdf as fitz
        if not isinstance(annotation_id, str) or not 1 <= len(annotation_id) <= 160 or re.search(r"[\x00-\x1f]", annotation_id):
            raise ValueError("Parent annotation identity is invalid")
        if not isinstance(reply_id, str) or not re.fullmatch(r"(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", reply_id):
            raise ValueError("reply_id must be a lowercase UUID")
        if not isinstance(comment, str) or len(comment) > 30000:
            raise ValueError("Comment must be text of at most 30000 characters")
        identity = hashlib.sha256(json.dumps({"parent": annotation_id, "comment": comment}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

        def locate(doc):
            parents, previous, scanned = [], [], 0
            for page in doc:
                for annot in page.annots() or []:
                    scanned += 1
                    if scanned > _constants().MAX_ANNOTATIONS:
                        raise ValueError("Annotation reply exceeds the bounded annotation scan")
                    name = annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}"
                    if name == annotation_id:
                        parents.append((page, annot))
                    if name == reply_id:
                        previous.append((page, annot))
            if previous:
                page, annot = previous[0]
                meta = self._annotation_metadata(annot)
                if len(previous) != 1 or meta.get("kind") != "reader-reply" or meta.get("create_request_hash") != identity:
                    raise ValueError("Reply reply_id already exists with different content")
                return None, None, self._with_annotation_version(self._annotation(page, annot), True)
            if len(parents) != 1:
                raise ValueError("Parent annotation is missing or ambiguous; refresh annotations")
            page, parent = parents[0]
            if self._annotation_metadata(parent).get("kind") == "reader-reply":
                if not parent.irt_xref:
                    raise ValueError("Parent underline was deleted; choose an existing annotation")
                parent = page.load_annot(parent.irt_xref)
            if self._annotation_metadata(parent).get("kind") in {"reader-reply", "ai-feedback", "handwriting-note"} | LINKED_KINDS:
                raise ValueError("Choose the original reader annotation to add a remark")
            return page, parent, None

        def operation(doc):
            page, parent, duplicate = locate(doc)
            if duplicate is not None:
                return {"annotation": duplicate, "duplicate": True}
            source = self._annotation(page, parent, exact=True)
            if len(source["text"]) > 20000 or len(source["rects"]) > 200:
                raise ValueError("Parent source exceeds the bounded reply source limit")
            root_id = source["id"]
            annot = page.add_text_annot(parent.rect.tl, comment, icon="Comment")
            metadata = {"kind": "reader-reply", "parent_id": root_id, "text": source["text"],
                        "source_rects": source["rects"], "create_request_hash": identity}
            date = "D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ")
            annot.set_info(content=comment, title="Reader", subject="paper-library:" + json.dumps(metadata, ensure_ascii=False), creationDate=date, modDate=date)
            doc.xref_set_key(annot.xref, "NM", fitz.get_pdf_str(reply_id))
            annot.set_irt_xref(parent.xref)
            annot.update()
            return {"annotation": self._with_annotation_version(self._annotation(page, annot), True)}

        with self.lock():
            with self._open_pdf(self.pdf_path(id)) as doc:
                _, _, previous = locate(doc)
                if previous is not None:
                    return {"annotation": previous, "duplicate": True}
            return self._write_pdf(id, operation)

    @staticmethod
    def _style_border(annot):
        border = dict(annot.border)
        # MuPDF 的 border 属性不投影文字标记的 BS，直接读取原生字典。
        if annot.type[0] in {9, 11}:
            kind, raw = annot.parent.parent.xref_get_key(annot.xref, "BS/D")
            if kind == "array" and len(raw) <= 256:
                values = re.findall(r"[+-]?(?:\d*\.)?\d+", raw)
                if len(values) <= 16:
                    border["dashes"] = [float(v) for v in values]
        return border

    @staticmethod
    def _annotation_style(annot):
        border = AnnotationAccess._style_border(annot)
        dashes = border.get("dashes") or []
        style = "dotted" if dashes and dashes[0] <= 2 else "dashed" if dashes else "solid"
        signature = hashlib.sha256(json.dumps({"colors": annot.colors, "border": border}, sort_keys=True).encode()).hexdigest()
        return {"line_style": style, "style_version": signature}

    def annotation_style(self, id, annotation_id, color, line_style=None, expected_version=None):
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Color must be a six-digit hex string")
        if line_style is not None and (not isinstance(line_style, str) or line_style not in {"solid", "dashed", "dotted"}):
            raise ValueError("Unsupported line style")
        if not isinstance(expected_version, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_version):
            raise ValueError("请刷新批注后再修改样式。")
        rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
        def checked(doc):
            page, annot = self._find_annotation(doc, annotation_id)
            if annot.type[0] not in {0, 4, 8, 9, 11, 15} or self._is_handwriting(annot):
                raise ValueError("这类批注暂不支持修改样式。")
            if line_style is not None and annot.type[0] not in {4, 9, 11, 15}:
                raise ValueError("高亮与便笺仅支持修改颜色。")
            style = self._annotation_style(annot)
            old = annot.colors.get("stroke") or []
            same = len(old) == 3 and all(abs(a-b) < 0.00001 for a, b in zip(old, rgb)) and (line_style is None or style["line_style"] == line_style)
            if not same and style["style_version"] != expected_version:
                raise ValueError("ANNOTATION_STALE: 批注样式已在其他窗口修改，请刷新后重试。")
            return page, annot, same
        def operation(doc):
            page, annot, _ = checked(doc)
            annot.set_colors(stroke=rgb)
            if line_style is not None:
                dash = {"solid": [], "dashed": [6, 3], "dotted": [1, 3]}[line_style]
                # 标准 BS 保存线型；文字标记还需同步 AP，PDF 阅读器才能直接显示。
                doc.xref_set_key(annot.xref, "BS/S", "/S" if not dash else "/D")
                doc.xref_set_key(annot.xref, "BS/D", "[" + " ".join(map(str, dash)) + "]")
            annot.set_info(modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
            annot.update()
            self._readable_underline(doc, annot)
            return {"annotation": self._with_annotation_version(self._annotation(page, annot), bool(annot.info.get("id")))}
        with self.lock():
            with self._open_pdf(self.pdf_path(id)) as doc:
                page, annot, same = checked(doc)
                if same:
                    return {"annotation": self._with_annotation_version(self._annotation(page, annot), bool(annot.info.get("id"))), "duplicate": True}
            return self._write_pdf(id, operation)

    def annotation_update(self, id, annotation_id, comment, version=None):
        if not isinstance(comment, str) or len(comment) > 30000:
            raise ValueError("Comment must be text of at most 30000 characters")
        if version is not None and (not isinstance(version, str) or not re.fullmatch(r"[0-9a-f]{64}", version)):
            raise ValueError("Annotation version must be a SHA-256 value")
        def checked(doc):
            page, annot = self._find_annotation(doc, annotation_id)
            if self._annotation_metadata(annot).get("kind") == "linked-handwriting-transcript":
                raise ValueError("Use linked_handwriting_text with the current group version to update a transcript")
            if self._is_handwriting(annot):
                raise ValueError("Use handwriting_save to update a handwritten note with its version and original board")
            value = self._with_annotation_version(self._annotation(page, annot), bool(annot.info.get("id")))
            if value["comment"] != comment and version is not None and value.get("edit_version") != version:
                raise ValueError("ANNOTATION_STALE: 批注已在其他窗口修改，草稿已保留；请核对最新内容后再保存。")
            return page, annot, value
        def operation(doc):
            page, annot, _ = checked(doc)
            annot.set_info(content=comment, modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
            annot.update()
            self._readable_underline(doc, annot)
            return {"annotation": self._with_annotation_version(self._annotation(page, annot), bool(annot.info.get("id")))}
        with self.lock():
            # 已完成的更新重试不再生成备份、改时间戳或覆盖后续状态。
            with self._open_pdf(self.pdf_path(id)) as doc:
                _, _, value = checked(doc)
                if value["comment"] == comment:
                    return {"annotation": value, "duplicate": True}
            return self._write_pdf(id, operation)

    def annotation_reselect(self, id, annotation_id, page, rects, text, expected_version):
        """Update one native annotation in place, retaining identity and replies."""
        import pymupdf as fitz
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise ValueError("请选择不超过 20000 字符的 PDF 原文。")
        if not isinstance(rects, list) or not 1 <= len(rects) <= 200:
            raise ValueError("请选择 1–200 个文字区域。")
        if not isinstance(expected_version, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_version):
            raise ValueError("缺少批注版本，请刷新后重试。")
        def operation(doc):
            current, annot = self._find_annotation(doc, annotation_id)
            value = self._with_annotation_version(self._annotation(current, annot), bool(annot.info.get("id")))
            if value.get("edit_version") != expected_version:
                raise ValueError("ANNOTATION_STALE: 批注已改变，请刷新后重新选择。")
            if isinstance(page, bool) or page != current.number + 1:
                raise ValueError("请在原批注所在页选择文字。")
            kind = value["type"]
            extra = self._annotation_metadata(annot)
            if not annot.info.get("id") or extra.get("kind") in {"reader-reply", "ai-feedback", "handwriting-note"} | LINKED_KINDS:
                raise ValueError("此批注缺少稳定身份或不支持调整原文范围。")
            if kind not in {"highlight", "underline", "strikeout", "note"} or (kind == "note" and not extra):
                raise ValueError("此批注类型暂不支持调整原文范围。")
            regions = [self._rect(rect, current, inverse=True) for rect in rects]
            if kind == "note":
                extra["source_rects"] = rects
                origin = regions[0].tl
                annot.set_rect(fitz.Rect(origin.x, origin.y, origin.x + annot.rect.width, origin.y + annot.rect.height))
            else:
                creator = {"highlight": current.add_highlight_annot, "underline": current.add_underline_annot,
                           "strikeout": current.add_strikeout_annot}[kind]
                temporary = creator([region.quad for region in regions])
                for key in ("QuadPoints", "Rect"):
                    datatype, raw = doc.xref_get_key(temporary.xref, key)
                    if datatype != "array":
                        raise ValueError("无法生成新的原生批注范围。")
                    doc.xref_set_key(annot.xref, key, raw)
                current.delete_annot(temporary)
            if extra:
                extra["text"] = text
                annot.set_info(subject="paper-library:" + json.dumps(extra, ensure_ascii=False))
            annot.set_info(modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
            annot.update()
            self._readable_underline(doc, annot)
            return {"annotation": self._with_annotation_version(self._annotation(current, annot), True)}
        with self.lock():
            return self._write_pdf(id, operation)

    def annotation_delete(self, id, annotation_id):
        def operation(doc):
            page, annot = self._find_annotation(doc, annotation_id)
            child = self._handwriting_child(page, annot)
            linked = [reply.xref for reply in page.annots() or [] if self._is_linked_handwriting(reply) and reply.irt_xref == annot.xref]
            deleting = {annot.xref, *linked, *([child.xref] if child else [])}
            # MuPDF otherwise deletes every reply together with its parent.
            # Only our owned handwriting replies belong to this delete action;
            # preserve all other replies as notes with no dangling parent link.
            for reply in page.annots() or []:
                if reply.xref not in deleting and reply.irt_xref in deleting:
                    doc.xref_set_key(reply.xref, "IRT", "null")
            for xref in linked:
                page.delete_annot(page.load_annot(xref))
            if child:
                page.delete_annot(child)
            page.delete_annot(annot)
            return {"deleted": True}
        with self.lock():
            result = self._write_pdf(id, operation)
            self.db.execute("DELETE FROM annotation_favorites WHERE paper_id=? AND annotation_id=?", (id, annotation_id))
            return result

    def export_annotations(self, id, format="xfdf"):
        item = self.get(id)
        result = self.annotations(id)
        annotations = result["annotations"]
        if format == "json":
            text = json.dumps({"schema": "paper-library.annotations.v1", "item": item, **result}, ensure_ascii=False, indent=2)
            mime = "application/json"
        elif format == "markdown":
            lines = ["# " + item["title"], "", "Citation key: `" + item["citekey"] + "`", ""]
            for annotation in annotations:
                lines.extend([f"## Page {annotation['page']} · {annotation['type']} · {annotation['id']}", "", "> " + annotation["text"].replace("\n", "\n> "), "", annotation["comment"], "", "Author: " + annotation["author"], ""])
                if annotation.get("annotation_ids") or annotation.get("reply_to"):
                    lines.extend(["Reply to: " + ", ".join(annotation.get("annotation_ids") or [annotation["reply_to"]]), ""])
            if result["truncated"]:
                lines.append("Export truncated at 5000 annotations.")
            text, mime = "\n".join(lines), "text/markdown"
        elif format == "xfdf":
            import pymupdf as fitz
            root = ET.Element("xfdf", xmlns="http://ns.adobe.com/xfdf/", **{"xml:space": "preserve"})
            container = ET.SubElement(root, "annots")
            warnings = []
            with self._open_pdf(self.pdf_path(id)) as doc:
                for annotation in annotations:
                    if annotation["type"] not in {"highlight", "note", "underline", "strikeout", "squiggly", "ink", "square"} or annotation.get("geometry_truncated"):
                        preservation = "PDF preserves the geometry; JSON marks geometry_truncated" if annotation.get("geometry_truncated") else "JSON/PDF preserve it"
                        if annotation.get("kind") == "handwriting-note":
                            preservation = "PDF preserves the original handwriting attachment; JSON preserves its transcript summary"
                        warnings.append(f"Skipped XFDF encoding for {annotation['type']} annotation {annotation['id']}; {preservation}")
                        continue
                    page = doc[annotation["page"] - 1]
                    derotation = page.derotation_matrix
                    rotation = page.rotation
                    # On rotated cropped pages PyMuPDF's transformation_matrix
                    # omits the crop translation. Ask the unrotated page for its
                    # user-space matrix, then restore it without saving the PDF.
                    try:
                        page.set_rotation(0)
                        native_to_pdf = ~page.transformation_matrix
                    finally:
                        page.set_rotation(rotation)
                    matrix = derotation * native_to_pdf
                    rect = fitz.Rect(annotation["rect"]) * matrix
                    attributes = {"page": str(annotation["page"] - 1), "name": annotation["id"], "title": annotation["author"], "rect": ",".join(str(round(v, 3)) for v in rect)}
                    if annotation.get("reply_to"):
                        attributes["inreplyto"] = annotation["reply_to"]
                    stroke = (annotation.get("color") or {}).get("stroke")
                    if isinstance(stroke, (list, tuple)) and len(stroke) == 3 and all(isinstance(value, (int, float)) and math.isfinite(value) for value in stroke):
                        attributes["color"] = "#" + "".join(f"{round(max(0, min(1, value)) * 255):02X}" for value in stroke)
                    if annotation["created"]:
                        attributes["creationdate"] = annotation["created"]
                    if annotation["modified"]:
                        attributes["date"] = annotation["modified"]
                    if annotation["type"] in {"ink", "square"}:
                        attributes["width"] = str(annotation["width"])
                    elif annotation["type"] != "note":
                        points = []
                        for display in annotation["rects"]:
                            native_rect = fitz.Rect(display) * page.derotation_matrix
                            quad = native_rect.quad * native_to_pdf
                            for point in (quad.ul, quad.ur, quad.ll, quad.lr):
                                points.extend(point)
                        attributes["coords"] = ",".join(str(round(v, 3)) for v in points)
                    node = ET.SubElement(container, "text" if annotation["type"] == "note" else annotation["type"], attributes)
                    if annotation["type"] == "ink":
                        inklist = ET.SubElement(node, "inklist")
                        for stroke in annotation["paths"]:
                            points = [fitz.Point(point) * matrix for point in stroke]
                            ET.SubElement(inklist, "gesture").text = ";".join(
                                ",".join(str(round(value, 3)) for value in point) for point in points)
                    ET.SubElement(node, "contents").text = annotation["comment"]
            text, mime = ET.tostring(root, encoding="unicode", xml_declaration=True), "application/vnd.adobe.xfdf"
            return {"text": text, "filename": safe_name(item["citekey"]) + ".xfdf", "mime": mime, "warnings": warnings, "truncated": result["truncated"]}
        else:
            raise ValueError("Export format must be xfdf, json or markdown")
        return {"text": text, "filename": safe_name(item["citekey"]) + (".md" if format == "markdown" else ".json"), "mime": mime, "truncated": result["truncated"]}
