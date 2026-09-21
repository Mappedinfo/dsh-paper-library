"""Managed-PDF writes for the paper library.

Every method here works on a *managed copy*: the catalog's own file, never an imported original.
The sequence is always the same — open, change, serialize atomically, journal the intent — so a
crash between the write and the catalog update can be recovered instead of leaving the two out of
step.

A mixin resolves class attributes through `self`, but plain module-level helpers come from *its own*
module globals, so the few it needs from `core.py` are passed in at import time through
`install_helpers()`. That indirection exists to avoid a circular import: `core` imports this module
to build `Library`, so this module cannot import `core` at module scope.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

# Filled in by `core.py` right after this module is imported: the catalog's own helpers and the
# portable export name, which stay defined there because the rest of the library uses them too.
now = managed_filename = canonical_doi = None
PORTABLE_NAME = None


def install_helpers(**helpers):
    """Bind the helpers this mixin needs. Called once by `core.py`; a missing name fails loudly
    here rather than at some later request."""
    module = globals()
    for name, value in helpers.items():
        if name not in module:
            raise AttributeError(f"pdf_write does not use a helper named {name!r}")
        module[name] = value


class PdfWrites:
    @staticmethod
    def _open_pdf(path, writing=False):
        import pymupdf as fitz
        doc = fitz.open(path)
        try:
            # Empty user-password files may auto-authenticate and clear
            # is_encrypted; their original /Encrypt trailer still governs them.
            if not doc.is_pdf or doc.needs_pass or doc.is_encrypted or doc.xref_get_key(-1, "Encrypt")[0] != "null":
                raise ValueError("Encrypted or non-PDF document is unsupported")
            if len(doc) > 2000:
                raise ValueError("PDF exceeds 2000-page limit")
            if writing:
                if doc.is_repaired:
                    raise ValueError("Repaired/malformed PDF is read-only; save a verified copy in a PDF editor first")
                for page in doc:
                    for widget in page.widgets() or []:
                        if widget.field_type == fitz.PDF_WIDGET_TYPE_SIGNATURE and widget.field_value:
                            raise ValueError("Digitally signed PDF is read-only; use an unsigned working copy")
                # Also recognize signatures that are not attached to a visible form widget.
                # Incrementally updated PDFs may leave freed xref slots whose objects no
                # longer exist; a missing object cannot hold a signature, so only genuine
                # probe results matter here.
                for xref in range(1, doc.xref_length()):
                    try:
                        signature = doc.xref_get_key(xref, "ByteRange")
                    except Exception as error:
                        if "cannot find object in xref" in str(error):
                            continue
                        raise
                    if signature[0] != "null":
                        raise ValueError("Digitally signed PDF is read-only; use an unsigned working copy")
            return doc
        except Exception:
            doc.close()
            raise

    @classmethod
    def read_portable(cls, path):
        with cls._open_pdf(path) as doc:
            return cls._portable_document(doc)

    @staticmethod
    def _portable_document(doc):
        metadata = {"title": doc.metadata.get("title") or "Untitled", "type": "article"}
        if PORTABLE_NAME in doc.embfile_names():
            embedded = doc.embfile_get(PORTABLE_NAME)
            if len(embedded) > 1024 * 1024:
                raise ValueError("Embedded metadata exceeds 1 MB")
            try:
                portable = json.loads(embedded)
            except (ValueError, UnicodeError) as exc:
                raise ValueError("Invalid embedded Paper Library metadata") from exc
            if not isinstance(portable, dict):
                raise ValueError("Invalid embedded Paper Library metadata object")
            metadata.update(portable)
        elif doc.metadata.get("keywords"):
            match = re.search(r"paper-library-citekey:([^;]+)", doc.metadata["keywords"])
            if match:
                metadata["citekey"] = match.group(1)
        return metadata

    @classmethod
    def inspect_pdf(cls, path):
        """Inspect at most three pages; identifier candidates are not verified identities."""
        import pymupdf as fitz
        path = Path(path).expanduser().resolve()
        if not path.is_file() or path.stat().st_size > 250 * 1024 * 1024:
            raise ValueError("PDF is missing or exceeds 250 MB")
        with cls._open_pdf(path) as doc:
            if doc.is_repaired:
                raise ValueError("Repaired/malformed PDF cannot be automatically imported; save a verified copy in a PDF editor first")
            embedded = PORTABLE_NAME in doc.embfile_names()
            metadata = cls._portable_document(doc)
            source = "embedded-csl" if embedded else "pdf-info"
            field_sources = {key: source for key in metadata if key not in {"parse", "provenance"} and metadata[key] not in (None, "", [], {})}
            if not embedded:
                field_sources["type"] = "default-record-type"
            if not embedded and doc.metadata.get("author"):
                metadata["author"] = [{"literal": doc.metadata["author"][:1000]}]
                field_sources["author"] = "pdf-info-author-literal"
            text_parts, title_lines, budget, evidence = [], [], 30000, []
            for number in range(min(3, doc.page_count)):
                if budget <= 0:
                    break
                page = doc[number]
                if number == 0:
                    blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES).get("blocks", [])
                    lines = []
                    for block in blocks:
                        for line in block.get("lines", []):
                            spans = line.get("spans", [])
                            content = " ".join(span.get("text", "") for span in spans).strip()
                            if content:
                                lines.append(content)
                                if len(title_lines) < 150 and line["bbox"][1] < page.rect.height * .55:
                                    title_lines.append((content, max(float(span.get("size", 0)) for span in spans), line["bbox"]))
                    text = "\n".join(lines)[:budget]
                else:
                    text = page.get_text("text")[:budget]
                text_parts.append(text)
                budget -= len(text)
                for match in re.finditer(r"\b10\.\d{4,9}/[^\s<>\"{}]+", text, re.I):
                    value = match.group().rstrip(".,;:]}>")
                    while value.endswith(")") and value.count(")") > value.count("("):
                        value = value[:-1]
                    value = canonical_doi(value)
                    if len(value) <= 512:
                        evidence.append({"kind": "doi", "value": value, "source": "first-pages-text", "page": number + 1})
                for match in re.finditer(r"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.\-]+/\d{7}(?:v\d+)?)", text, re.I):
                    evidence.append({"kind": "arxiv", "value": match.group(1), "source": "first-pages-text", "page": number + 1})
            title = str(metadata.get("title") or "").strip()
            generic = not title or title.casefold() in {"untitled", "document", "untitled document", "sample"} or title.lower().startswith("microsoft word -")
            if generic:
                candidates = [line for line in title_lines if 8 <= len(line[0]) <= 300 and not re.search(r"(?:https?://|www\.|doi\s*:|arxiv\s*:|^abstract\b|^keywords\b|^references\b|^proceedings\b)", line[0], re.I)]
                if candidates:
                    chosen = max(candidates, key=lambda line: (round(line[1], 1), -line[2][1]))
                    index = candidates.index(chosen)
                    combined = [chosen[0]]
                    bottom = chosen[2][3]
                    for line in candidates[index + 1:index + 3]:
                        if abs(line[1] - chosen[1]) <= .75 and -chosen[1] * .5 <= line[2][1] - bottom <= chosen[1] * 1.6:
                            combined.append(line[0])
                            bottom = line[2][3]
                        else:
                            break
                    metadata["title"] = " ".join(combined)[:500]
                    field_sources["title"] = "first-page-layout-heuristic"
                else:
                    metadata["title"] = path.stem
                    field_sources["title"] = "filename-fallback"
            seen, identifiers = set(), []
            for value in evidence:
                identity = (value["kind"], value["value"])
                if identity not in seen and len(identifiers) < 16:
                    identifiers.append(value)
                    seen.add(identity)
            warnings = []
            if not any(text.strip() for text in text_parts):
                warnings.append("No extractable text in the inspected pages; OCR was not run")
            if field_sources.get("title") in {"first-page-layout-heuristic", "filename-fallback"}:
                warnings.append("Title was inferred locally and needs review")
            parse = {"status": "embedded-metadata" if embedded else "local-parse", "source": source, "portable_metadata": embedded, "needs_review": not embedded or not (metadata.get("author") and metadata.get("issued")), "pages_inspected": len(text_parts), "text_characters": 30000 - budget, "text_excerpt": "\n\n".join(text_parts)[:30000], "field_sources": field_sources, "identifier_evidence": identifiers, "warnings": warnings, "limits": {"pages": 3, "text_characters": 30000}}
            return {"metadata": metadata, "doi_candidates": [value["value"] for value in identifiers if value["kind"] == "doi"][:8], "arxiv_candidates": [value["value"] for value in identifiers if value["kind"] == "arxiv"][:8], "parse": parse}

    @staticmethod
    def _embed(doc, metadata):
        portable = {k: v for k, v in metadata.items() if k not in {"id", "pdf", "pdf_filename", "created", "modified", "page_count", "archived", "archived_at"}}
        payload = json.dumps(portable, ensure_ascii=False).encode("utf-8")
        if len(payload) > 1024 * 1024:
            raise ValueError("Portable metadata exceeds 1 MB")
        if PORTABLE_NAME in doc.embfile_names():
            # Recreate only our own embedded file; PyMuPDF 1.28 embfile_upd has a bytes-buffer regression.
            doc.embfile_del(PORTABLE_NAME)
        doc.embfile_add(PORTABLE_NAME, payload, filename=PORTABLE_NAME, desc="Portable CSL bibliographic metadata")
        info = dict(doc.metadata)
        info["title"] = portable.get("title", "Untitled")
        keywords = re.sub(r"(?:^|;\s*)paper-library-citekey:[^;]*", "", info.get("keywords") or "").strip("; ")
        info["keywords"] = (keywords + "; " if keywords else "") + "paper-library-citekey:" + portable.get("citekey", "")
        doc.set_metadata(info)

    def _atomic_save(self, doc, destination, backup=True, backup_key=None):
        descriptor, tempname = tempfile.mkstemp(prefix=".pdf-write-", suffix=".pdf", dir=destination.parent)
        os.close(descriptor)
        try:
            doc.save(tempname, garbage=0, deflate=True, encryption=0)
            with self._open_pdf(tempname) as verify:
                if verify.page_count != doc.page_count:
                    raise ValueError("PDF validation failed after save")
            with open(tempname, "rb") as handle:
                os.fsync(handle.fileno())
            if backup and destination.exists():
                backup_path = self.root / "backups" / ((backup_key + ".pdf" if backup_key else destination.name) + ".bak")
                shutil.copy2(destination, backup_path)
                os.chmod(backup_path, 0o600)
            os.replace(tempname, destination)
            os.chmod(destination, 0o600)
            descriptor = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if os.path.exists(tempname):
                os.unlink(tempname)

    def _writable_pdf(self, id):
        """The file a write may modify: a synced paper is promoted to a managed copy first."""
        row = self.db.execute("SELECT pdf_path FROM papers WHERE id=?", (id,)).fetchone()
        if row and row["pdf_path"]:
            from .external import is_external_path, promote
            if is_external_path(self, row["pdf_path"]):
                return promote(self, id)
        return self.pdf_path(id)

    def _write_pdf(self, id, operation):
        destination = self._writable_pdf(id)
        with self._open_pdf(destination, writing=True) as doc:
            result = operation(doc)
            self._atomic_save(doc, destination, backup_key=id)
        self.db.execute("UPDATE papers SET modified=? WHERE id=?", (now(), id))
        return result

    def _managed_destination(self, item, id, current=None):
        for full in (False, True):
            candidate = self.root / "pdfs" / managed_filename(item, id, full_id=full)
            relative = str(candidate.relative_to(self.root))
            owner = self.db.execute("SELECT id FROM papers WHERE pdf_path=?", (relative,)).fetchone()
            if (not owner or owner["id"] == id) and (not candidate.exists() or candidate == current):
                return candidate
        raise ValueError("Managed PDF filename already exists; no existing file was overwritten")

    def _file_update_journal(self, value):
        path = self.root / ".pending-file-update.json"
        descriptor, temporary = tempfile.mkstemp(prefix=".file-journal-", dir=self.root)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _recover_file_update(self):
        journal = self.root / ".pending-file-update.json"
        if not journal.exists():
            return
        value = json.loads(journal.read_text(encoding="utf-8"))
        new = (self.root / value["new_path"]).resolve()
        row = self.db.execute("SELECT pdf_path,metadata FROM papers WHERE id=?", (value["id"],)).fetchone()
        if not row:
            raise ValueError("Rename journal paper is missing; preserve both PDFs for recovery")
        if not new.is_relative_to(self.root / "pdfs"):
            raise ValueError("Invalid managed PDF journal; no files were removed")
        if value.get("kind") == "attach":
            if row["pdf_path"] not in (None, value["new_path"]):
                raise ValueError("Attachment journal conflicts with catalog; preserve files for recovery")
            if new.is_file() and not row["pdf_path"]:
                with self._open_pdf(new) as doc:
                    metadata = json.loads(row["metadata"])
                    metadata["page_count"] = doc.page_count
                self.db.execute("UPDATE papers SET pdf_path=?,metadata=?,modified=? WHERE id=?", (value["new_path"], json.dumps(metadata, ensure_ascii=False), now(), value["id"]))
                self.db.commit()
            elif row["pdf_path"] and not new.is_file():
                raise ValueError("Catalog points to missing attached PDF; preserve journal for recovery")
            journal.unlink()
            return
        old = (self.root / value["old_path"]).resolve()
        if old == new or not old.is_relative_to(self.root / "pdfs"):
            raise ValueError("Invalid managed PDF rename journal; no files were removed")
        active = (self.root / row["pdf_path"]).resolve() if row["pdf_path"] else None
        if active == old and old.is_file():
            new.unlink(missing_ok=True)
        elif active == new and new.is_file():
            old.unlink(missing_ok=True)
        else:
            raise ValueError("Rename state is inconsistent; preserve both PDFs for recovery")
        journal.unlink()

    def _update_pdf_metadata(self, id, value):
        current = self._writable_pdf(id)
        destination = self._managed_destination(value, id, current)
        if destination == current:
            self._write_pdf(id, lambda doc: self._embed(doc, value))
            self.db.execute("UPDATE papers SET metadata=?,title=?,doi=?,citekey=?,modified=? WHERE id=?", (json.dumps(value, ensure_ascii=False), value["title"], value.get("DOI"), value["citekey"], now(), id))
            return
        relative = str(destination.relative_to(self.root))
        self._file_update_journal({"id": id, "old_path": str(current.relative_to(self.root)), "new_path": relative})
        try:
            with self._open_pdf(current, writing=True) as doc:
                self._embed(doc, value)
                self._atomic_save(doc, destination, backup=False)
            backup = self.root / "backups" / (id + ".pdf.bak")
            shutil.copy2(current, backup)
            os.chmod(backup, 0o600)
            self.db.execute("UPDATE papers SET metadata=?,title=?,doi=?,citekey=?,pdf_path=?,modified=? WHERE id=?", (json.dumps(value, ensure_ascii=False), value["title"], value.get("DOI"), value["citekey"], relative, now(), id))
            # The catalog switch commits while BOTH copies exist. Recovery uses
            # that authoritative path to remove only the superseded copy.
            self.db.commit()
        except BaseException:
            self.db.rollback()
            self._recover_file_update()
            raise
        self._recover_file_update()

    def _attach(self, id, path):
        path = Path(path).expanduser().resolve()
        if not path.is_file() or path.stat().st_size > 250 * 1024 * 1024:
            raise ValueError("PDF is missing or exceeds 250 MB")
        item = self.get(id)
        if item["pdf"]:
            raise ValueError("Paper already has a managed PDF; replacement is not automatic")
        destination = self._managed_destination(item, id)
        self._file_update_journal({"kind": "attach", "id": id, "new_path": str(destination.relative_to(self.root))})
        try:
            with self._open_pdf(path, writing=True) as doc:
                item["page_count"] = doc.page_count
                self._embed(doc, item)
                self._atomic_save(doc, destination, backup=False)
            stored = {k: v for k, v in item.items() if k not in {"id", "pdf", "pdf_filename", "created", "modified", "archived", "archived_at"}}
            self.db.execute("UPDATE papers SET metadata=?,pdf_path=?,modified=? WHERE id=?", (json.dumps(stored, ensure_ascii=False), str(destination.relative_to(self.root)), now(), id))
            self.db.commit()
        except BaseException:
            self.db.rollback()
            self._recover_file_update()
            raise
        self._recover_file_update()
        return self.get(id)

    def attach(self, id, path):
        with self.lock():
            return self._attach(id, path)
