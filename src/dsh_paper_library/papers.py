"""Catalog metadata for the paper library.

This mixin owns the catalog itself: the SQLite schema, the revision-checked reads and writes, the
citation-key and DOI uniqueness rules, and the import/update paths that normalize supplied metadata
without inventing any. It is the base of `Library` — the PDF and annotation mixins assume a catalog
already exists — and it holds the few module-level helpers the other clusters also call, which
`core.py` binds here through `install_helpers()` to avoid a circular import.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid

# Bound by `core.py` after import, because a mixin cannot import `core` (that would be circular).
# These are the helpers the rest of the library defines once and this cluster also calls; nothing
# patches them, so a single binding after import is enough. The cap constants that a suite *does*
# patch (`MAX_ANNOTATIONS`, the reference budgets) are read live in `annotations.py` instead.
MAX_IMPORT = PaperConflictError = clamp = csl_item = now = parse_ris = None


def install_helpers(**helpers):
    module = globals()
    for name, value in helpers.items():
        if name not in module:
            raise AttributeError(f"papers does not use a helper named {name!r}")
        module[name] = value


class Papers:
    def __init__(self, directory):
        self.root = Path(directory).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ("pdfs", "backups"):
            (self.root / name).mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / "catalog.sqlite3", timeout=30)
        self.db.row_factory = sqlite3.Row
        with self.lock():
            self._initialize_schema()

    def _initialize_schema(self):
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA cache_size=-2048")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, title TEXT NOT NULL, doi TEXT, citekey TEXT NOT NULL, pdf_path TEXT, created TEXT NOT NULL, modified TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
        CREATE INDEX IF NOT EXISTS papers_citekey ON papers(citekey);
        CREATE INDEX IF NOT EXISTS papers_pdf_sha ON papers(json_extract(metadata,'$.source_pdf_sha256'));
        CREATE TABLE IF NOT EXISTS links(source TEXT, target TEXT, relation TEXT, note TEXT, provenance TEXT, created TEXT, UNIQUE(source,target,relation));
        CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS paper_archive(paper_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL);
        """)
        # Reading projects are part of the catalog so they are queryable, exportable and
        # available to the agent; the many-to-many edge lives in project_papers.
        from .projects import SCHEMA_SQL as project_schema
        self.db.executescript(project_schema)
        indexed = self.db.execute("SELECT 1 FROM sqlite_master WHERE name='paper_search'").fetchone()
        # The search index stays on disk; neither search nor list opens a PDF.
        search_expression = "new.title || ' ' || new.citekey || ' ' || coalesce(json_extract(new.metadata,'$.author'),'') || ' ' || coalesce(json_extract(new.metadata,'$.tags'),'') || ' ' || coalesce(json_extract(new.metadata,'$.abstract'),'') || ' ' || coalesce(new.doi,'') || ' ' || coalesce(json_extract(new.metadata,'$.issued'),'') || ' ' || coalesce(json_extract(new.metadata,'$.container-title'),'') || ' ' || coalesce(json_extract(new.metadata,'$.publication_dates'),'')"
        # Version 2 expands the metadata-only index once, not at each worker start.
        migrate_search = self.db.execute("PRAGMA user_version").fetchone()[0] < 2
        if migrate_search:
            self.db.executescript("DROP TRIGGER IF EXISTS papers_search_insert; DROP TRIGGER IF EXISTS papers_search_update; DROP TRIGGER IF EXISTS papers_search_delete;")
        self.db.executescript(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS paper_search USING fts5(id UNINDEXED, text, tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS papers_search_insert AFTER INSERT ON papers BEGIN
          INSERT INTO paper_search(id,text) VALUES(new.id,{search_expression});
        END;
        CREATE TRIGGER IF NOT EXISTS papers_search_update AFTER UPDATE OF metadata,title,citekey,doi ON papers BEGIN
          DELETE FROM paper_search WHERE id=old.id;
          INSERT INTO paper_search(id,text) VALUES(new.id,{search_expression});
        END;
        CREATE TRIGGER IF NOT EXISTS papers_search_delete AFTER DELETE ON papers BEGIN
          DELETE FROM paper_search WHERE id=old.id;
        END;
        """)
        if not indexed or migrate_search:
            self.db.execute("DELETE FROM paper_search")
            self.db.execute("INSERT INTO paper_search(id,text) SELECT id," + search_expression.replace("new.", "") + " FROM papers")
        if migrate_search:
            self.db.execute("PRAGMA user_version=2")
        # Version 3 adds reading projects; the tables above are created idempotently.
        if self.db.execute("PRAGMA user_version").fetchone()[0] < 3:
            self.db.execute("PRAGMA user_version=3")
        os.chmod(self.root / "catalog.sqlite3", 0o600)
        self.db.commit()
        self._recover_file_update()

    def close(self):
        self.db.close()

    @contextmanager
    def lock(self):
        with open(self.root / ".write.lock", "a") as handle:
            os.chmod(handle.name, 0o600)
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def get(self, id, include_archived=False):
        if not isinstance(include_archived, bool):
            raise ValueError("include_archived must be boolean")
        row = self.db.execute("SELECT papers.*,paper_archive.archived_at FROM papers LEFT JOIN paper_archive ON paper_archive.paper_id=papers.id WHERE papers.id=?", (id,)).fetchone()
        if not row:
            raise ValueError("Paper not found")
        if row["archived_at"] and not include_archived:
            raise ValueError("Paper is archived; restore it from trash before opening or editing")
        result = json.loads(row["metadata"])
        result.update(id=row["id"], citekey=row["citekey"], pdf=bool(row["pdf_path"]), created=row["created"], modified=row["modified"])
        result["pdf_filename"] = Path(row["pdf_path"]).name if row["pdf_path"] else None
        result.update(archived=bool(row["archived_at"]), archived_at=row["archived_at"])
        return result

    def pdf_path(self, id):
        self.get(id)  # An archived record is inspectable only through explicit metadata reads.
        row = self.db.execute("SELECT pdf_path FROM papers WHERE id=?", (id,)).fetchone()
        if not row or not row[0]:
            raise ValueError("Paper has no attached PDF")
        path = (self.root / row[0]).resolve()
        if not path.is_relative_to(self.root / "pdfs") or not path.is_file():
            raise ValueError("Managed PDF is missing or outside library")
        return path

    def list(self, query="", limit=40, offset=0, sort=None, order=None, archived=False):
        limit, offset = max(1, clamp(limit, 40, 200)), clamp(offset, 0, 10000000)
        if not isinstance(archived, bool):
            raise ValueError("archived must be boolean")
        query = str(query).strip()[:500]
        expressions = {
            "title": "papers.title COLLATE NOCASE",
            "author": "coalesce(json_extract(papers.metadata,'$.author[0].family'),json_extract(papers.metadata,'$.author[0].literal')) COLLATE NOCASE",
            "year": "coalesce(json_extract(papers.metadata,'$.issued.date-parts[0][0]'),CAST(substr(json_extract(papers.metadata,'$.publication_dates.published'),1,4) AS INTEGER))",
            "journal": "json_extract(papers.metadata,'$.container-title') COLLATE NOCASE",
            "modified": "papers.modified", "created": "papers.created", "citekey": "papers.citekey COLLATE NOCASE",
            # For multiple categories, use the latest reported year and its worst
            # quartile, so sorting never silently chooses a journal's best category.
            "jcr": "(SELECT max(json_extract(r.value,'$.quartile')) FROM json_each(papers.metadata,'$.journal_rankings') r WHERE json_extract(r.value,'$.system')='JCR' AND json_extract(r.value,'$.year')=(SELECT max(json_extract(y.value,'$.year')) FROM json_each(papers.metadata,'$.journal_rankings') y WHERE json_extract(y.value,'$.system')='JCR'))",
        }
        if sort is not None and (not isinstance(sort, str) or sort not in expressions):
            raise ValueError("Unsupported catalog sort field")
        if order is not None and (not isinstance(order, str) or order not in {"asc", "desc"}):
            raise ValueError("Catalog order must be asc or desc")
        counts = self.db.execute("SELECT count(*) AS total,count(paper_archive.paper_id) AS archived FROM papers LEFT JOIN paper_archive ON paper_archive.paper_id=papers.id").fetchone()
        archive_filter = "paper_archive.paper_id IS NOT NULL" if archived else "paper_archive.paper_id IS NULL"
        joins = " LEFT JOIN paper_archive ON paper_archive.paper_id=papers.id"
        if len(query) >= 3:
            phrase = '"' + query.replace('"', '""') + '"'
            source = "paper_search JOIN papers ON papers.id=paper_search.id" + joins
            where, args = " WHERE paper_search MATCH ? AND " + archive_filter, (phrase,)
            mode = "fts5-trigram"
            default_order = "rank,papers.id"
        else:
            # Escape wildcards: quick search is literal, including percent/underscore.
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args = (f"%{escaped}%",) * 3
            source = "papers" + joins
            where = " WHERE (title LIKE ? ESCAPE '\\' OR citekey LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\') AND " + archive_filter
            mode = "literal-short-query" if query else "catalog-list"
            default_order = "papers.modified DESC,papers.id"
        if sort is not None:
            expression = expressions[sort]
            direction = order or ("desc" if sort in {"modified", "created", "year"} else "asc")
            sorting = f"({expression}) IS NULL ASC, {expression} {direction}, papers.id ASC"
        else:
            if order is not None:
                raise ValueError("Catalog order requires a sort field")
            sorting, direction = default_order, None
        total = self.db.execute("SELECT count(*) FROM " + source + where, args).fetchone()[0]
        rows = self.db.execute("SELECT papers.id FROM " + source + where + " ORDER BY " + sorting + " LIMIT ? OFFSET ?", args + (limit, offset)).fetchall()
        return {"items": [self.get(row[0], include_archived=archived) for row in rows], "total": total,
                "limit": limit, "offset": offset, "search_mode": mode, "sort": sort or ("relevance" if len(query) >= 3 else "modified"),
                "order": direction or ("asc" if len(query) >= 3 else "desc"), "archived": archived,
                "active_count": counts["total"] - counts["archived"], "archived_count": counts["archived"]}

    def create(self, metadata=None):
        if metadata is None:
            metadata = {}
        with self.lock():
            item = csl_item(metadata)
            if "attachments" in metadata or "path" in metadata:
                raise ValueError("Manual create accepts metadata only; attach a PDF separately")
            key, doi = item.get("citekey"), item.get("DOI")
            existing = self.db.execute("SELECT id FROM papers WHERE citekey=? OR (doi=? AND doi<>'')", (key, doi)).fetchone()
            if existing:
                raise ValueError("DOI or citekey already belongs to a catalog record; edit or restore it instead")
            result, duplicate = self._upsert(item, "manual")
            if duplicate:
                raise ValueError("Metadata identifies an existing catalog record; edit or restore it instead")
            return result

    def archive(self, id):
        with self.lock():
            self.get(id, include_archived=True)
            self.db.execute("INSERT OR IGNORE INTO paper_archive(paper_id,archived_at) VALUES(?,?)", (id, now()))
            return self.get(id, include_archived=True)

    def restore(self, id):
        with self.lock():
            self.get(id, include_archived=True)
            self.db.execute("DELETE FROM paper_archive WHERE paper_id=?", (id,))
            return self.get(id)

    def _upsert(self, raw, source="manual"):
        item = csl_item(raw)
        doi, key = item.get("DOI"), item.get("citekey")
        self._check_shared_citekey(key)
        self._check_dataset_doi(doi)
        existing = self.db.execute("SELECT id FROM papers WHERE doi=? AND doi<>''", (doi,)).fetchone() if doi else None
        key_record = self.db.execute("SELECT id,doi,title FROM papers WHERE citekey=?", (key,)).fetchone() if key else None
        if key_record:
            if doi and key_record["doi"] and doi != key_record["doi"]:
                raise ValueError(f"Citation key collision for {key!r}: conflicting DOI; give the distinct papers unique citation keys before importing")
            if existing and existing["id"] != key_record["id"]:
                raise ValueError(f"Citation key collision for {key!r}: this key belongs to a different catalog record; resolve the key before importing")
            normalized_title = lambda value: " ".join(str(value).casefold().split())
            old_title, new_title = normalized_title(key_record["title"]), normalized_title(item["title"])
            if not existing and old_title != "untitled" and new_title != "untitled" and old_title != new_title:
                raise ValueError(f"Citation key collision for {key!r}: different titles without a matching DOI; resolve the key before importing")
            existing = existing or key_record
        if not existing and item.get("source_pdf_sha256"):
            existing = self.db.execute("SELECT id FROM papers WHERE json_extract(metadata,'$.source_pdf_sha256')=?", (item["source_pdf_sha256"],)).fetchone()
        if existing:
            current = self.get(existing[0])
            if source == "pdf-import" and not current["pdf"]:
                # A DOI metadata record may precede the successful PDF download.
                # Keep its bibliography and user edits, but carry the actual
                # attachment evidence into both the catalog and embedded CSL.
                merged = {key: value for key, value in current.items() if key not in {"id", "pdf", "pdf_filename", "created", "modified", "archived", "archived_at"}}
                for field in ("source_pdf_sha256", "parse", "acquisition"):
                    if item.get(field) not in (None, "", [], {}):
                        merged[field] = item[field]
                if isinstance(merged.get("parse"), dict):
                    parsed = dict(merged["parse"])
                    field_sources = dict(parsed.get("field_sources", {}))
                    old_sources = (current.get("parse") or {}).get("field_sources", {})
                    for field, value in current.items():
                        if field not in {"parse", "acquisition", "source_pdf_sha256"} and field in field_sources and value != item.get(field):
                            field_sources[field] = old_sources.get(field, "existing-catalog")
                    parsed["field_sources"] = field_sources
                    merged["parse"] = parsed
                self.db.execute("UPDATE papers SET metadata=?,modified=? WHERE id=?", (json.dumps(merged, ensure_ascii=False), now(), current["id"]))
                current = self.get(current["id"])
            return current, True
        id = uuid.uuid4().hex
        item["citekey"] = key or "paper_" + id[:10]
        item["provenance"] = {"source": source, "imported": now()}
        self.db.execute("INSERT INTO papers VALUES(?,?,?,?,?,?,?,?)", (id, json.dumps(item, ensure_ascii=False), item["title"], doi, item["citekey"], None, now(), now()))
        return self.get(id), False

    def _check_shared_citekey(self, key, paper_id=None):
        """Respect additive dataset/alias registrations without changing paper IDs."""
        if key and self.db.execute("SELECT 1 FROM sqlite_master WHERE name='resource_citekeys'").fetchone():
            row = self.db.execute("SELECT kind,owner_id FROM resource_citekeys WHERE citekey=?", (key,)).fetchone()
            if row and (row["kind"] != "paper" or (paper_id is not None and row["owner_id"] != paper_id)):
                raise ValueError("Citation key belongs to another resource or a retained citation alias")
            if row and paper_id is None and not self.db.execute("SELECT 1 FROM papers WHERE id=? AND citekey=?", (row["owner_id"], key)).fetchone():
                raise ValueError("Citation key is a retained alias; resolve the existing paper before importing")

    def _check_dataset_doi(self, doi):
        if doi and self.db.execute("SELECT 1 FROM sqlite_master WHERE name='datasets'").fetchone():
            for table in ("datasets", "dataset_releases"):
                if self.db.execute(f"SELECT 1 FROM {table} WHERE doi=?", (doi,)).fetchone():
                    raise ValueError("DOI identifies a dataset or release; do not merge it with a paper")

    def import_items(self, items=None, path=None, limit=100, offset=0, metadata=None, metadata_source=None, metadata_verified=False):
        warnings, results, imported, duplicates = [], [], 0, 0
        base = None
        if path:
            source_path = Path(path).expanduser().resolve()
            if source_path.is_dir():
                if source_path == self.root or source_path.is_relative_to(self.root):
                    raise ValueError("Choose an import directory outside the managed library")
                candidates = []
                for candidate in source_path.rglob("*"):
                    if candidate.is_file() and candidate.suffix.lower() == ".pdf" and not candidate.resolve().is_relative_to(self.root):
                        candidates.append(candidate)
                        if len(candidates) > 20000:
                            raise ValueError("Directory exceeds 20000 PDFs; select smaller subdirectories")
                candidates.sort(key=lambda value: str(value))
                limit, offset = max(1, clamp(limit, 100, 100)), clamp(offset, 0, 20000)
                for candidate in candidates[offset:offset + limit]:
                    try:
                        batch = self.import_items(path=str(candidate))
                        imported += batch["imported"]
                        duplicates += batch["duplicates"]
                        results.extend(batch["items"])
                        warnings.extend(batch["warnings"])
                    except (ValueError, OSError, RuntimeError) as exc:
                        warnings.append(f"{candidate.name}: {exc}")
                next_offset = offset + min(limit, max(0, len(candidates) - offset))
                return {"imported": imported, "duplicates": duplicates, "items": results, "warnings": warnings, "total_files": len(candidates), "offset": offset, "limit": limit, "next_offset": next_offset if next_offset < len(candidates) else None, "done": next_offset >= len(candidates)}
            if not source_path.is_file():
                raise ValueError("Import file does not exist")
            if source_path.stat().st_size > 250 * 1024 * 1024:
                raise ValueError("Import file exceeds 250 MB limit")
            base = source_path.parent
            if source_path.suffix.lower() == ".pdf":
                inspection = self.inspect_pdf(source_path)
                supplied = metadata
                metadata = inspection["metadata"]
                parse = dict(inspection["parse"])
                if supplied is not None:
                    provenance_only = isinstance(supplied, dict) and set(supplied).issubset({"acquisition"})
                    if not isinstance(supplied, dict) or (metadata_verified is not True and not provenance_only) or not metadata_source:
                        raise ValueError("PDF enrichment requires verified metadata and its explicit source")
                    protected = {"source_pdf_sha256", "parse", "provenance", "id", "pdf", "pdf_filename", "page_count"}
                    for key, value in supplied.items():
                        if key in protected or value in (None, "", [], {}):
                            continue
                        if parse["source"] == "embedded-csl" and metadata.get(key) not in (None, "", [], {}):
                            continue
                        metadata[key] = value
                        parse["field_sources"][key] = str(metadata_source)[:100]
                    if metadata_verified is True:
                        parse.update(status="verified-metadata", metadata_source=str(metadata_source)[:100], verified=True)
                        parse["needs_review"] = not (metadata.get("title") and metadata.get("author") and metadata.get("issued"))
                    else:
                        parse["acquisition_source"] = str(metadata_source)[:100]
                metadata["parse"] = {key: value for key, value in parse.items() if key != "text_excerpt"}
                with source_path.open("rb") as handle:
                    metadata.setdefault("source_pdf_sha256", hashlib.file_digest(handle, "sha256").hexdigest())
                if not metadata.get("title") or metadata["title"] == "Untitled":
                    metadata["title"] = source_path.stem
                with self.lock():
                    item, duplicate = self._upsert(metadata, "pdf-import")
                    self.db.commit()
                    if not item["pdf"]:
                        item = self._attach(item["id"], source_path)
                return {"imported": int(not duplicate), "duplicates": int(duplicate), "items": [item], "warnings": parse.get("warnings", [])}
            if source_path.stat().st_size > 32 * 1024 * 1024:
                raise ValueError("Metadata import exceeds 32 MB; split the export into batches")
            text = source_path.read_text(encoding="utf-8-sig")
            if source_path.suffix.lower() == ".ris":
                items = parse_ris(text)
            elif source_path.suffix.lower() in {".json", ".csljson"}:
                parsed = json.loads(text)
                items = parsed.get("items", [parsed]) if isinstance(parsed, dict) else parsed
            else:
                raise ValueError("Core imports PDF, CSL/Zotero JSON and RIS; BibTeX/DOI are resolved by the adapter")
        if isinstance(items, dict):
            items = items.get("items", [items])
        if not isinstance(items, list) or not items:
            raise ValueError("Import requires a non-empty item array")
        if len(items) > MAX_IMPORT:
            raise ValueError(f"Import batch exceeds {MAX_IMPORT} items; split the export")
        limit, offset = max(1, clamp(limit, 100, 100)), clamp(offset, 0, MAX_IMPORT)
        for raw in items[offset:offset + limit]:
            if isinstance(raw, dict) and raw.get("resource_kind") != "paper" and (raw.get("type") == "dataset" or raw.get("itemType") == "dataset" or raw.get("resource_kind") in {"dataset", "release"}):
                # Preserve this importer's file/batch checkpoints while routing
                # explicit dataset metadata to its own additive catalogue. Never
                # promote an existing paper row or open a dataset attachment as PDF.
                from .datasets import dispatch as dataset_dispatch
                batch = dataset_dispatch(self, {"action": "dataset_import", "items": [raw],
                    "source": "zotero-json" if "itemType" in raw else "csl-json-or-ris"})
                imported += batch["imported"]
                duplicates += batch["duplicates"]
                warnings.extend(batch["warnings"])
                warnings.extend("Dataset record skipped: " + conflict["error"] for conflict in batch["conflicts"])
                if raw.get("attachments"):
                    warnings.append("Dataset attachments were not opened or copied; connect explicit data file paths from its dataset entry")
                for result in batch["items"]:
                    if result.get("resource_kind") == "release":
                        parent = dataset_dispatch(self, {"action": "dataset_get", "id": result["dataset_id"], "include_details": False})
                        results.append({**parent, "imported_release": result})
                    else:
                        results.append(result)
                continue
            # Checkpoint one record at a time. A cancelled large migration must
            # preserve completed records and retry through their existing IDs.
            with self.lock():
                if not isinstance(raw, dict):
                    warnings.append("Skipped non-object import entry")
                    continue
                if raw.get("itemType") in {"attachment", "note", "annotation"}:
                    warnings.append("Skipped standalone Zotero attachment/note/annotation; export parent items with attached objects")
                    continue
                try:
                    item, duplicate = self._upsert(raw, "zotero-json" if "itemType" in raw else "csl-json-or-ris")
                except ValueError as exc:
                    warnings.append(f"Record skipped: {exc}")
                    continue
                self.db.commit()  # Durable identity before publishing any managed attachment.
                imported += int(not duplicate)
                duplicates += int(duplicate)
                attachments = raw.get("attachments", [])
                for attachment in attachments:
                    attachment_path = attachment.get("path") or attachment.get("localPath")
                    if not attachment_path:
                        if attachment.get("contentType") == "application/pdf":
                            warnings.append(f"{item['citekey']}: PDF attachment has no local path")
                        continue
                    attach_path = Path(attachment_path).expanduser()
                    if not attach_path.is_absolute() and base:
                        attach_path = base / attach_path
                    if attach_path.suffix.lower() != ".pdf":
                        continue
                    if item["pdf"]:
                        warnings.append(f"{item['citekey']}: additional PDF attachment skipped; one managed PDF per record")
                        continue
                    try:
                        item = self._attach(item["id"], attach_path.resolve())
                    except (ValueError, OSError, RuntimeError) as exc:
                        warnings.append(f"{item['citekey']}: attachment not imported: {exc}")
                        continue
                    for annotation in attachment.get("annotations", []):
                        try:
                            self._import_zotero_annotation(item["id"], annotation)
                        except (ValueError, TypeError, KeyError, RuntimeError) as exc:
                            warnings.append(f"{item['citekey']}: annotation skipped: {exc}")
                    if "annotations" not in attachment and "itemType" in raw:
                        warnings.append(f"{item['citekey']}: export contains no Zotero annotation objects; database-only marks require a Zotero annotated-PDF export or JSON containing positions")
                if raw.get("notes"):
                    warnings.append(f"{item['citekey']}: Zotero standalone notes are not converted into PDF annotations")
                results.append(self.get(item["id"]))
        next_offset = offset + min(limit, max(0, len(items) - offset))
        return {"imported": imported, "duplicates": duplicates, "skipped": next_offset - offset - imported - duplicates, "items": results, "warnings": warnings, "total_records": len(items), "offset": offset, "limit": limit, "next_offset": next_offset if next_offset < len(items) else None, "done": next_offset >= len(items)}

    def update(self, id, metadata, expected_modified=None):
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be an object")
        if expected_modified is not None and (not isinstance(expected_modified, str) or not expected_modified):
            raise ValueError("expected_modified must be a saved paper modification stamp")
        with self.lock():
            old = self.get(id)
            if expected_modified is not None and expected_modified != old["modified"]:
                raise PaperConflictError(old)
            protected = {"id", "pdf", "pdf_filename", "page_count", "created", "modified", "provenance", "archived", "archived_at"}
            merged = {k: v for k, v in old.items() if k not in protected}
            merged.update({k: v for k, v in metadata.items() if k not in protected})
            value = csl_item(merged)
            self._check_shared_citekey(value.get("citekey"), id)
            self._check_dataset_doi(value.get("DOI"))
            value["provenance"] = old.get("provenance", {})
            if "page_count" in old:
                value["page_count"] = old["page_count"]
            duplicate = self.db.execute("SELECT id FROM papers WHERE id<>? AND (citekey=? OR (doi=? AND doi<>''))", (id, value["citekey"], value.get("DOI"))).fetchone()
            if duplicate:
                raise ValueError("DOI or citekey already belongs to another record")
            if old.get("citekey") != value.get("citekey") and self.db.execute("SELECT 1 FROM sqlite_master WHERE name='resource_citekeys'").fetchone():
                self.db.execute("INSERT OR IGNORE INTO resource_citekeys VALUES(?,?,?)", (old["citekey"], "paper", id))
            if old["pdf"]:
                self._update_pdf_metadata(id, value)
                return self.get(id)
            self.db.execute("UPDATE papers SET metadata=?,title=?,doi=?,citekey=?,modified=? WHERE id=?", (json.dumps(value, ensure_ascii=False), value["title"], value.get("DOI"), value["citekey"], now(), id))
            return self.get(id)
