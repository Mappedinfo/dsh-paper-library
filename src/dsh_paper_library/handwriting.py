"""Portable per-annotation handwriting, stored only in native PDF objects.

A FileAttachment reply carries an inert SVG with exact strokes in its metadata.
Contents holds the labelled transcription. The catalog stores neither copy.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
import uuid
import xml.etree.ElementTree as ET

MAX_BOARD_BYTES = 256 * 1024
MAX_SVG_BYTES = 768 * 1024
MAX_STROKES = 128
MAX_POINTS = 8192
MAX_TRANSCRIPT = 12000
MAX_SCAN = 20000
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_SCHEMA = "paper-library.handwriting.v1"
HEADERS = {"model": "手写转写（模型生成，待核对）\n", "edited": "手写转写（用户校正）\n", "none": "手写原稿（尚未转写）\n"}
UUID_PATTERN = r"(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"


class HandwritingConflict(ValueError):
    code = "STATE_CONFLICT"
    status = 409

    def __init__(self, current):
        super().__init__("STATE_CONFLICT: handwriting changed; reload and compare before saving")
        self.current = current


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def board_value(value):
    if not isinstance(value, dict) or set(value) != {"width", "height", "strokes"}:
        raise ValueError("Handwriting board requires width, height and strokes")
    for field in ("width", "height"):
        if isinstance(value[field], bool) or not isinstance(value[field], (int, float)) or not 1 <= value[field] <= 4096:
            raise ValueError("Handwriting board dimensions must be 1–4096")
    strokes = value["strokes"]
    if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
        raise ValueError("Handwriting board accepts at most 128 strokes")
    total, result = 0, {"width": value["width"], "height": value["height"], "strokes": []}
    for stroke in strokes:
        if not isinstance(stroke, dict) or set(stroke) != {"points", "color", "width"}:
            raise ValueError("A handwriting stroke requires points, color and width")
        points = stroke["points"]
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError("Each handwriting stroke requires at least two points")
        total += len(points)
        if total > MAX_POINTS:
            raise ValueError("Handwriting board exceeds 8192 points")
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2 or any(
                isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number <= limit
                for number, limit in zip(point, (value["width"], value["height"]))
            ):
                raise ValueError("Handwriting points must be finite and inside the board")
        width = stroke["width"]
        if isinstance(width, bool) or not isinstance(width, (int, float)) or not 0.5 <= width <= 16:
            raise ValueError("Handwriting stroke width must be 0.5–16 board units")
        color = stroke["color"]
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Handwriting color must be a six-digit hex string")
        result["strokes"].append({"points": [list(point) for point in points], "color": color.lower(), "width": width})
    if len(canonical(result).encode("utf-8")) > MAX_BOARD_BYTES:
        raise ValueError("Handwriting board exceeds 256 KiB")
    return result


def board_svg(board):
    root = ET.Element("svg", xmlns=SVG_NAMESPACE, width=str(board["width"]), height=str(board["height"]), viewBox=f"0 0 {board['width']} {board['height']}")
    ET.SubElement(root, "title").text = "Original handwriting"
    ET.SubElement(root, "metadata").text = canonical({"schema": SVG_SCHEMA, "board": board})
    ET.SubElement(root, "rect", width="100%", height="100%", fill="#ffffff")
    for stroke in board["strokes"]:
        ET.SubElement(root, "polyline", points=" ".join(",".join(str(number) for number in point) for point in stroke["points"]),
                      fill="none", stroke=stroke["color"], **{"stroke-width": str(stroke["width"]), "stroke-linecap": "round", "stroke-linejoin": "round"})
    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    if len(data) > MAX_SVG_BYTES:
        raise ValueError("Handwriting SVG exceeds the bounded attachment budget")
    return data


def read_svg(data):
    if len(data) > MAX_SVG_BYTES or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("Handwriting attachment exceeds limits or contains unsupported XML")
    try:
        root = ET.fromstring(data)
        metadata = root.find(f"{{{SVG_NAMESPACE}}}metadata")
        value = json.loads(metadata.text or "") if metadata is not None else None
        if root.tag != f"{{{SVG_NAMESPACE}}}svg" or not isinstance(value, dict) or value.get("schema") != SVG_SCHEMA:
            raise ValueError("missing handwriting metadata")
        board = board_value(value["board"])
        # Only our inert SVG vocabulary is accepted; scripts, external resources
        # or edits that disagree with the original stroke metadata stay untouched
        # in the PDF but cannot be presented as a verified original board.
        if board_svg(board) != data:
            raise ValueError("SVG drawing differs from its original stroke metadata")
        return board
    except (ET.ParseError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid handwriting SVG attachment") from error


class HandwritingAccess:
    @classmethod
    def _is_handwriting(cls, annot):
        return annot.type[0] == 17 and cls._annotation_metadata(annot).get("kind") == "handwriting-note"

    @classmethod
    def _read_handwriting(cls, page, annot, full=False, budget=None):
        if not cls._is_handwriting(annot) or not annot.irt_xref:
            raise ValueError("Handwriting attachment has no native parent")
        info = annot.file_info
        if info.get("size", -1) > MAX_SVG_BYTES or info.get("length", -1) > MAX_SVG_BYTES:
            raise ValueError("Handwriting attachment exceeds 768 KiB")
        data = annot.get_file()
        if budget is not None:
            budget[0] -= len(data)
            if budget[0] < 0:
                raise ValueError("Handwriting attachments exceed the 8 MiB page budget")
        board = read_svg(data)
        parent = page.load_annot(annot.irt_xref)
        parent_id = parent.info.get("id") or f"external-{page.number + 1}-{parent.xref}"
        extra = cls._annotation_metadata(annot)
        source = extra.get("transcription_source")
        if source not in HEADERS:
            raise ValueError("Handwriting transcription source is invalid")
        content = annot.info.get("content", "")
        # External readers may edit Contents. Keep that text visible and version
        # it, rather than dropping it or regenerating it from hidden metadata.
        transcript = content[len(HEADERS[source]):] if content.startswith(HEADERS[source]) else content
        if len(transcript) > MAX_TRANSCRIPT:
            raise ValueError("Handwriting transcription exceeds 12000 characters")
        identity = annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}"
        semantic = {"id": identity, "parent_id": parent_id, "attachment_hash": hashlib.sha256(data).hexdigest(),
                    "transcript": transcript, "transcription_source": source}
        version = hashlib.sha256(canonical(semantic).encode("utf-8")).hexdigest()
        return {"id": identity, "parent_id": parent_id, "transcript": transcript, "transcription_source": source,
                "version": version, **({"board": board} if full else {})}

    @classmethod
    def _handwriting_page(cls, page):
        parents, children, budget = {}, {}, [8 * 1024 * 1024]
        for count, annot in enumerate(page.annots() or []):
            if count >= MAX_SCAN:
                raise ValueError("Handwriting page exceeds the bounded annotation scan")
            if not cls._is_handwriting(annot):
                continue
            # Bound cumulative SVG parsing per page as well as each attachment.
            value = cls._read_handwriting(page, annot, budget=budget)
            if annot.irt_xref in parents:
                raise ValueError("More than one handwriting note is attached to this annotation; resolve the duplicate in a PDF editor")
            parents[annot.irt_xref] = value
            children[annot.xref] = value
        return {"parents": parents, "children": children, **cls._linked_handwriting_page(page)}

    @classmethod
    def _handwriting_parent(cls, doc, annotation_id):
        if not isinstance(annotation_id, str) or not 1 <= len(annotation_id) <= 160:
            raise ValueError("Handwriting requires a parent annotation ID")
        found, scanned = [], 0
        for page in doc:
            for annot in page.annots() or []:
                scanned += 1
                if scanned > MAX_SCAN:
                    raise ValueError("Handwriting source exceeds the bounded annotation scan")
                if (annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}") == annotation_id:
                    found.append((page.number, annot.xref))
        if len(found) != 1:
            raise ValueError("Handwriting parent annotation is missing or ambiguous")
        page = doc[found[0][0]]
        parent = page.load_annot(found[0][1])
        if cls._annotation_metadata(parent).get("kind") in {"ai-feedback", "handwriting-note", "linked-handwriting", "linked-handwriting-transcript"}:
            raise ValueError("Handwriting must attach to a source annotation, not generated feedback or another handwriting note")
        return page, parent

    @classmethod
    def _handwriting_child(cls, page, parent):
        children = []
        for count, annot in enumerate(page.annots() or []):
            if count >= MAX_SCAN:
                raise ValueError("Handwriting page exceeds the bounded annotation scan")
            if cls._is_handwriting(annot) and annot.irt_xref == parent.xref:
                children.append(annot)
        if len(children) > 1:
            raise ValueError("More than one handwriting note is attached to this annotation")
        return children[0] if children else None

    def handwriting_get(self, id, annotation_id):
        with self._open_pdf(self.pdf_path(id)) as doc:
            page, parent = self._handwriting_parent(doc, annotation_id)
            child = self._handwriting_child(page, parent)
            return {"note": self._read_handwriting(page, child, full=True) if child else None,
                    "annotation": self._annotation(page, parent)}

    def handwriting_save(self, id, annotation_id, board, transcript="", transcription_source="none", expected_version=None, request_id=None):
        import pymupdf as fitz
        board = board_value(board)
        if not isinstance(transcript, str) or len(transcript) > MAX_TRANSCRIPT:
            raise ValueError("Handwriting transcript must contain at most 12000 characters")
        if transcription_source not in HEADERS or (transcription_source == "none" and transcript):
            raise ValueError("Handwriting transcription_source must describe the provided transcript")
        if expected_version is not None and (not isinstance(expected_version, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_version)):
            raise ValueError("Handwriting expected_version must be null or a SHA-256 version")
        if not isinstance(request_id, str) or not re.fullmatch(UUID_PATTERN, request_id):
            raise ValueError("Handwriting save requires a lowercase UUID request_id")
        svg = board_svg(board)
        request_hash = hashlib.sha256(canonical({"board": board, "transcript": transcript, "transcription_source": transcription_source}).encode("utf-8")).hexdigest()

        def check(doc):
            page, parent = self._handwriting_parent(doc, annotation_id)
            child = self._handwriting_child(page, parent)
            current = self._read_handwriting(page, child, full=True) if child else None
            extra = self._annotation_metadata(child) if child else {}
            if child and extra.get("request_id") == request_id:
                if extra.get("request_hash") != request_hash or current["board"] != board or current["transcript"] != transcript or current["transcription_source"] != transcription_source:
                    raise ValueError("Handwriting request_id was reused for different content")
                return page, parent, child, {"note": current, "annotation": self._annotation(page, parent), "duplicate": True}
            if (current["version"] if current else None) != expected_version:
                raise HandwritingConflict({key: value for key, value in (current or {}).items() if key != "board"} if current else None)
            return page, parent, child, None

        def operation(doc):
            page, parent, child, duplicate = check(doc)
            if duplicate:
                return duplicate
            created = child is None
            if child is None:
                # The small attachment icon sits beside its parent, independent
                # of the board's own coordinate space and page rotation.
                child = page.add_file_annot(parent.rect.tl, svg, "handwriting.svg", desc="Original handwriting", icon="Paperclip")
                doc.xref_set_key(child.xref, "NM", fitz.get_pdf_str(uuid.uuid4().hex))
                child.set_irt_xref(parent.xref)
            else:
                # Update the embedded stream through the document API, which
                # resets compression filters correctly on already-deflated
                # attachments; update_file in some PyMuPDF builds leaves a
                # mismatched filter and makes the next read undecodable.
                kind, reference = doc.xref_get_key(child.xref, "FS/EF/F")
                if kind != "xref":
                    raise ValueError("Handwriting attachment is missing its embedded stream")
                stream = int(reference.split()[0])
                doc.update_stream(stream, svg, compress=True)
                doc.xref_set_key(stream, "Params/Size", str(len(svg)))
                doc.xref_set_key(stream, "DL", str(len(svg)))
            extra = {"kind": "handwriting-note", "parent_id": annotation_id, "transcription_source": transcription_source,
                     "request_id": request_id, "request_hash": request_hash}
            timestamp = "D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ")
            child.set_info(content=HEADERS[transcription_source] + transcript, title="Reader", subject="paper-library:" + canonical(extra),
                           modDate=timestamp, **({"creationDate": timestamp} if created else {}))
            child.update()
            return {"note": self._read_handwriting(page, child, full=True), "annotation": self._annotation(page, parent)}

        with self.lock():
            # Read-only retry check avoids unnecessary PDF replacements/backups.
            with self._open_pdf(self.pdf_path(id)) as doc:
                _, _, _, duplicate = check(doc)
                if duplicate:
                    return duplicate
            return self._write_pdf(id, operation)
