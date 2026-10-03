"""Native Ink replies and a versioned transcript attached to one source annotation."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import re
import uuid

from .handwriting import HEADERS, MAX_SCAN, MAX_TRANSCRIPT, UUID_PATTERN, HandwritingConflict, canonical

LINKED_KINDS = {"linked-handwriting", "linked-handwriting-transcript"}
MAX_LINKED_OBJECTS = 64
MAX_LINKED_STROKES = 128
MAX_LINKED_POINTS = 8192
MAX_LINKED_BYTES = 256 * 1024


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


class LinkedHandwritingAccess:
    @classmethod
    def _is_linked_handwriting(cls, annot):
        return (annot.type[0], cls._annotation_metadata(annot).get("kind")) in {
            (15, "linked-handwriting"), (0, "linked-handwriting-transcript")}

    @classmethod
    def _linked_handwriting_page(cls, page):
        groups, children, scanned_bytes = {}, {}, 0
        for count, annot in enumerate(page.annots() or []):
            if count >= MAX_SCAN:
                raise ValueError("Linked handwriting exceeds the bounded page scan")
            if not cls._is_linked_handwriting(annot):
                continue
            if not annot.irt_xref:
                raise ValueError("Linked handwriting has no native parent")
            parent = page.load_annot(annot.irt_xref)
            if cls._annotation_metadata(parent).get("kind") in LINKED_KINDS | {"handwriting-note", "ai-feedback"}:
                raise ValueError("Linked handwriting must reply to a source annotation")
            parent_id = parent.info.get("id") or f"external-{page.number + 1}-{parent.xref}"
            children[annot.xref] = {"parent_id": parent_id}
            group = groups.setdefault(parent.xref, {"annotations": [], "transcript": "", "transcription_source": "none", "transcript_stale": False,
                                                       "_text": None, "_strokes": 0, "_points": 0, "_bytes": 1, "_objects": 0})
            extra = cls._annotation_metadata(annot)
            identity = annot.info.get("id") or f"external-{page.number + 1}-{annot.xref}"
            if annot.type[0] == 0:
                if group["_text"] is not None:
                    raise ValueError("More than one linked handwriting transcript is attached to this annotation")
                source = extra.get("transcription_source")
                if source not in HEADERS:
                    raise ValueError("Linked handwriting transcription source is invalid")
                content = annot.info.get("content", "")
                transcript = content[len(HEADERS[source]):] if content.startswith(HEADERS[source]) else content
                if len(transcript) > MAX_TRANSCRIPT:
                    raise ValueError("Linked handwriting transcript exceeds 12000 characters")
                scanned_bytes += len(content.encode("utf-8"))
                if scanned_bytes > 8 * 1024 * 1024:
                    raise ValueError("Linked handwriting exceeds the 8 MiB page geometry budget")
                group.update(transcript=transcript, transcription_source=source,
                             _text={"id": identity, "geometry_version": extra.get("geometry_version")})
                children[annot.xref].update(transcript=transcript, transcription_source=source)
                continue
            geometry = cls._ink_geometry(page, annot)
            value = {"id": identity, "page": page.number + 1, "paths": geometry["paths"], "width": geometry["width"], "color": annot.colors}
            # Comments edited by other PDF readers also affect the parent source.
            if annot.info.get("content"):
                value["comment"] = annot.info["content"]
            group["_objects"] += 1
            group["_strokes"] += len(value["paths"])
            group["_points"] += sum(len(stroke) for stroke in value["paths"])
            value_bytes = len(canonical(value).encode("utf-8")) + 1
            group["_bytes"] += value_bytes
            scanned_bytes += value_bytes
            if scanned_bytes > 8 * 1024 * 1024:
                raise ValueError("Linked handwriting exceeds the 8 MiB page geometry budget")
            if geometry.get("geometry_truncated") or group["_objects"] > MAX_LINKED_OBJECTS or group["_strokes"] > MAX_LINKED_STROKES or group["_points"] > MAX_LINKED_POINTS or group["_bytes"] > MAX_LINKED_BYTES:
                group["truncated"] = True
                group["annotations"] = []
            if not group.get("truncated"):
                group["annotations"].append(value)
        page_bytes = 0
        for group in groups.values():
            group["annotations"].sort(key=lambda value: value["id"])
            normalized = [{**value, "paths": [[[round(float(v), 3) for v in point] for point in stroke] for stroke in value["paths"]],
                           "width": round(float(value["width"]), 3)} for value in group["annotations"]]
            group["geometry_version"] = digest(normalized)
            text = group["_text"]
            group["transcript_stale"] = bool(text and group["transcription_source"] != "none" and
                                               (text["geometry_version"] != group["geometry_version"] or group.get("truncated")))
            group["version"] = digest({"geometry_version": group["geometry_version"], "text": text,
                                       "transcript": group["transcript"], "transcription_source": group["transcription_source"],
                                       "transcript_stale": group["transcript_stale"], "truncated": group.get("truncated", False)})
            group["annotation_count"] = group.pop("_objects")
            for key in ("_text", "_strokes", "_points", "_bytes"):
                group.pop(key)
            page_bytes += len(canonical(group).encode("utf-8"))
            if page_bytes > 8 * 1024 * 1024:
                raise ValueError("Linked handwriting exceeds the 8 MiB page geometry budget")
        return {"linked_parents": groups, "linked_children": children}

    @classmethod
    def _linked_transcript(cls, page, parent):
        matches = []
        for count, annot in enumerate(page.annots() or []):
            if count >= MAX_SCAN:
                raise ValueError("Linked handwriting exceeds the bounded page scan")
            if annot.type[0] == 0 and cls._is_linked_handwriting(annot) and annot.irt_xref == parent.xref:
                matches.append(annot)
        if len(matches) > 1:
            raise ValueError("More than one linked handwriting transcript is attached to this annotation")
        return matches[0] if matches else None

    def linked_handwriting_text(self, id, parent_id, transcript="", transcription_source="none", expected_version=None, request_id=None):
        import pymupdf as fitz
        if not isinstance(transcript, str) or len(transcript) > MAX_TRANSCRIPT:
            raise ValueError("Linked handwriting transcript must contain at most 12000 characters")
        if not isinstance(transcription_source, str) or transcription_source not in HEADERS or (transcription_source == "none" and transcript):
            raise ValueError("Linked handwriting transcription_source must describe the provided transcript")
        if not isinstance(expected_version, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_version):
            raise ValueError("Linked handwriting expected_version must be a SHA-256 version")
        if not isinstance(request_id, str) or not re.fullmatch(UUID_PATTERN, request_id):
            raise ValueError("Linked handwriting text requires a lowercase UUID request_id")
        request_hash = digest({"transcript": transcript, "transcription_source": transcription_source, "expected_version": expected_version})

        def check(doc):
            page, parent = self._handwriting_parent(doc, parent_id)
            group = self._linked_handwriting_page(page)["linked_parents"].get(parent.xref)
            if not group or not group["annotation_count"]:
                raise ValueError("Write linked handwriting before transcribing it")
            if group.get("truncated"):
                raise ValueError("LINKED_HANDWRITING_LIMIT: split the linked handwriting before transcribing")
            child = self._linked_transcript(page, parent)
            extra = self._annotation_metadata(child) if child else {}
            if child and extra.get("request_id") == request_id:
                if extra.get("request_hash") != request_hash or group["transcript"] != transcript or group["transcription_source"] != transcription_source:
                    raise ValueError("Linked handwriting request_id was reused for different content")
                if extra.get("geometry_version") != group["geometry_version"]:
                    raise HandwritingConflict(group)
                return page, parent, child, group, {"annotation": self._annotation(page, parent), "duplicate": True}
            if group["version"] != expected_version:
                raise HandwritingConflict(group)
            return page, parent, child, group, None

        def operation(doc):
            page, parent, child, group, duplicate = check(doc)
            if duplicate:
                return duplicate
            created = child is None
            if created:
                child = page.add_text_annot(parent.rect.tl, "", icon="Note")
                doc.xref_set_key(child.xref, "NM", fitz.get_pdf_str(uuid.uuid4().hex))
                child.set_irt_xref(parent.xref)
            extra = {"kind": "linked-handwriting-transcript", "transcription_source": transcription_source,
                     "geometry_version": group["geometry_version"], "request_id": request_id, "request_hash": request_hash}
            timestamp = "D:" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%SZ")
            child.set_info(content=HEADERS[transcription_source] + transcript, title="Reader", subject="paper-library:" + canonical(extra),
                           modDate=timestamp, **({"creationDate": timestamp} if created else {}))
            child.update()
            return {"annotation": self._annotation(page, parent)}

        with self.lock():
            with self._open_pdf(self.pdf_path(id)) as doc:
                *_, duplicate = check(doc)
                if duplicate:
                    return duplicate
            return self._write_pdf(id, operation)
