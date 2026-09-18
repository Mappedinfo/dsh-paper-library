"""Additive, disk-backed dataset catalogue. No source files open during browsing.

Dataset families, releases and file registrations have separate stable identities.
All writes use the existing catalogue lock and compare-and-swap revisions.
"""
from datetime import datetime
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit
import uuid

from .core import bounded_text, canonical_doi, csl_item, now

RELATIONS = {"mentions", "cites", "uses", "produces", "describes"}
STATUSES = {"needs-review", "accepted", "rejected"}
MAX_CHILDREN = 2000
MAX_METADATA = 256 * 1024


class DatasetConflictError(ValueError):
    code = "STATE_CONFLICT"
    status = 409

    def __init__(self, current):
        super().__init__("Resource changed; reload the current revision before saving")
        self.current = current


def ensure_schema(library):
    with library.lock():
        library.db.executescript("""
        CREATE TABLE IF NOT EXISTS datasets(
          id TEXT PRIMARY KEY, metadata TEXT NOT NULL, title TEXT NOT NULL,
          doi TEXT, citekey TEXT NOT NULL, revision INTEGER NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL, archived_at TEXT);
        CREATE INDEX IF NOT EXISTS datasets_doi ON datasets(doi);
        CREATE TABLE IF NOT EXISTS dataset_releases(
          id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, metadata TEXT NOT NULL,
          doi TEXT, citekey TEXT NOT NULL, revision INTEGER NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS dataset_releases_owner ON dataset_releases(dataset_id,id);
        CREATE INDEX IF NOT EXISTS dataset_releases_doi ON dataset_releases(doi);
        CREATE TABLE IF NOT EXISTS resource_citekeys(
          citekey TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dataset_external_ids(
          source TEXT NOT NULL,external_id TEXT NOT NULL,kind TEXT NOT NULL,
          owner_id TEXT NOT NULL,PRIMARY KEY(source,external_id,kind));
        CREATE TABLE IF NOT EXISTS resource_catalog_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO resource_catalog_clock VALUES(1,0);
        CREATE TABLE IF NOT EXISTS dataset_links(
          id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, dataset_id TEXT NOT NULL,
          release_id TEXT, relation TEXT NOT NULL, role TEXT NOT NULL,
          payload TEXT NOT NULL, revision INTEGER NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS dataset_links_paper ON dataset_links(paper_id,id);
        CREATE INDEX IF NOT EXISTS dataset_links_dataset ON dataset_links(dataset_id,id);
        CREATE TABLE IF NOT EXISTS dataset_assets(
          id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, release_id TEXT,
          payload TEXT NOT NULL, revision INTEGER NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS dataset_assets_owner ON dataset_assets(dataset_id,id);
        CREATE TABLE IF NOT EXISTS dataset_graph_mappings(
          paper_id TEXT NOT NULL,node_id TEXT NOT NULL,dataset_id TEXT NOT NULL,
          revision INTEGER NOT NULL,created TEXT NOT NULL,modified TEXT NOT NULL,
          PRIMARY KEY(paper_id,node_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS dataset_search USING fts5(id UNINDEXED,text,tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS dataset_search_insert AFTER INSERT ON datasets BEGIN
          INSERT INTO dataset_search(id,text) VALUES(new.id,new.title||' '||new.citekey||' '||new.metadata);
        END;
        CREATE TRIGGER IF NOT EXISTS dataset_search_update AFTER UPDATE OF metadata,title,citekey ON datasets BEGIN
          DELETE FROM dataset_search WHERE id=old.id;
          INSERT INTO dataset_search(id,text) VALUES(new.id,new.title||' '||new.citekey||' '||new.metadata);
        END;
        """)
        for table in ("papers", "paper_archive", "datasets", "dataset_releases"):
            for event in ("INSERT", "UPDATE", "DELETE"):
                library.db.execute(f"CREATE TRIGGER IF NOT EXISTS resource_clock_{table}_{event} AFTER {event} ON {table} BEGIN UPDATE resource_catalog_clock SET revision=revision+1 WHERE id=1; END")


def _json(value, name="Metadata", maximum=MAX_METADATA):
    stack = [(value, 0)]
    count = 0
    while stack:
        item, depth = stack.pop()
        count += 1
        if count > 10000 or depth > 16:
            raise ValueError(f"{name} structure exceeds the budget")
        if isinstance(item, dict):
            if len(item) > 10000 - count:
                raise ValueError(f"{name} structure exceeds the budget")
            if any(not isinstance(key, str) for key in item):
                raise ValueError(f"{name} object keys must be text")
            stack.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            if len(item) > 10000 - count:
                raise ValueError(f"{name} structure exceeds the budget")
            stack.extend((child, depth + 1) for child in item)
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (ValueError, TypeError, RecursionError) as exc:
        raise ValueError(f"{name} must be finite JSON") from exc
    if len(text.encode()) > maximum:
        raise ValueError(f"{name} exceeds {maximum} bytes")
    return text


def _paging(request, default=20, maximum=100):
    values = []
    for field, fallback, upper in (("offset", 0, 10000000), ("limit", default, maximum)):
        value = request.get(field, fallback)
        if isinstance(value, bool) or not isinstance(value, int) or value < (1 if field == "limit" else 0):
            raise ValueError(f"{field} must be a positive integer" if field == "limit" else "offset must be nonnegative")
        values.append(min(value, upper))
    return values


