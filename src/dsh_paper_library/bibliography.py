"""Canonical bibliography build: audit report plus atomic on-disk exports.

The audit reads catalog metadata and stats managed PDF paths only. It never
opens a PDF, never invents missing values, and never writes catalog rows.
Exports are written under the library's own exports/ directory with atomic
replacement, alongside managed PDFs but never over them.
"""
import json
import os
from datetime import datetime, timezone

MAX_RECORDS = 10000
MAX_LISTED = 200
MAX_AUDIT_BYTES = 4 * 1024 * 1024
MAX_BIB_BYTES = 24 * 1024 * 1024


def _now():
    return datetime.now(timezone.utc).isoformat()


def _doi(value):
    if not isinstance(value, str):
        return ""
    value = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"):
        if value.startswith(prefix):
            value = value[len(prefix):]
    return value.strip()


def _year(metadata):
    parts = (metadata.get("issued") or {}).get("date-parts") if isinstance(metadata.get("issued"), dict) else None
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0] and isinstance(parts[0][0], int):
        return parts[0][0]
    return None


def _cap(values):
    return {"count": len(values), "ids": sorted(values)[:MAX_LISTED], "truncated": len(values) > MAX_LISTED}


def audit(library, request):
    """Factual identity audit over active papers; archived records stay excluded."""
    del request  # The audit is a fixed-shape read; no options exist to forge.
    rows = library.db.execute(
        "SELECT id,citekey,title,doi,metadata,pdf_path FROM papers "
        "WHERE id NOT IN (SELECT paper_id FROM paper_archive) ORDER BY citekey,id"
    ).fetchall()
    if len(rows) > MAX_RECORDS:
        raise ValueError("Bibliography audit exceeds 10000 records; audit a subset export instead")
    records, missing = [], {"citekey": [], "doi": [], "title": [], "author": [], "year": []}
    pdf_present, pdf_missing = [], []
    lookup_by_url, manual_only = [], []
    for row in rows:
        metadata = json.loads(row["metadata"])
        doi = _doi(row["doi"] or metadata.get("DOI"))
        url = metadata.get("URL")
        has_url = isinstance(url, str) and bool(url.strip())
        authors = metadata.get("author")
        has_author = isinstance(authors, list) and bool(authors)
        has_title = bool(isinstance(row["title"], str) and row["title"].strip())
        year = _year(metadata)
        if not row["citekey"]:
            missing["citekey"].append(row["id"])
        if not doi:
            missing["doi"].append(row["id"])
            # Records without a DOI are still actionable when a landing URL
            # remains; without either identifier only manual entry helps.
            (lookup_by_url if has_url else manual_only).append(row["id"])
        if not has_title:
            missing["title"].append(row["id"])
        if not has_author:
            missing["author"].append(row["id"])
        if year is None:
            missing["year"].append(row["id"])
        pdf_exists = False
        if row["pdf_path"]:
            candidate = (library.root / row["pdf_path"]).resolve()
            pdf_exists = candidate.is_relative_to(library.root / "pdfs") and candidate.is_file()
            (pdf_present if pdf_exists else pdf_missing).append(row["id"])
        records.append({
            "id": row["id"], "citekey": row["citekey"], "doi": doi or None,
            "title": row["title"][:120], "year": year, "authors": len(authors) if has_author else 0,
            "has_pdf": bool(row["pdf_path"]), "pdf_file_present": pdf_exists, "has_url": has_url,
        })
    citekeys, dois = {}, {}
    for record in records:
        if record["citekey"]:
            citekeys.setdefault(record["citekey"], []).append(record)
        if record["doi"]:
            dois.setdefault(record["doi"], []).append(record)
    citekey_conflicts = [
        {"citekey": key, "records": [{"id": item["id"], "doi": item["doi"], "title": item["title"]} for item in items[:10]]}
        for key, items in sorted(citekeys.items()) if len(items) > 1
    ][:MAX_LISTED]
    doi_duplicates = [
        {"doi": key, "ids": sorted(item["id"] for item in items)}
        for key, items in sorted(dois.items()) if len(items) > 1
    ][:MAX_LISTED]
    return {
        "schema": "paper-library-bibliography-audit.v1",
        "generated_at": _now(),
        "totals": {
            "records": len(records),
            "with_pdf": len(pdf_present) + len(pdf_missing),
            "pdf_files_present": len(pdf_present),
            "pdf_files_missing": len(pdf_missing),
        },
        "missing": {field: _cap(ids) for field, ids in missing.items()},
        "actionable": {
            "lookup_by_url": _cap(lookup_by_url),
            "manual_only": _cap(manual_only),
        },
        "citekey_conflicts": citekey_conflicts,
        "citekey_conflict_count": len(citekey_conflicts),
        "doi_duplicates": doi_duplicates,
        "doi_duplicate_count": len(doi_duplicates),
        "pdf_missing": _cap(pdf_missing),
        "records": records,
        "limits": {"records": MAX_RECORDS, "listed_ids": MAX_LISTED},
    }


def _atomic_write(path, data):
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_export(library, request):
    """Persist references.bib and bibliography.audit.json under exports/ atomically."""
    bib_text = request.get("bib_text")
    report = request.get("audit")
    if not isinstance(bib_text, str) or not bib_text.strip():
        raise ValueError("bib_text must be non-empty text")
    bib_bytes = bib_text.encode()
    if len(bib_bytes) > MAX_BIB_BYTES:
        raise ValueError("Bibliography text exceeds the 24 MiB export budget")
    if not isinstance(report, dict) or report.get("schema") != "paper-library-bibliography-audit.v1":
        raise ValueError("audit must be a bibliography audit object")
    audit_bytes = (json.dumps(report, ensure_ascii=False, indent=1, allow_nan=False) + "\n").encode()
    if len(audit_bytes) > MAX_AUDIT_BYTES:
        raise ValueError("Bibliography audit exceeds the 4 MiB export budget")
    exports = library.root / "exports"
    exports.mkdir(exist_ok=True, mode=0o700)
    bib_path = exports / "references.bib"
    audit_path = exports / "bibliography.audit.json"
    _atomic_write(bib_path, bib_bytes)
    _atomic_write(audit_path, audit_bytes)
    return {
        "bib_path": str(bib_path), "bib_bytes": len(bib_bytes),
        "audit_path": str(audit_path), "audit_bytes": len(audit_bytes),
    }
