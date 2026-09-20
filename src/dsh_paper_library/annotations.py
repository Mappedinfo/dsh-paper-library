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


def install_helpers(**helpers):
    module = globals()
    for name, value in helpers.items():
        if name not in module:
            raise AttributeError(f"annotations does not use a helper named {name!r}")
        module[name] = value


class AnnotationAccess:
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
    def _annotation(cls, page, annot, exact=False):
        import pymupdf as fitz
        info = annot.info
        extra = cls._annotation_metadata(annot)
        rects = []
        if annot.vertices and annot.type[0] in {8, 9, 10, 11}:
            for index in range(0, len(annot.vertices), 4):
                quad = fitz.Quad(annot.vertices[index:index + 4])
                rects.append(list(cls._rect(quad.rect, page)))
        if not rects:
            rects = [list(cls._rect(annot.rect, page))]
        kind = "highlight" if annot.type[0] == 8 else "note" if annot.type[0] == 0 else annot.type[1].lower()
        text = extra.get("text", "")
        if not text and kind in {"highlight", "underline", "strikeout", "squiggly"}:
            words = page.get_text("words")
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
        return {"id": info.get("id") or f"external-{page.number + 1}-{annot.xref}", "page": page.number + 1, "type": kind, "text": text, "comment": info.get("content", ""), "author": info.get("title", ""), "rect": list(cls._rect(annot.rect, page)), "rects": rects, "created": info.get("creationDate"), "modified": info.get("modDate"), "color": annot.colors, "source": "paper-library" if extra and extra.get("source_kind") != "external-companion" else "external-pdf", **({"reply_to": reply_to} if reply_to else {}), **{key: extra[key] for key in ("kind", "model", "annotation_ids", "generated", "source_kind", "source_session_id", "source_message_id", "source_snapshot_ids") if key in extra}}

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
        version = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        return {**value, "version": version, "identity_reliable": identity_reliable,
                "identity_source": "pdf-nm" if identity_reliable else "page-xref",
                "text_characters": len(value["text"]), "comment_characters": len(value["comment"]),
                "source_characters": len(value["text"]) + len(value["comment"])}

    @staticmethod
    def _reference_limits(max_characters=None):
        # `None` rather than the constant as a default: a default is evaluated at import time, which
        # would freeze the budget before anything could change it.
        if max_characters is None:
            max_characters = _constants().REFERENCE_SOURCE_CHARACTERS
        return {"annotations": _constants().REFERENCE_CATALOG_LIMIT, "source_characters": max_characters,
                "selection_characters": 8000, "preview_characters": _constants().REFERENCE_PREVIEW_CHARACTERS,
                "scanned_annotations": _constants().REFERENCE_SCAN_LIMIT, "annotation_bytes": _constants().REFERENCE_ANNOTATION_BYTES}

    def annotation_catalog(self, id):
        """Bounded current-paper metadata for selection; never a resident index."""
        item = self.get(id)
        values, seen, duplicate_ids = [], set(), set()
        total, scanned, characters, total_exact = 0, 0, 0, True
        if item["pdf"]:
            with self._open_pdf(self.pdf_path(id)) as doc:
                stop = False
                for page in doc:
                    for annot in page.annots() or []:
                        if scanned >= _constants().REFERENCE_SCAN_LIMIT:
                            total_exact, stop = False, True
                            break
                        scanned += 1
                        if self._annotation_metadata(annot).get("kind") == "ai-feedback":
                            continue
                        total += 1
                        value = self._reference_annotation(self._annotation(page, annot, exact=True), bool(annot.info.get("id")))
                        characters += value["source_characters"]
                        if value["id"] in seen:
                            duplicate_ids.add(value["id"])
                        seen.add(value["id"])
                        if len(values) < _constants().REFERENCE_CATALOG_LIMIT:
                            projected = {key: value[key] for key in ("id", "version", "page", "type", "source", "identity_reliable", "identity_source", "text_characters", "comment_characters", "source_characters")}
                            projected.update({key: value[key][:_constants().REFERENCE_PREVIEW_CHARACTERS] for key in ("text", "comment")})
                            projected["preview_truncated"] = any(len(value[key]) > _constants().REFERENCE_PREVIEW_CHARACTERS for key in ("text", "comment"))
                            values.append(projected)
                    if stop:
                        break
        for value in values:
            if value["id"] in duplicate_ids:
                value.update(identity_reliable=False, identity_source="duplicate-pdf-nm")
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
        if item["pdf"]:
            with self._open_pdf(self.pdf_path(id)) as doc:
                if selection and selection["page"] > doc.page_count:
                    raise ValueError("Selection page is outside the current PDF")
                stop = False
                for page in doc:
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
                        if self._annotation_metadata(annot).get("kind") == "ai-feedback":
                            continue
                        total += 1
                        if annotation_id not in requested:
                            continue
                        raw_value = self._annotation(page, annot, exact=True)
                        if characters + len(raw_value["text"]) + len(raw_value["comment"]) > max_characters:
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

    def annotations(self, id):
        result, characters = [], 0
        with self._open_pdf(self.pdf_path(id)) as doc:
            for page in doc:
                for annot in page.annots() or []:
                    if len(result) >= _constants().MAX_ANNOTATIONS:
                        return {"annotations": result, "truncated": True}
                    value = self._annotation(page, annot)
                    characters += len(value["text"]) + len(value["comment"])
                    if characters > 2_000_000:
                        return {"annotations": result, "truncated": True}
                    result.append(value)
        return {"annotations": result, "truncated": False}

    def page_layout(self, id):
        """Page-tree geometry only; no page pixels, text, images or annotations.

        The worker retains at most 2,000 small geometry records and closes the
        PDF before returning. Coordinates share page()'s displayed point space.
        """
        pages = []
        with self._open_pdf(self.pdf_path(id)) as doc:
            # _open_pdf rejects larger files before touching individual pages.
            for page in doc:
                width, height = page.rect.width, page.rect.height
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    raise ValueError(f"Invalid dimensions on PDF page {page.number + 1}")
                pages.append({"page": page.number + 1, "width": width, "height": height, "rotation": page.rotation})
            count = doc.page_count
        return {"id": id, "page_count": count, "pages": pages,
                "coordinate_system": "displayed-pdf-points", "rotation_applied": True,
                "truncated": False, "limits": {"pages": 2000}}

    def page(self, id, page=1, scale=1.25):
        import pymupdf as fitz
        scale = float(scale)
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError("Render scale must be positive and finite")
        scale = min(scale, 2.0)
        with self._open_pdf(self.pdf_path(id)) as doc:
            current = self._page(doc, page)
            width, height = current.rect.width, current.rect.height
            if width <= 0 or height <= 0:
                raise ValueError("Invalid page dimensions")
            scale = min(scale, math.sqrt(4_000_000 / (width * height)), 4000 / width, 4000 / height)
            pix = current.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            words = []
            raw_words = current.get_text("words")
            for word in raw_words[:20000]:
                words.append([*list(self._rect(word[:4], current)), *word[4:]])
            annotations = []
            annotation_characters = 0
            annotation_truncated = False
            for a in islice(current.annots() or [], 1001):
                value = self._annotation(current, a)
                annotation_characters += len(value["text"]) + len(value["comment"])
                if len(annotations) >= 1000 or annotation_characters > 2_000_000:
                    annotation_truncated = True
                    break
                annotations.append(value)
            return {"page": int(page), "page_count": doc.page_count, "width": width, "height": height, "scale": scale, "image": base64.b64encode(pix.tobytes("png")).decode("ascii"), "words": words, "annotations": annotations, "words_truncated": len(raw_words) > 20000, "annotations_truncated": annotation_truncated, "rotation": current.rotation}

    def _add_annotation(self, doc, page, type="highlight", rects=None, text="", comment="", author="Reader", color="#ffdb66", extra=None):
        import pymupdf as fitz
        current = self._page(doc, page)
        if type not in {"highlight", "underline", "strikeout", "note"}:
            raise ValueError("Supported annotation types are highlight, underline, strikeout and note")
        rects = rects or ([[20, 20, 40, 40]] if type == "note" else [])
        if not rects or len(rects) > 200:
            raise ValueError("Provide 1–200 annotation rectangles")
        unrotated = [self._rect(rect, current, inverse=True) for rect in rects]
        if len(text) > 20000 or len(comment) > 30000:
            raise ValueError("Annotation text/comment exceeds limit")
        if type != "note":
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
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Color must be a six-digit hex string")
        rgb = tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
        payload = {"text": text, **(extra or {})}
        annot.set_info(content=comment, title=author[:200], subject="paper-library:" + json.dumps(payload, ensure_ascii=False), creationDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"), modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
        annot.set_colors(stroke=rgb)
        annot.update()
        annotation_id = uuid.uuid4().hex
        doc.xref_set_key(annot.xref, "NM", fitz.get_pdf_str(annotation_id))
        if extra and extra.get("annotation_ids"):
            for parent in current.annots() or []:
                if parent.info.get("id") == extra["annotation_ids"][0]:
                    annot.set_irt_xref(parent.xref)
                    break
        return {"annotation": self._annotation(current, annot)}

    def annotate(self, id, **kwargs):
        with self.lock():
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

    def annotation_update(self, id, annotation_id, comment):
        if not isinstance(comment, str) or len(comment) > 30000:
            raise ValueError("Comment must be text of at most 30000 characters")
        def operation(doc):
            page, annot = self._find_annotation(doc, annotation_id)
            annot.set_info(content=comment, modDate="D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ"))
            annot.update()
            return {"annotation": self._annotation(page, annot)}
        with self.lock():
            return self._write_pdf(id, operation)

    def annotation_delete(self, id, annotation_id):
        def operation(doc):
            page, annot = self._find_annotation(doc, annotation_id)
            page.delete_annot(annot)
            return {"deleted": True}
        with self.lock():
            return self._write_pdf(id, operation)

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
                    if annotation["type"] not in {"highlight", "note", "underline", "strikeout", "squiggly"}:
                        warnings.append(f"Skipped XFDF encoding for {annotation['type']} annotation {annotation['id']}; JSON/PDF preserve it")
                        continue
                    page = doc[annotation["page"] - 1]
                    matrix = page.derotation_matrix * ~page.transformation_matrix
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
                    if annotation["type"] != "note":
                        points = []
                        for display in annotation["rects"]:
                            native_rect = fitz.Rect(display) * page.derotation_matrix
                            quad = native_rect.quad * ~page.transformation_matrix
                            for point in (quad.ul, quad.ur, quad.ll, quad.lr):
                                points.extend(point)
                        attributes["coords"] = ",".join(str(round(v, 3)) for v in points)
                    node = ET.SubElement(container, "text" if annotation["type"] == "note" else annotation["type"], attributes)
                    ET.SubElement(node, "contents").text = annotation["comment"]
            text, mime = ET.tostring(root, encoding="unicode", xml_declaration=True), "application/vnd.adobe.xfdf"
            return {"text": text, "filename": safe_name(item["citekey"]) + ".xfdf", "mime": mime, "warnings": warnings, "truncated": result["truncated"]}
        else:
            raise ValueError("Export format must be xfdf, json or markdown")
        return {"text": text, "filename": safe_name(item["citekey"]) + (".md" if format == "markdown" else ".json"), "mime": mime, "truncated": result["truncated"]}