def _page(items, total, offset, limit):
    return {"items": items, "total": total, "offset": offset, "limit": limit,
            "truncated": offset + len(items) < total,
            "next_offset": offset + len(items) if offset + len(items) < total else None}


def _id(prefix):
    return prefix + "_" + uuid.uuid4().hex


def _cas(request, current):
    expected = request.get("expected_revision")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
        raise ValueError("expected_revision is required: 0 to create, current integer revision to update")
    if expected != (current["revision"] if current else 0):
        raise DatasetConflictError(current)


def _dataset(library, id, include_archived=False):
    row = library.db.execute("SELECT * FROM datasets WHERE id=?", (id,)).fetchone()
    if not row:
        raise ValueError("Dataset not found")
    if row["archived_at"] and not include_archived:
        raise ValueError("Dataset is archived; restore it before editing or opening")
    value = json.loads(row["metadata"])
    value.update(id=id, resource_kind="dataset", type="dataset", title=row["title"],
                 citekey=row["citekey"], revision=row["revision"], created=row["created"],
                 modified=row["modified"], archived=bool(row["archived_at"]), archived_at=row["archived_at"], pdf=False)
    return value


def _release(library, id, dataset_id=None, include_archived=False):
    row = library.db.execute("SELECT * FROM dataset_releases WHERE id=?", (id,)).fetchone()
    if not row or dataset_id and row["dataset_id"] != dataset_id:
        raise ValueError("Dataset release not found in this dataset")
    _dataset(library, row["dataset_id"], include_archived)
    value = dict(row)
    value.update(metadata=json.loads(row["metadata"]), release_id=id, resource_kind="release")
    return value


def _metadata(raw, old=None, *, family=True):
    if not isinstance(raw, dict):
        raise ValueError("metadata must be an object")
    forbidden = {"id", "resource_kind", "pdf", "pdf_path", "path", "attachments", "revision", "created", "modified", "archived", "archived_at", "releases", "assets", "links"}
    if set(raw) & forbidden:
        raise ValueError("Metadata cannot include identity, files or runtime fields")
    _json(raw)
    merged = {**(old or {}), **raw}
    if "published" in merged:
        from .core import publication_date
        published = publication_date(merged["published"], "published")
        merged["issued"] = {"date-parts": [[int(part) for part in published.split("-")]]}
        merged["publication_dates"] = {**merged.get("publication_dates", {}), "published": published}
        merged.pop("published")
    if family:
        merged["title"] = bounded_text(merged.get("title"), "Dataset title", 2000, required=True)
    elif "title" in merged:
        merged["title"] = bounded_text(merged["title"], "Release title", 2000, required=True)
    value = csl_item(merged)
    if not family and "title" not in merged:
        value.pop("title", None)
    value["type"] = "dataset"
    for field in ("version", "license", "publisher", "repository", "access_status", "registration_level"):
        if field in value:
            value[field] = bounded_text(value[field], field, 2000)
    for field in ("URL", "landing_url"):
        if value.get(field):
            _url(value[field])
    if "aliases" in value:
        if not isinstance(value["aliases"], list) or len(value["aliases"]) > 50:
            raise ValueError("aliases must contain at most 50 names")
        value["aliases"] = [bounded_text(alias, "Alias", 500, True) for alias in value["aliases"]]
    if value.get("registration_level") and value["registration_level"] not in {"L0", "L1", "L2"}:
        raise ValueError("registration_level must be L0, L1 or L2")
    _json(value)
    return value


def _url(value):
    value = bounded_text(value, "Source URL", 4000, required=True)
    parsed = urlsplit(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Source URL must be HTTP(S), without embedded credentials")
    return value


def _reserve_key(library, key, kind, id):
    key = bounded_text(key, "Citation key", 200, required=True)
    if not re.fullmatch(r"[^\s,{}\\%#\"'=()]+", key):
        raise ValueError("Citation key contains unsupported bibliography characters")
    paper = library.db.execute("SELECT id FROM papers WHERE citekey=?", (key,)).fetchone()
    row = library.db.execute("SELECT kind,owner_id FROM resource_citekeys WHERE citekey=?", (key,)).fetchone()
    if paper or row and (row["kind"], row["owner_id"]) != (kind, id):
        raise ValueError("Citation key belongs to another resource or retained alias")
    library.db.execute("INSERT OR IGNORE INTO resource_citekeys VALUES(?,?,?)", (key, kind, id))
    return key


def _doi(library, doi, kind, id):
    if not doi:
        return
    for table, resource in (("papers", "paper"), ("datasets", "dataset"), ("dataset_releases", "release")):
        row = library.db.execute(f"SELECT id FROM {table} WHERE doi=?", (doi,)).fetchone()
        if row and (resource, row["id"]) != (kind, id):
            raise ValueError("DOI already identifies another resource; select that record or correct the family/release/paper DOI (no automatic merge)")


def put_dataset(library, request, *, locked=False):
    with nullcontext() if locked else library.lock():
        current = _dataset(library, request["id"]) if request.get("id") else None
        _cas(request, current)
        id = current["id"] if current else _id("dataset")
        old = json.loads(library.db.execute("SELECT metadata FROM datasets WHERE id=?", (id,)).fetchone()[0]) if current else {}
        value = _metadata(request.get("metadata"), old)
        value["citekey"] = _reserve_key(library, value.get("citekey") or "dataset_" + id[-10:], "dataset", id)
        _doi(library, value.get("DOI"), "dataset", id)
        stamp = now()
        library.db.execute("INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,title=excluded.title,doi=excluded.doi,citekey=excluded.citekey,revision=excluded.revision,modified=excluded.modified",
                           (id, _json(value), value["title"], value.get("DOI"), value["citekey"], (current["revision"] if current else 0) + 1, current["created"] if current else stamp, stamp))
        return _dataset(library, id)


def put_release(library, request, *, locked=False):
    with nullcontext() if locked else library.lock():
        dataset_id = request.get("dataset_id") or request.get("id")
        _dataset(library, dataset_id)
        current = _release(library, request["release_id"], dataset_id) if request.get("release_id") else None
        _cas(request, current)
        if not current and library.db.execute("SELECT count(*) FROM dataset_releases WHERE dataset_id=?", (dataset_id,)).fetchone()[0] >= MAX_CHILDREN:
            raise ValueError("Dataset reached its 2000-release limit")
        id = current["id"] if current else _id("release")
        value = _metadata(request.get("metadata"), current["metadata"] if current else {}, family=False)
        if not any(value.get(key) for key in ("version", "DOI", "title", "issued")):
            raise ValueError("A release requires a supplied version, DOI, title or publication date; unknown version uses the dataset itself")
        value["citekey"] = _reserve_key(library, value.get("citekey") or "release_" + id[-10:], "release", id)
        _doi(library, value.get("DOI"), "release", id)
        stamp = now()
        library.db.execute("INSERT INTO dataset_releases VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,doi=excluded.doi,citekey=excluded.citekey,revision=excluded.revision,modified=excluded.modified",
                           (id, dataset_id, _json(value), value.get("DOI"), value["citekey"], (current["revision"] if current else 0) + 1, current["created"] if current else stamp, stamp))
        return _release(library, id)


def cite_dataset(library, id, release_id=None):
    dataset = _dataset(library, id)
    if release_id:
        release = _release(library, release_id, id)
        # Family authors/title/publisher can describe every release; its DOI,
        # publication date and version cannot stand in for a release's identity.
        value = {key: value for key, value in dataset.items() if key not in {"DOI", "URL", "version", "issued", "publication_dates", "citekey"}}
        value.update(release["metadata"])
        value["id"] = release_id
    else:
        value = dict(dataset)
    for field in ("resource_kind", "revision", "created", "modified", "archived", "archived_at", "pdf"):
        value.pop(field, None)
    value["type"] = "dataset"
    warnings = [f"Missing supplied citation field: {field}" for field in ("author", "issued", "publisher") if not value.get(field)]
    if not value.get("DOI") and not value.get("URL"):
        warnings.append("No DOI or source URL supplied")
    return {"item": value, "warnings": warnings}


def resource_get(library, kind, id, include_archived=False):
    # Knowledge transactions call this after their schema setup while holding
    # the shared lock. Avoid acquiring a second flock for existing tables.
    if not library.db.execute("SELECT 1 FROM sqlite_master WHERE name='datasets'").fetchone():
        ensure_schema(library)
    if kind == "paper":
        return {**library.get(id, include_archived), "resource_kind": "paper"}
    if kind == "dataset":
        return _dataset(library, id, include_archived)
    if kind == "release":
        release = _release(library, id, include_archived=include_archived)
        if include_archived:
            return {**release["metadata"], "id": id, "dataset_id": release["dataset_id"], "resource_kind": "release", "revision": release["revision"]}
        return {**cite_dataset(library, release["dataset_id"], id)["item"], "dataset_id": release["dataset_id"], "resource_kind": "release", "revision": release["revision"]}
    raise ValueError("Unknown resource kind")


def list_resources(library, request):
    kind = request.get("kind", "all")
    if kind not in {"all", "paper", "dataset"}:
        raise ValueError("kind must be all, paper or dataset")
    archived = request.get("archived", False)
    if not isinstance(archived, bool):
        raise ValueError("archived must be boolean")
    offset, limit = _paging(request, 40, 200)
    query = bounded_text(request.get("query", ""), "Query", 500)
    sort = request.get("sort") or "modified"
    order = request.get("order") or ("desc" if sort in {"modified", "created", "year"} else "asc")
    expressions = {"title": "title COLLATE NOCASE", "author": "coalesce(json_extract(metadata,'$.author[0].family'),json_extract(metadata,'$.author[0].literal')) COLLATE NOCASE",
                   "year": "json_extract(metadata,'$.issued.date-parts[0][0]')", "journal": "json_extract(metadata,'$.container-title') COLLATE NOCASE",
                   "publisher": "json_extract(metadata,'$.publisher') COLLATE NOCASE", "modified": "modified", "created": "created", "citekey": "citekey COLLATE NOCASE", "kind": "kind"}
    expressions["jcr"] = "(SELECT max(json_extract(r.value,'$.quartile')) FROM json_each(metadata,'$.journal_rankings') r WHERE json_extract(r.value,'$.system')='JCR' AND json_extract(r.value,'$.year')=(SELECT max(json_extract(y.value,'$.year')) FROM json_each(metadata,'$.journal_rankings') y WHERE json_extract(y.value,'$.system')='JCR'))"
    if sort not in expressions or order not in {"asc", "desc"}:
        raise ValueError("Unsupported resource sort/order")
    union = "SELECT p.id,'paper' AS kind,p.title,p.metadata,p.citekey,p.created,p.modified,a.archived_at FROM papers p LEFT JOIN paper_archive a ON a.paper_id=p.id UNION ALL SELECT id,'dataset',title,metadata,citekey,created,modified,archived_at FROM datasets"
    where, args = ["archived_at IS " + ("NOT NULL" if archived else "NULL")], []
    # A reading project is a filter over the same catalog: its members are papers, and the
    # filter composes with search, sorting and paging like any other scope.
    project = request.get("project")
    if project is not None:
        if not isinstance(project, str) or not project or len(project) > 60:
            raise ValueError("project must be a project id")
        if library.db.execute("SELECT 1 FROM projects WHERE id=?", (project,)).fetchone() is None:
            raise ValueError(f"阅读项目 {project} 不存在")
        where.append("kind='paper' AND id IN (SELECT paper_id FROM project_papers WHERE project_id=?)")
        args.append(project)
    if kind != "all":
        where.append("kind=?"); args.append(kind)
    if query:
        if len(query) >= 3:
            phrase = '"' + query.replace('"', '""') + '"'
            where.append("((kind='paper' AND id IN (SELECT id FROM paper_search WHERE paper_search MATCH ?)) OR (kind='dataset' AND id IN (SELECT id FROM dataset_search WHERE dataset_search MATCH ?)) OR id IN (SELECT owner_id FROM resource_citekeys WHERE citekey=? AND kind IN ('paper','dataset')))")
            args.extend((phrase, phrase, query))
        else:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("(title LIKE ? ESCAPE '\\' OR citekey LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\' OR id IN (SELECT owner_id FROM resource_citekeys WHERE citekey=? AND kind IN ('paper','dataset')))")
            args.extend([f"%{escaped}%"] * 3)
            args.append(query)
    prefix = "WITH resources AS (" + union + ") "
    clause = " FROM resources WHERE " + " AND ".join(where)
    total = library.db.execute(prefix + "SELECT count(*)" + clause, args).fetchone()[0]
    expr = expressions[sort]
    rows = library.db.execute(prefix + "SELECT id,kind" + clause + f" ORDER BY ({expr}) IS NULL,{expr} {order},id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    items = [{**library.get(row["id"], archived), "resource_kind": "paper"} if row["kind"] == "paper" else _dataset(library, row["id"], archived) for row in rows]
    counts = library.db.execute(prefix + "SELECT kind,count(*) AS total,sum(archived_at IS NULL) AS active FROM resources GROUP BY kind").fetchall()
    values = {row["kind"]: {"total": row["total"], "active": row["active"], "archived": row["total"] - row["active"]} for row in counts}
    return {**_page(items, total, offset, limit), "kind": kind, "archived": archived, "counts": values,
            "active_count": sum(row["active"] for row in values.values()), "archived_count": sum(row["archived"] for row in values.values()), "sort": sort, "order": order, "search_mode": "fts5-trigram" if len(query) >= 3 else "literal-short-query"}


def _evidence(value):
    values = value if isinstance(value, list) else [value or {}]
    if len(values) > 20:
        raise ValueError("At most 20 evidence records per relation")
    result = []
    allowed = {"source_kind", "source_id", "source_uri", "source", "quote", "note", "page", "printed_page", "section", "annotation_id", "annotation_version", "source_hash", "verified_at", "evidence_level"}
    for evidence in values:
        if not isinstance(evidence, dict) or set(evidence) - allowed:
            raise ValueError("Unsupported evidence fields")
        clean = {}
        for key, value in evidence.items():
            if value is None:
                clean[key] = None; continue
            if key == "page":
                if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100000:
                    raise ValueError("Evidence page must be known positive integer or null")
                clean[key] = value
            else:
                clean[key] = bounded_text(value, key, 8000 if key == "quote" else 2000)
                if key in {"source_hash", "annotation_version"} and clean[key] and not re.fullmatch(r"[a-f0-9]{64}", clean[key]):
                    raise ValueError(f"{key} must be a SHA-256 digest")
        clean.setdefault("page", None)
        result.append(clean)
    _json(result, "Relation evidence", 192 * 1024)
    return result


def _link(row):
    value = {**dict(row), **json.loads(row["payload"])}
    value.pop("payload", None)
    return value


def put_link(library, request):
    with library.lock():
        row = library.db.execute("SELECT * FROM dataset_links WHERE id=?", (request.get("id"),)).fetchone() if request.get("id") else None
        if request.get("id") and not row:
            raise ValueError("Dataset relation not found")
        current = _link(row) if row else None
        _cas(request, current)
        value = {**(current or {}), **request}
        paper = library.get(value.get("paper_id"))
        dataset = _dataset(library, value.get("dataset_id"))
        release_id = value.get("release_id") or None
        if release_id:
            _release(library, release_id, dataset["id"])
        relation = value.get("relation")
        if relation not in RELATIONS:
            raise ValueError("Unsupported paper/dataset relation")
        origin = value.get("origin", "user")
        if origin not in {"user", "ai"}:
            raise ValueError("origin must be user or ai")
        review = value.get("review_status", "needs-review")
        if review not in STATUSES:
            raise ValueError("Unsupported relation review status")
        if origin == "ai":
            review = "needs-review"
        evidence = _evidence(value.get("evidence"))
        if review == "accepted" and not any(e.get("quote") or e.get("source") or e.get("source_uri") or e.get("annotation_id") for e in evidence):
            raise ValueError("Accepted relations require a supplied source; unsourced records remain needs-review")
        role = bounded_text(value.get("role", ""), "Use role", 200)
        payload = {"scope": bounded_text(value.get("scope", ""), "Use scope", 4000), "evidence": evidence,
                   "review_status": review, "origin": current.get("origin", origin) if current else origin,
                   "reviewed_by": "user" if origin == "user" and review == "accepted" else None}
        if not current and library.db.execute("SELECT count(*) FROM dataset_links WHERE dataset_id=?", (dataset["id"],)).fetchone()[0] >= 10000:
            raise ValueError("Dataset relation storage limit reached")
        id, stamp = current["id"] if current else _id("datasetlink"), now()
        library.db.execute("INSERT INTO dataset_links VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET paper_id=excluded.paper_id,dataset_id=excluded.dataset_id,release_id=excluded.release_id,relation=excluded.relation,role=excluded.role,payload=excluded.payload,revision=excluded.revision,modified=excluded.modified",
                           (id, paper["id"], dataset["id"], release_id, relation, role, _json(payload), (current["revision"] if current else 0) + 1, current["created"] if current else stamp, stamp))
        return _link(library.db.execute("SELECT * FROM dataset_links WHERE id=?", (id,)).fetchone())


def list_links(library, request):
    offset, limit = _paging(request)
    paper_id, dataset_id = request.get("paper_id"), request.get("dataset_id")
    if not paper_id and not dataset_id:
        raise ValueError("Choose a paper_id or dataset_id for bounded relation lookup")
    include_archived = request.get("include_archived", False)
    if not isinstance(include_archived, bool):
        raise ValueError("include_archived must be boolean")
    if paper_id:
        library.get(paper_id, include_archived)
    if dataset_id:
        _dataset(library, dataset_id, include_archived)
    where, args = [], []
    for field, value in (("paper_id", paper_id), ("dataset_id", dataset_id), ("release_id", request.get("release_id")), ("relation", request.get("relation"))):
        if value:
            where.append("l." + field + "=?"); args.append(value)
    if request.get("review_status"):
        where.append("json_extract(l.payload,'$.review_status')=?"); args.append(request["review_status"])
    if not include_archived:
        where.extend(["d.archived_at IS NULL", "a.paper_id IS NULL"])
    clause = " FROM dataset_links l JOIN datasets d ON d.id=l.dataset_id JOIN papers p ON p.id=l.paper_id LEFT JOIN paper_archive a ON a.paper_id=p.id WHERE " + " AND ".join(where)
    counts = library.db.execute("SELECT count(*),count(DISTINCT l.paper_id),count(DISTINCT CASE WHEN l.relation='uses' AND json_extract(l.payload,'$.review_status')='accepted' THEN l.paper_id END)" + clause, args).fetchone()
    rows = library.db.execute("SELECT l.*,p.title AS paper_title,d.title AS dataset_title,(d.archived_at IS NOT NULL OR a.paper_id IS NOT NULL) AS endpoint_archived" + clause + " ORDER BY l.created DESC,l.id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    return {**_page([_link(row) for row in rows], counts[0], offset, limit), "paper_count": counts[1], "accepted_use_paper_count": counts[2], "count_scope": "matching stored relations, distinct papers; not total scholarly usage"}


def _fingerprint(path):
    details = path.stat()
    if not stat.S_ISREG(details.st_mode):
        raise ValueError("Only existing regular files can be linked; directories and devices are unsupported")
    return {"size": details.st_size, "mtime_ns": details.st_mtime_ns, "device": details.st_dev, "inode": details.st_ino}


def _asset(row):
    value = {**dict(row), **json.loads(row["payload"])}
    value.pop("payload", None)
    return value


def put_asset(library, request):
    with library.lock():
        dataset_id = request.get("dataset_id") or request.get("id")
        _dataset(library, dataset_id)
        row = library.db.execute("SELECT * FROM dataset_assets WHERE id=? AND dataset_id=?", (request.get("asset_id"), dataset_id)).fetchone() if request.get("asset_id") else None
        if request.get("asset_id") and not row:
            raise ValueError("Asset not found in this dataset")
        current = _asset(row) if row else None
        _cas(request, current)
        value = {**(current or {}), **request}
        release_id = value.get("release_id") or None
        if release_id:
            _release(library, release_id, dataset_id)
        path, url = value.get("path"), value.get("url")
        if bool(path) == bool(url):
            raise ValueError("Asset requires exactly one existing local path or HTTP(S) URL")
        payload = {"label": bounded_text(value.get("label", ""), "Asset label", 1000),
                   "format": bounded_text(value.get("format", ""), "Asset format", 30), "storage": "linked",
                   "acquired_at": value.get("acquired_at"), "file_sha256": None}
        if payload["acquired_at"] is not None:
            payload["acquired_at"] = bounded_text(payload["acquired_at"], "Acquisition time", 40)
            try:
                datetime.fromisoformat(payload["acquired_at"].replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("acquired_at must be an ISO date/time") from exc
        if path:
            path = Path(bounded_text(path, "Local asset path", 4000, True)).expanduser()
            if not path.is_absolute():
                raise ValueError("Asset path must be absolute")
            path = path.resolve(strict=True)
            payload.update(path=str(path), fingerprint=_fingerprint(path))
            payload["label"] = payload["label"] or path.name
            payload["format"] = (payload["format"] or path.suffix.lstrip(".")).lower()
        else:
            payload.update(url=_url(url))
            payload["label"] = payload["label"] or urlsplit(url).path.rsplit("/", 1)[-1] or "External data"
        if not current and library.db.execute("SELECT count(*) FROM dataset_assets WHERE dataset_id=?", (dataset_id,)).fetchone()[0] >= MAX_CHILDREN:
            raise ValueError("Dataset reached its 2000-asset limit")
        id, stamp = current["id"] if current else _id("asset"), now()
        library.db.execute("INSERT INTO dataset_assets VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET release_id=excluded.release_id,payload=excluded.payload,revision=excluded.revision,modified=excluded.modified",
                           (id, dataset_id, release_id, _json(payload), (current["revision"] if current else 0) + 1, current["created"] if current else stamp, stamp))
        return _asset(library.db.execute("SELECT * FROM dataset_assets WHERE id=?", (id,)).fetchone())


def list_children(library, request, kind):
    id = request.get("dataset_id") or request.get("id")
    _dataset(library, id, request.get("include_archived", False))
    offset, limit = _paging(request)
    table = "dataset_releases" if kind == "release" else "dataset_assets"
    clause, args = " WHERE dataset_id=?", [id]
    if request.get("release_id") and kind == "asset":
        clause += " AND release_id=?"; args.append(request["release_id"])
    total = library.db.execute("SELECT count(*) FROM " + table + clause, args).fetchone()[0]
    rows = library.db.execute("SELECT * FROM " + table + clause + " ORDER BY created DESC,id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    items = [_release(library, row["id"], id, request.get("include_archived", False)) if kind == "release" else _asset(row) for row in rows]
    return _page(items, total, offset, limit)


def import_datasets(library, request):
    """Import citations without inferring a dataset family from title or version.

    Plain CSL/BibLaTeX dataset records describe exactly the supplied citable
    object. Explicit Library JSON release records alone restore family bindings.
    Every item checkpoints its identity and external mapping in one transaction.
    """
    items = request.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 2000:
        raise ValueError("Dataset import requires 1–2000 metadata items; at most 100 are processed per call")
    offset, limit = _paging(request, 100)
    source = bounded_text(request.get("source", "csl-json"), "Import source namespace", 1000, True)
    result = {"items": [], "imported": 0, "duplicates": 0, "skipped": 0, "conflicts": [], "warnings": [], "total_records": len(items), "offset": offset, "limit": limit}
    for index, raw in enumerate(items[offset:offset + limit], offset):
        external_id = None
        try:
            if not isinstance(raw, dict):
                raise ValueError("Import entry must be an object")
            kind = raw.get("resource_kind", "dataset")
            if kind not in {"dataset", "release"}:
                raise ValueError("Dataset import does not accept paper entries")
            candidate = raw.get("metadata", raw)
            if not isinstance(candidate, dict) or candidate.get("type", "dataset") != "dataset" or candidate.get("itemType", "dataset") != "dataset":
                raise ValueError("Import entry must be CSL/Zotero dataset metadata")
            external_id = raw.get("external_id") or raw.get("id") or candidate.get("id")
            if not external_id and "itemType" in candidate:
                external_id = candidate.get("key") or candidate.get("itemKey")
            if external_id is not None:
                external_id = bounded_text(str(external_id), "External record ID", 500, True)
            runtime = {"resource_kind", "external_id", "dataset_id", "release_id", "metadata", "revision", "created", "modified", "archived", "archived_at", "pdf", "pdf_filename"}
            metadata = csl_item({key: value for key, value in candidate.items() if key not in runtime})
            if not candidate.get("title"):
                metadata.pop("title", None)
            metadata.pop("provenance", None)
            if kind == "release" and not candidate.get("citekey") and not candidate.get("citation-key") and not candidate.get("citationKey"):
                # A Library UUID is an external ID, not a bibliography label.
                metadata.pop("citekey", None)
            if external_id:
                previous_ids = metadata.get("external_ids", [])
                if not isinstance(previous_ids, list) or len(previous_ids) > 50:
                    raise ValueError("Too many external identity mappings")
                supplied = {"source": source, "id": external_id}
                metadata["external_ids"] = [*previous_ids, supplied] if supplied not in previous_ids else previous_ids
            with library.lock():
                doi, key = metadata.get("DOI"), metadata.get("citekey")
                key_identity = library.db.execute("SELECT kind,owner_id FROM resource_citekeys WHERE citekey=?", (key,)).fetchone() if key else None
                known_release = library.db.execute("SELECT * FROM dataset_releases WHERE doi=? AND doi<>''", (doi,)).fetchone() if doi else None
                if not known_release and key_identity and key_identity["kind"] == "release":
                    known_release = library.db.execute("SELECT * FROM dataset_releases WHERE id=?", (key_identity["owner_id"],)).fetchone()
                # BibLaTeX cannot carry the private family binding, but an exact
                # identifier can still resolve an already registered release.
                # In a new library no family is inferred from title/version.
                if "resource_kind" not in raw and known_release:
                    kind = "release"
                table = "datasets" if kind == "dataset" else "dataset_releases"
                mapped = library.db.execute("SELECT owner_id FROM dataset_external_ids WHERE source=? AND external_id=? AND kind=?", (source, external_id, kind)).fetchone() if external_id else None
                existing = library.db.execute(f"SELECT * FROM {table} WHERE id=?", (mapped[0],)).fetchone() if mapped else None
                doi_row = library.db.execute(f"SELECT * FROM {table} WHERE doi=? AND doi<>''", (doi,)).fetchone() if doi else None
                key_row = library.db.execute(f"SELECT * FROM {table} WHERE citekey=?", (key,)).fetchone() if key else None
                alias_row = library.db.execute(f"SELECT * FROM {table} WHERE id=?", (key_identity["owner_id"],)).fetchone() if key_identity and key_identity["kind"] == kind else None
                candidates = [row for row in (existing, doi_row, key_row, alias_row) if row]
                if len({row["id"] for row in candidates}) > 1:
                    raise ValueError("External ID, DOI and citekey identify different existing records")
                existing = candidates[0] if candidates else None
                dataset_id = (raw.get("dataset_id") or (known_release["dataset_id"] if known_release and "resource_kind" not in raw else None)) if kind == "release" else None
                if kind == "release":
                    if not isinstance(dataset_id, str) or not dataset_id:
                        raise ValueError("Explicit release import requires dataset_id; version alone does not identify a family")
                    parent = library.db.execute("SELECT owner_id FROM dataset_external_ids WHERE source=? AND external_id=? AND kind='dataset'", (source, dataset_id)).fetchone()
                    dataset_id = parent[0] if parent else dataset_id
                    _dataset(library, dataset_id)
                if existing:
                    current = _dataset(library, existing["id"]) if kind == "dataset" else _release(library, existing["id"], dataset_id)
                    _doi(library, doi, kind, existing["id"])
                    previous = json.loads(existing["metadata"])
                    if doi and previous.get("DOI") and doi != previous["DOI"]:
                        raise ValueError("Conflicting DOI; existing record preserved")
                    if metadata.get("version") and previous.get("version") and metadata["version"] != previous["version"]:
                        raise ValueError("Different release versions cannot be silently merged")
                    if not doi and metadata.get("title") and previous.get("title") and " ".join(metadata["title"].casefold().split()) != " ".join(previous["title"].casefold().split()):
                        raise ValueError("Same citation/external key but different titles; resolve identity before importing")
                    # A caller-supplied distinct citation key remains reserved as
                    # an alias of this exact identity, never assigned elsewhere.
                    if key:
                        _reserve_key(library, key, kind, existing["id"])
                    result["duplicates"] += 1
                    result["warnings"].append(f"Entry {index + 1}: existing metadata retained")
                else:
                    current = put_dataset(library, {"metadata": metadata, "expected_revision": 0}, locked=True) if kind == "dataset" else put_release(library, {"id": dataset_id, "metadata": metadata, "expected_revision": 0}, locked=True)
                    result["imported"] += 1
                    if kind == "dataset" and metadata.get("version"):
                        result["warnings"].append(f"Entry {index + 1}: supplied version retained on this citable dataset; no family relationship inferred")
                if external_id:
                    library.db.execute("INSERT OR IGNORE INTO dataset_external_ids VALUES(?,?,?,?)", (source, external_id, kind, current["id"]))
                result["items"].append(current)
        except (ValueError, TypeError, KeyError) as exc:
            result["skipped"] += 1
            result["conflicts"].append({"index": index, "external_id": external_id, "error": str(exc)[:2000]})
    next_offset = min(len(items), offset + limit)
    result.update(next_offset=next_offset if next_offset < len(items) else None, done=next_offset >= len(items))
    return result


def export_resources(library, request):
    if not library.db.in_transaction:
        library.db.execute("BEGIN")
    revision = library.db.execute("SELECT revision FROM resource_catalog_clock WHERE id=1").fetchone()[0]
    if "expected_catalog_revision" in request and (isinstance(request["expected_catalog_revision"], bool) or request["expected_catalog_revision"] != revision):
        raise DatasetConflictError({"catalog_revision": revision})
    kind = request.get("kind", "all")
    if kind not in {"all", "paper", "dataset"}:
        raise ValueError("Export kind must be all, paper or dataset")
    include_releases = request.get("include_releases", True)
    if not isinstance(include_releases, bool):
        raise ValueError("include_releases must be boolean")
    offset, limit = _paging(request, 100)
    sources = []
    if kind in {"all", "paper"}:
        sources.append("SELECT p.id,'paper' AS kind,p.citekey,0 AS position FROM papers p LEFT JOIN paper_archive a ON a.paper_id=p.id WHERE a.paper_id IS NULL")
    if kind in {"all", "dataset"}:
        sources.append("SELECT id,'dataset' AS kind,citekey,1 AS position FROM datasets WHERE archived_at IS NULL")
        if include_releases:
            sources.append("SELECT r.id,'release' AS kind,r.citekey,2 AS position FROM dataset_releases r JOIN datasets d ON d.id=r.dataset_id WHERE d.archived_at IS NULL")
    union = " UNION ALL ".join(sources)
    total = library.db.execute("SELECT count(*) FROM (" + union + ")").fetchone()[0]
    rows = library.db.execute("SELECT * FROM (" + union + ") ORDER BY position,citekey,id LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    items, budget = [], 4 * 1024 * 1024 - 8192
    for row in rows:
        if row["kind"] == "paper":
            value = library.get(row["id"])
        elif row["kind"] == "dataset":
            value = cite_dataset(library, row["id"])["item"]
        else:
            release = _release(library, row["id"])
            value = {**cite_dataset(library, release["dataset_id"], row["id"])["item"], "dataset_id": release["dataset_id"]}
        value = {key: item for key, item in value.items() if key not in {"pdf", "pdf_filename", "revision", "archived", "archived_at", "created", "modified", "page_count"}}
        value.update(resource_kind=row["kind"], external_id=row["id"])
        _json(value, maximum=MAX_METADATA * 2 + 8192)
        cost = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode()) + 2
        if cost > budget:
            break
        budget -= cost
        items.append(value)
    result = _page(items, total, offset, limit)
    result.update(done=result["next_offset"] is None, schema="paper-library-citations.v1", include_releases=include_releases,
                  catalog_revision=revision,
                  warnings=["Citation metadata export only: files, knowledge records and relationships are not a full library backup", "BibLaTeX does not preserve Library family/release mappings; CSL JSON retains explicit resource_kind and dataset_id"],
                  limits={"records": 100, "payload_bytes": 4 * 1024 * 1024})
    return result


def dispatch(library, request):
    ensure_schema(library)
    action = request.get("action")
    if action == "resource_list":
        return list_resources(library, request)
    if action == "resource_export":
        return export_resources(library, request)
    if action == "resource_get":
        return resource_get(library, request.get("kind", "paper"), request.get("id"), request.get("include_archived", False))
    if action == "dataset_put":
        return put_dataset(library, request)
    if action == "dataset_import":
        return import_datasets(library, request)
    if action == "dataset_get":
        value = _dataset(library, request.get("id"), request.get("include_archived", False))
        if request.get("include_details", True):
            for key, kind in (("releases", "release"), ("assets", "asset")):
                result = list_children(library, {"id": value["id"], "include_archived": value["archived"]}, kind)
                value.update({key: result["items"], key + "_total": result["total"], key + "_truncated": result["truncated"]})
            result = list_links(library, {"dataset_id": value["id"], "include_archived": value["archived"]})
            value.update(links=result["items"], links_total=result["total"], links_truncated=result["truncated"], accepted_use_paper_count=result["accepted_use_paper_count"])
        return value
    if action in {"dataset_archive", "dataset_restore"}:
        with library.lock():
            value = _dataset(library, request.get("id"), True)
            _cas(request, value)
            archived = action == "dataset_archive"
            if value["archived"] != archived:
                library.db.execute("UPDATE datasets SET archived_at=?,revision=revision+1,modified=? WHERE id=?", (now() if archived else None, now(), value["id"]))
            return _dataset(library, value["id"], True)
    if action == "dataset_release_put":
        return put_release(library, request)
    if action == "dataset_release_get":
        return _release(library, request.get("release_id") or request.get("id"), include_archived=request.get("include_archived", False))
    if action in {"dataset_release_list", "dataset_asset_list"}:
        return list_children(library, request, "release" if action == "dataset_release_list" else "asset")
    if action == "dataset_cite":
        return cite_dataset(library, request.get("id"), request.get("release_id"))
    if action == "dataset_link_put":
        return put_link(library, request)
    if action == "dataset_link_list":
        return list_links(library, request)
    if action == "dataset_link_delete":
        with library.lock():
            row = library.db.execute("SELECT * FROM dataset_links WHERE id=?", (request.get("id"),)).fetchone()
            if not row:
                raise ValueError("Dataset relation not found")
            value = _link(row)
            _dataset(library, value["dataset_id"]); library.get(value["paper_id"])
            _cas(request, value)
            library.db.execute("DELETE FROM dataset_links WHERE id=?", (value["id"],))
            return {"id": value["id"], "deleted": True}
    if action == "dataset_asset_put":
        return put_asset(library, request)
    if action == "dataset_graph_promote":
        from .knowledge_graph import _schema
        _schema(library)
        with library.lock():
            paper_id, node_id = request.get("paper_id"), request.get("node_id")
            library.get(paper_id)
            node = library.db.execute("SELECT * FROM knowledge_nodes WHERE id=? AND paper_id=? AND kind='dataset'", (node_id, paper_id)).fetchone()
            if not node:
                raise ValueError("Choose a reader dataset node from this paper")
            existing = library.db.execute("SELECT * FROM dataset_graph_mappings WHERE paper_id=? AND node_id=?", (paper_id, node_id)).fetchone()
            _cas(request, dict(existing) if existing else None)
            if request.get("dataset_id"):
                dataset = _dataset(library, request["dataset_id"])
            else:
                if existing:
                    raise ValueError("Mapping already exists; choose an explicit dataset to relink")
                metadata = {"title": node["label"], "description": node["description"], **request.get("metadata", {})}
                dataset = put_dataset(library, {"metadata": metadata, "expected_revision": 0}, locked=True)
            stamp = now()
            library.db.execute("INSERT INTO dataset_graph_mappings VALUES(?,?,?,?,?,?) ON CONFLICT(paper_id,node_id) DO UPDATE SET dataset_id=excluded.dataset_id,revision=excluded.revision,modified=excluded.modified", (paper_id, node_id, dataset["id"], existing["revision"] + 1 if existing else 1, existing["created"] if existing else stamp, stamp))
            mapping = dict(library.db.execute("SELECT * FROM dataset_graph_mappings WHERE paper_id=? AND node_id=?", (paper_id, node_id)).fetchone())
            return {"dataset": dataset, "mapping": mapping, "node_preserved": True, "usage_inferred": False}
    if action == "dataset_asset_preview":
        id = request.get("dataset_id") or request.get("id")
        _dataset(library, id)
        row = library.db.execute("SELECT * FROM dataset_assets WHERE id=? AND dataset_id=?", (request.get("asset_id"), id)).fetchone()
        if not row:
            raise ValueError("Asset not found in this dataset")
        from .dataset_preview import preview
        return preview(_asset(row))
    raise ValueError("Unknown dataset operation")
