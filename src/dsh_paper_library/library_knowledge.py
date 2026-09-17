"""Bounded, local knowledge records and portable exports. Original MIT code.

SQLite owns structured records; immutable source snapshots and versioned Markdown
own their text. A durable intent makes note publication recoverable across crashes.
No discovery, background indexing, model invocation, or Zotero dependency.
"""
import hashlib
import json
import os
from pathlib import Path
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit
import uuid

MAX_TEXT = 24000
MAX_BODY = 64000
NODE_TYPES = {"topic", "concept", "question", "claim", "gap", "method", "dataset", "metric", "task", "idea", "experiment", "project", "expert", "evidence", "figure", "formula", "observation"}
ASSERTIONS = {"supports", "qualifies", "contradicts", "assumes", "defines", "proposes", "evaluates", "reports", "identifies", "motivates", "justifies"}
SOURCES = {"evidence", "figure", "formula"}
SOURCE_STATUS = {"author-stated", "reviewer-stated", "inferred"}
EDGE_TYPES = {
    "uses": {("paper", "method"), ("paper", "dataset"), ("paper", "release"), ("experiment", "method"), ("experiment", "dataset"), ("experiment", "release")},
    "produces": {("paper", "dataset"), ("paper", "release")},
    "mentions": {("paper", "dataset"), ("paper", "release")},
    "cites": {("paper", "paper"), ("paper", "dataset"), ("paper", "release")},
    "describes": {("paper", "dataset"), ("paper", "release")},
    "observed_on": {("observation", "dataset"), ("observation", "release")},
    "produced_by": {("observation", "method")},
    "measured_by": {("observation", "metric"), ("experiment", "metric")},
    "for_task": {("observation", "task")},
    "belongs_to": {(kind, "concept") for kind in ("dataset", "method", "metric", "task")},
    "part_of": {("release", "dataset"), ("question", "project"), ("gap", "project"), ("idea", "project"), ("experiment", "project")},
    "is_version_of": {("release", "dataset")},
    "derived_from": {("dataset", "dataset"), ("release", "release")},
    "answers": {("claim", "question")}, "partially_answers": {("claim", "question")},
    "limits": {("gap", "question")}, "blocks": {("gap", "question")},
    "tests": {("experiment", kind) for kind in ("claim", "idea", "question")},
    "inspired_by": {("idea", kind) for kind in ("paper", "claim", "gap", "question", "method")},
    "responds_to": {("idea", "gap"), ("idea", "question")},
    "extends": {("paper", "paper"), ("idea", "idea"), ("idea", "method")},
    "compares": {("paper", "method"), ("paper", "paper")},
    "proposes": {("paper", "method")}, "evaluates_with": {("paper", "metric")},
    "evaluates": {(kind, "task") for kind in ("paper", "experiment", "metric")},
    "reports": {("paper", "metric")}, "addresses": {("paper", "task"), ("paper", "question")},
    "defines": {("formula", "method"), ("formula", "concept")},
    "implements": {("formula", "method"), ("formula", "concept")},
    "depicts": {("figure", "method"), ("figure", "concept")},
    "explains": {("figure", "method"), ("figure", "concept")},
    "authored": {("expert", "paper")}, "member_of": {("expert", "expert")},
}


class KnowledgeConflictError(ValueError):
    code = "STATE_CONFLICT"
    status = 409

    def __init__(self, current):
        super().__init__("STATE_CONFLICT: knowledge record changed; reload before saving")
        self.current = current


def stamp():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def text(value, label, maximum=200, optional=False):
    if not isinstance(value, str) or len(value) > maximum or (not optional and not value.strip()) or "\x00" in value:
        raise ValueError(f"KNOWLEDGE_INVALID: {label} must contain 1–{maximum} characters")
    return value.strip()


def identifier(value):
    value = text(value, "id", 160)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("KNOWLEDGE_INVALID: invalid identifier")
    return value


def entity_of(library, value):
    if not isinstance(value, dict) or value.get("kind") not in {"paper", "dataset", "release"}:
        raise ValueError("KNOWLEDGE_INVALID: entity requires kind and id")
    result = {"kind": value["kind"], "id": identifier(value.get("id"))}
    resource(library, result)
    return result


def resource(library, entity):
    if entity["kind"] == "paper":
        return library.get(entity["id"])
    from .datasets import resource_get
    return resource_get(library, entity["kind"], entity["id"])


def setup(library):
    library.db.executescript("""
    CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_source_entity ON knowledge_sources(entity_kind,entity_id,created);
    CREATE TABLE IF NOT EXISTS knowledge_drafts(id TEXT PRIMARY KEY,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_draft_entity ON knowledge_drafts(entity_kind,entity_id,status,created);
    CREATE TABLE IF NOT EXISTS knowledge_notes(id TEXT PRIMARY KEY,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_note_entity ON knowledge_notes(entity_kind,entity_id,created);
    CREATE TABLE IF NOT EXISTS knowledge_note_pending(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    """)
    library.db.commit()
    base = library.root / "knowledge"
    for path in (base, base / "notes", base / "staging"):
        if path.is_symlink():
            raise ValueError("KNOWLEDGE_STORAGE: unsafe knowledge directory")
        path.mkdir(mode=0o700, exist_ok=True)
    with library.lock():
        pending = library.db.execute("SELECT payload FROM knowledge_note_pending LIMIT 17").fetchall()
        if len(pending) > 16:
            raise ValueError("KNOWLEDGE_RECOVERY: too many pending notes; inspect recovery records")
        for row in pending:
            finish_note(library, json.loads(row[0]))


def file_path(library, relative):
    path = library.root / relative
    if path.is_symlink() or not path.resolve().is_relative_to((library.root / "knowledge").resolve()):
        raise ValueError("KNOWLEDGE_STORAGE: unsafe knowledge path")
    return path


def fsync_dir(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def finish_note(library, intent):
    value = intent["value"]
    stage = file_path(library, intent["stage"])
    final = file_path(library, value["body_path"])
    row = library.db.execute("SELECT revision FROM knowledge_notes WHERE id=?", (value["id"],)).fetchone()
    current = row[0] if row else 0
    if current not in (intent["expected_revision"], value["revision"]):
        raise ValueError("KNOWLEDGE_RECOVERY_CONFLICT: note revision changed; pending text preserved")
    available = stage if stage.exists() else final
    if not available.exists() or available.stat().st_size > MAX_BODY or digest(available.read_text(encoding="utf-8")) != value["body_hash"]:
        raise ValueError("KNOWLEDGE_RECOVERY: pending note body is missing or changed")
    if stage.exists():
        os.replace(stage, final)
        fsync_dir(final.parent)
    library.db.execute("INSERT INTO knowledge_notes VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision", (value["id"], value["entity"]["kind"], value["entity"]["id"], encoded(value), value["revision"], value["created_at"]))
    library.db.execute("DELETE FROM knowledge_note_pending WHERE id=?", (value["id"],))


def get(library, kind, id):
    row = library.db.execute(f"SELECT payload FROM knowledge_{kind} WHERE id=?", (identifier(id),)).fetchone()
    if not row:
        raise ValueError(f"KNOWLEDGE_MISSING: {kind} record not found")
    result = json.loads(row[0])
    if kind == "notes":
        path = file_path(library, result["body_path"])
        if not path.is_file() or path.stat().st_size > MAX_BODY:
            raise ValueError("KNOWLEDGE_BODY_MISSING: note body missing or outside budget")
        result["body"] = path.read_text(encoding="utf-8")
        if digest(result["body"]) != result["body_hash"]:
            raise ValueError("KNOWLEDGE_BODY_CHANGED: Markdown changed outside the saved revision; preserve and reconcile")
    return result


def source_ids(library, ids):
    if not isinstance(ids, list) or not 1 <= len(ids) <= 40 or any(not isinstance(id, str) for id in ids) or len(set(ids)) != len(ids):
        raise ValueError("KNOWLEDGE_INVALID: explicitly select 1–40 unique source_ids")
    sources = [get(library, "sources", id) for id in ids]
    if sum(len(item["text"]) + len(item.get("comment", "")) for item in sources) > MAX_TEXT:
        raise ValueError("SOURCE_BUDGET_EXCEEDED: selected sources exceed 24000 characters")
    return sources


def source_put(library, request, *, trusted_provenance=None):
    entity = entity_of(library, request.get("entity"))
    kind = request.get("kind")
    if kind not in {"annotation", "official-excerpt", "user-text", "metadata", "source-note"}:
        raise ValueError("KNOWLEDGE_INVALID: unsupported source kind")
    locator = request.get("locator") or {}
    if not isinstance(locator, dict) or set(locator) - {"page", "printed_page", "section"}:
        raise ValueError("KNOWLEDGE_INVALID: invalid source locator")
    page = locator.get("page")
    if page is not None and (isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 2000):
        raise ValueError("KNOWLEDGE_INVALID: page must be known positive integer or null")
    locator = {"page": page, **{key: text(locator[key], key, 500, True) for key in ("printed_page", "section") if key in locator}}
    provenance = {}
    if kind == "annotation":
        if entity["kind"] != "paper" or not isinstance(request.get("annotation_ref"), dict):
            raise ValueError("KNOWLEDGE_INVALID: annotation source needs paper and exact annotation_ref")
        found = library.annotation_context_exact(entity["id"], [request["annotation_ref"]], max_characters=MAX_TEXT)["annotations"][0]
        content = text(found.get("text") or found.get("comment"), "saved annotation", MAX_TEXT)
        locator["page"] = found.get("page")
        provenance = {"annotation_ref": {"id": found["id"], "version": found["version"]}, "comment": found.get("comment", "")}
    else:
        content = text(request.get("text"), "source text", MAX_TEXT)
    url = text(request.get("url", ""), "source URL", 2000, True)
    if url:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("KNOWLEDGE_INVALID: source URL must be HTTP(S), without credentials")
    if kind == "official-excerpt" and not url:
        raise ValueError("KNOWLEDGE_INVALID: official excerpt requires its source URL")
    value = {"entity": entity, "kind": kind, "text": content, "locator": locator, "url": url, "title": text(request.get("title", ""), "source title", 500, True), "verification": "source-note" if kind in {"annotation", "user-text", "source-note"} else "metadata-only" if kind == "metadata" else "unverified", **provenance}
    # Only a server-side extractor can attach file-version provenance. The
    # public source_put request never forwards a client-supplied value here.
    if trusted_provenance is not None:
        value["pdf_snapshot"] = trusted_provenance
    value["content_hash"] = digest(content)
    id = "ks-" + digest(encoded(value))
    value.update(id=id, created_at=stamp())
    with library.lock():
        resource(library, entity)
        library.db.execute("INSERT OR IGNORE INTO knowledge_sources VALUES(?,?,?,?,?)", (id, entity["kind"], entity["id"], encoded(value), value["created_at"]))
    return get(library, "sources", id)


def source_check(library, request):
    """Check one saved PDF annotation on request; never rewrite its frozen source."""
    source = get(library, "sources", request.get("id"))
    result = {"id": source["id"], "checked_at": stamp(), "content_hash": source["content_hash"], "status": "snapshot-only"}
    if source["kind"] != "annotation":
        return {**result, "detail": "Fixed excerpt only; no remote or whole-library verification performed"}
    try:
        library.annotation_context_exact(source["entity"]["id"], [source["annotation_ref"]], max_characters=MAX_TEXT)
        result["status"] = "unchanged"
    except ValueError as error:
        message = str(error)
        if message.startswith("ANNOTATION_STALE:"):
            result["status"] = "changed"
        elif message.startswith("ANNOTATION_MISSING:"):
            result["status"] = "missing"
        else:
            result.update(status="unavailable", detail=message)
    return result


def validate_graph(library, value, sources):
    nodes = value.get("nodes", [])
    edges, assertions = value.get("edges", []), value.get("assertions", [])
    if not isinstance(nodes, list) or len(nodes) > 80 or not isinstance(edges, list) or len(edges) > 160 or not isinstance(assertions, list) or len(assertions) > 80:
        raise ValueError("KNOWLEDGE_INVALID: graph exceeds node/relation limits")
    normalized, identities = [], set()
    ids = {source["id"] for source in sources}
    external = {f"{item['entity']['kind']}:{item['entity']['id']}" for item in sources} | {f"{value['entity']['kind']}:{value['entity']['id']}"}
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") not in NODE_TYPES:
            raise ValueError("KNOWLEDGE_INVALID: unsupported node type")
        id = identifier(node.get("id"))
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", id):
            raise ValueError("KNOWLEDGE_INVALID: node ids use lowercase kebab-case")
        typed = f"{node['type']}:{id}"
        if typed in identities or typed in external:
            raise ValueError("KNOWLEDGE_INVALID: duplicate node identity")
        identities.add(typed)
        fields = node.get("fields", {})
        if not isinstance(fields, dict) or len(fields) > 30 or any(not isinstance(k, str) or not re.fullmatch(r"[a-z_]+", k) or not isinstance(v, (str, int, float, bool, type(None))) for k, v in fields.items()) or len(encoded(fields)) > 8000:
            raise ValueError("KNOWLEDGE_INVALID: node fields must be bounded scalar fields")
        item = {"id": id, "type": node["type"], "label": text(node.get("label"), "node label", 4000), "fields": fields, "origin": "llm" if value["origin"] == "llm" else node.get("origin", "author"), "status": "needs-review"}
        if item["origin"] not in {"llm", "author", "source"}:
            raise ValueError("KNOWLEDGE_INVALID: invalid node origin")
        if node["type"] in SOURCES:
            if node.get("source_id") not in ids:
                raise ValueError("KNOWLEDGE_INVALID: evidence requires a selected source_id")
            item["source_id"] = node["source_id"]
            source = next(item for item in sources if item["id"] == node["source_id"])
            quote = node.get("quote", source["text"])
            if not isinstance(quote, str) or not quote.strip() or quote not in source["text"]:
                raise ValueError("KNOWLEDGE_INVALID: evidence quote must be an exact source excerpt")
            item["quote"] = quote
        if node["type"] == "observation":
            item["source_node"] = text(node.get("source_node"), "observation source_node", 200)
        # Difficulty records separate what an author states from what a model
        # infers; the label is validated here and never guessed later.
        if node.get("source_status") is not None:
            if node["type"] not in {"gap", "question"}:
                raise ValueError("KNOWLEDGE_INVALID: source_status belongs to gap or question nodes")
            if node["source_status"] not in SOURCE_STATUS:
                raise ValueError("KNOWLEDGE_INVALID: unsupported source_status")
            item["source_status"] = node["source_status"]
        normalized.append(item)
    for item in normalized:
        if item["type"] == "observation" and (item["source_node"] not in identities or item["source_node"].split(":", 1)[0] not in SOURCES):
            raise ValueError("KNOWLEDGE_INVALID: observation must name a source node in this draft")
    relations = []
    seen = set()
    for category, inputs in (("edges", edges), ("assertions", assertions)):
        batch = []
        for relation in inputs:
            if not isinstance(relation, dict):
                raise ValueError("KNOWLEDGE_INVALID: relation must be an object")
            subject, object = relation.get("subject"), relation.get("object")
            if subject not in identities | external or object not in identities | external:
                raise ValueError("KNOWLEDGE_INVALID: relation endpoint not in selected graph")
            pair = (subject.split(":", 1)[0], object.split(":", 1)[0])
            name = relation.get("relation")
            if category == "assertions":
                if pair[0] not in SOURCES | {"observation"} or pair[1] not in {"claim", "gap"} or name not in ASSERTIONS:
                    raise ValueError("KNOWLEDGE_INVALID: unsupported Assertion endpoints/relation")
            elif pair not in EDGE_TYPES.get(name, set()):
                raise ValueError("KNOWLEDGE_INVALID: unsupported Edge endpoints/relation")
            signature = (category, subject, object, name)
            if signature in seen:
                raise ValueError("KNOWLEDGE_INVALID: duplicate atomic relation")
            seen.add(signature)
            item = {"id": "kr-" + digest(encoded(signature))[:24], "subject": subject, "object": object, "relation": name, "status": "needs-review", "coded_by": value["origin"], "surface": text(relation.get("surface", ""), "relation explanation", 4000, True)}
            item["coding_confidence"] = relation.get("coding_confidence", "unknown")
            item["strength"] = relation.get("strength", "unknown")
            if item["coding_confidence"] not in {"unknown", "high", "medium", "low"} or item["strength"] not in {"unknown", "strong", "moderate", "weak", "speculative"}:
                raise ValueError("KNOWLEDGE_INVALID: unsupported coding confidence or strength")
            if relation.get("source_id") is not None:
                if relation["source_id"] not in ids:
                    raise ValueError("KNOWLEDGE_INVALID: relation source not selected")
                item["source_id"] = relation["source_id"]
            batch.append(item)
        relations.append(batch)
    return normalized, *relations


def draft_put(library, request):
    entity = entity_of(library, request.get("entity"))
    selected = source_ids(library, request.get("source_ids"))
    origin = request.get("origin", "llm")
    if origin not in {"author", "llm"}:
        raise ValueError("KNOWLEDGE_INVALID: draft origin must be author or llm")
    mode = request.get("mode", "graph")
    if mode not in {"graph", "note"}:
        raise ValueError("KNOWLEDGE_INVALID: draft mode must be graph or note")
    value = {"entity": entity, "origin": origin, "mode": mode, "source_ids": [item["id"] for item in selected], "title": text(request.get("title", "知识草稿"), "title", 500), "body": text(request.get("body", ""), "draft body", MAX_BODY, mode != "note"), "model": request.get("model"), "status": "needs-review"}
    if value["model"] is not None:
        if not isinstance(value["model"], dict):
            raise ValueError("KNOWLEDGE_INVALID: model route must be an object")
        value["model"] = {key: text(value["model"][key], key, 200) for key in ("provider", "model", "reasoningEffort") if key in value["model"]}
    if len(value["body"].encode("utf-8")) > MAX_BODY:
        raise ValueError("KNOWLEDGE_INVALID: Markdown exceeds 64000 bytes")
    value["nodes"], value["edges"], value["assertions"] = validate_graph(library, {**request, **value}, selected)
    if mode == "graph" and not value["nodes"] and not value["edges"] and not value["assertions"]:
        raise ValueError("KNOWLEDGE_INVALID: graph draft contains no records")
    if len(encoded(value).encode("utf-8")) > 200000:
        raise ValueError("KNOWLEDGE_INVALID: draft exceeds persistence budget")
    # A generation's deterministic ID makes interrupted final persistence replay safe.
    request_id = text(request.get("request_id", ""), "request_id", 160, True)
    value["id"] = "kd-" + (digest(encoded([entity, request_id])) if request_id else uuid.uuid4().hex)
    fingerprint = digest(encoded(value))
    value.update(fingerprint=fingerprint, revision=1, created_at=stamp(), updated_at=stamp())
    with library.lock():
        resource(library, entity)
        row = library.db.execute("SELECT payload FROM knowledge_drafts WHERE id=?", (value["id"],)).fetchone()
        if row:
            existing = json.loads(row[0])
            if existing["fingerprint"] != fingerprint:
                raise ValueError("KNOWLEDGE_REQUEST_CONFLICT: draft request content changed")
            return existing
        library.db.execute("INSERT INTO knowledge_drafts VALUES(?,?,?,?,?,?,?)", (value["id"], entity["kind"], entity["id"], encoded(value), 1, value["status"], value["created_at"]))
    return value


def draft_review(library, request):
    if request.get("reviewed_by") != "user" or request.get("decision") not in {"accepted", "rejected"}:
        raise ValueError("KNOWLEDGE_REVIEW_REQUIRED: explicit user review is required")
    with library.lock():
        value = get(library, "drafts", request.get("id"))
        resource(library, value["entity"])
        if request.get("expected_revision") != value["revision"] or isinstance(request.get("expected_revision"), bool):
            raise KnowledgeConflictError(value)
        if value["status"] != "needs-review":
            raise ValueError("KNOWLEDGE_REVIEWED: draft already reviewed")
        value.update(status=request["decision"], reviewed_by="user", reviewed_at=stamp(), updated_at=stamp(), revision=value["revision"] + 1)
        # Review confirms the coding, not the truth of the claim or stronger source access.
        for key in ("nodes", "edges", "assertions"):
            for item in value[key]:
                item["status"] = request["decision"]
        library.db.execute("UPDATE knowledge_drafts SET payload=?,revision=?,status=? WHERE id=?", (encoded(value), value["revision"], value["status"], value["id"]))
    return value


def note_put(library, request):
    entity = entity_of(library, request.get("entity"))
    sources = source_ids(library, request.get("source_ids"))
    body = text(request.get("body"), "Markdown body", MAX_BODY)
    if len(body.encode("utf-8")) > MAX_BODY:
        raise ValueError("KNOWLEDGE_INVALID: Markdown exceeds 64000 bytes")
    id = identifier(request["id"]) if request.get("id") else "kn-" + uuid.uuid4().hex
    expected = request.get("expected_revision")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
        raise ValueError("KNOWLEDGE_INVALID: expected_revision is required")
    with library.lock():
        resource(library, entity)
        row = library.db.execute("SELECT payload FROM knowledge_notes WHERE id=?", (id,)).fetchone()
        previous = json.loads(row[0]) if row else None
        if expected != (previous["revision"] if previous else 0):
            raise KnowledgeConflictError(previous)
        if previous and previous["entity"] != entity:
            raise ValueError("KNOWLEDGE_INVALID: note entity cannot change")
        revision = expected + 1
        value = {"id": id, "entity": entity, "title": text(request.get("title"), "note title", 500), "source_ids": [item["id"] for item in sources], "revision": revision, "body_hash": digest(body), "body_path": f"knowledge/notes/{id}-r{revision}.md", "created_at": previous["created_at"] if previous else stamp(), "updated_at": stamp()}
        stage = f"knowledge/staging/{id}-{uuid.uuid4().hex}.md"
        with open(file_path(library, stage), "x", encoding="utf-8") as handle:
            os.chmod(handle.name, 0o600)
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        intent = {"expected_revision": expected, "value": value, "stage": stage}
        library.db.execute("INSERT INTO knowledge_note_pending VALUES(?,?)", (id, encoded(intent)))
        library.db.commit()  # Durable intent before publishing the body.
        finish_note(library, intent)
    return get(library, "notes", id)


def listing(library, kind, request):
    entity = entity_of(library, request.get("entity"))
    limit, offset = request.get("limit", 20), request.get("offset", 0)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100 or isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 100000:
        raise ValueError("KNOWLEDGE_INVALID: pagination outside limits")
    where, args = "entity_kind=? AND entity_id=?", [entity["kind"], entity["id"]]
    if kind == "drafts" and request.get("status"):
        if request["status"] not in {"needs-review", "accepted", "rejected"}:
            raise ValueError("KNOWLEDGE_INVALID: draft status invalid")
        where += " AND status=?"
        args.append(request["status"])
    total = library.db.execute(f"SELECT count(*) FROM knowledge_{kind} WHERE {where}", args).fetchone()[0]
    rows = library.db.execute(f"SELECT payload FROM knowledge_{kind} WHERE {where} ORDER BY created DESC,id LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
    items = []
    for row in rows:
        item = json.loads(row[0])
        if kind == "sources":
            item["text"] = item["text"][:240]
            item["preview"] = True
        if kind == "drafts":
            item["body"] = item["body"][:240]
            item["counts"] = {key: len(item.pop(key)) for key in ("nodes", "edges", "assertions")}
            item["preview"] = True
        items.append(item)
    return {"items": items, "total": total, "offset": offset, "limit": limit, "hasMore": offset + len(items) < total}


def bib_entry(kind, key, fields):
    def safe(value):
        return str(value).replace("\\", "\\textbackslash{} ").replace("{", "\\{").replace("}", "\\}").replace("\n", " ")
    return f"@{kind}{{{key},\n" + ",\n".join(f"  {name} = {{{safe(value)}}}" for name, value in fields.items() if value is not None and value != "") + "\n}\n"


def export(library, request):
    inputs = request.get("entities", [request.get("entity")])
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 20:
        raise ValueError("KNOWLEDGE_INVALID: explicitly select 1–20 entities")
    entities = [entity_of(library, value) for value in inputs]
    if len({encoded(item) for item in entities}) != len(entities):
        raise ValueError("KNOWLEDGE_INVALID: duplicate export entity")
    format = request.get("format", "library-json")
    if format not in {"library-json", "rkos-v3"}:
        raise ValueError("KNOWLEDGE_INVALID: unsupported knowledge export format")
    source_map, drafts, notes = {}, [], []
    for entity in entities:
        for kind, target in (("drafts", drafts), ("notes", notes)):
            rows = listing(library, kind, {"entity": entity, "limit": 100, **({"status": "accepted"} if kind == "drafts" else {})})
            if rows["hasMore"] or len(target) + len(rows["items"]) > 100:
                raise ValueError("KNOWLEDGE_EXPORT_BUDGET: select a smaller scope; no partial graph exported")
            for item in rows["items"]:
                full = get(library, kind, item["id"])
                target.append(full)
                for id in full["source_ids"]:
                    source_map[id] = get(library, "sources", id)
    if len(source_map) > 200 or sum(len(item["nodes"]) for item in drafts) > 200 or sum(len(item["edges"]) + len(item["assertions"]) for item in drafts) > 400:
        raise ValueError("KNOWLEDGE_EXPORT_BUDGET: selected graph exceeds bounded export")
    all_entities = {encoded(item): item for item in entities}
    all_entities.update({encoded(item["entity"]): item["entity"] for item in source_map.values()})
    resources = [{"entity": item, "metadata": resource(library, item)} for item in all_entities.values()]
    result = {"schema": "paper-library-knowledge", "schema_version": 1, "scope": "selected-knowledge-records", "format": format, "entities": entities, "resources": resources, "sources": list(source_map.values()), "drafts": drafts, "notes": notes, "losses": [], "complete": True}
    if format == "rkos-v3":
        result.update(rkos_export(result))
    if len(encoded(result).encode("utf-8")) > 4 * 1024 * 1024:
        raise ValueError("KNOWLEDGE_EXPORT_BUDGET: export exceeds 4 MiB; select a smaller scope")
    return result


def rkos_export(result):
    """Conservative v3 subset. Never masquerade a dataset source as a Paper.

    Bibliographic datasets remain separate citation records. Graph-native dataset
    provenance is retained in library JSON and reported as an unsupported mapping.
    """
    literature = [bib_entry("graph", "library-literature", {"schema_version": 3, "graph_role": "literature"})]
    research = [bib_entry("graph", "library-research", {"schema_version": 3, "graph_role": "research"})]
    authority = [bib_entry("graph", "library-authority", {"schema_version": 3, "graph_role": "authority"})]
    references, rkos_references, losses, exported = [], [], [], []
    citations, externals, citation_keys = {}, {}, set()
    for entry in result["resources"]:
        entity, metadata = entry["entity"], entry["metadata"]
        raw_key = metadata.get("citekey") or metadata.get("citation-key") or entity["id"]
        key = re.sub(r"[^A-Za-z0-9_:.+-]", "-", str(raw_key))
        if key in citation_keys:
            original_key = key
            key += "-" + digest(encoded(entity))[:10]
            losses.append({"code": "CITATION_KEY_COLLISION_REMAPPED", "entity": entity, "old": original_key, "new": key})
        citation_keys.add(key)
        citations[encoded(entity)] = key
        issued = metadata.get("issued", {}).get("date-parts", [[None]])
        fields = {"title": metadata.get("title"), "doi": metadata.get("DOI"), "url": metadata.get("URL"), "year": issued[0][0] if issued and issued[0] else None, "version": metadata.get("version"), "publisher": metadata.get("publisher")}
        authors = [author.get("literal") or ", ".join(filter(None, (author.get("family"), author.get("given")))) for author in metadata.get("author", [])]
        if authors:
            fields["author"] = " and ".join(authors)
        if metadata.get("container-title"):
            fields["journaltitle"] = metadata["container-title"]
        for source_field, target_field in (("volume", "volume"), ("issue", "number"), ("page", "pages")):
            if metadata.get(source_field):
                fields[target_field] = metadata[source_field]
        entry_type = {"article-journal": "article", "book": "book", "chapter": "incollection", "paper-conference": "inproceedings", "report": "report", "thesis": "thesis"}.get(metadata.get("type"), "misc") if entity["kind"] == "paper" else "dataset"
        bibliography = bib_entry(entry_type, key, fields)
        references.append(bibliography)
        typed_entity = f"{entity['kind']}:{entity['id']}"
        if entity["kind"] == "paper":
            rkos_references.append(bibliography)
            externals[typed_entity] = ("paper", key)
        if entity["kind"] != "paper":
            losses.append({"code": "RKOS_BIBLIOGRAPHIC_DATASET_UNSUPPORTED", "entity": entity, "detail": "Bibliographic @dataset is preserved in citations.bib; the original RKOS parser excludes it from --bib. Do not use this citation record as a graph source."})
            graph_key = "library-" + entity["kind"] + "-" + digest(entity["id"])[:24]
            externals[typed_entity] = ("dataset", graph_key)
            literature.append(bib_entry("dataset", graph_key, {"label": metadata.get("title") or entity["id"], "doi": metadata.get("DOI"), "url": metadata.get("URL"), "version": metadata.get("version"), "license": metadata.get("license")}))
            exported.append({"entity": entity, "rkos_id": graph_key, "rkos_type": "dataset", "citation_key": key})
    sources = {item["id"]: item for item in result["sources"]}
    for draft in result["drafts"]:
        remap, kept, source_nodes, pending = {}, {}, {}, []
        prefix = draft["id"].replace("_", "-").lower()
        ids = {f"{node['type']}:{node['id']}" for node in draft["nodes"]}
        def dependency(fields, name, node_type):
            value = str(fields.get(name) or "")
            typed = value if value.startswith(node_type + ":") else f"{node_type}:{value}"
            return typed if value and typed in ids else None
        for node in draft["nodes"]:
            typed = f"{node['type']}:{node['id']}"
            key = f"{prefix}-{node['id']}"
            remap[typed] = key
            kind = node["type"]
            fields, dependencies = {"label": node["label"]}, {}
            if kind in SOURCES:
                source = sources[node["source_id"]]
                if source["entity"]["kind"] != "paper":
                    losses.append({"code": "RKOS_DATASET_SOURCE_UNSUPPORTED", "node": typed, "draft_id": draft["id"], "source_id": source["id"]})
                    continue
                location = source["locator"]
                locator = location.get("section") or location.get("printed_page") or (f"PDF p. {location['page']}" if location.get("page") else "")
                if not locator or source["verification"] == "unverified":
                    losses.append({"code": "RKOS_SOURCE_VERIFICATION_OR_LOCATOR_MISSING", "node": typed, "draft_id": draft["id"]})
                    continue
                fields = {"source": citations[encoded(source["entity"])], "locator": locator, "verification": source["verification"]}
                if kind == "evidence":
                    fields.update(quote=node["quote"], evidence_type="text")
                elif kind == "figure" and node["fields"].get("number") and node["fields"].get("figure_type") in {"architecture", "pipeline", "result", "plot", "map", "conceptual", "other"}:
                    fields.update(number=node["fields"]["number"], caption=node["quote"], figure_type=node["fields"]["figure_type"])
                elif kind == "formula" and node["fields"].get("number") and node["fields"].get("latex"):
                    fields.update(number=node["fields"]["number"], latex=node["fields"]["latex"], description=node["label"])
                else:
                    losses.append({"code": "RKOS_ARTIFACT_FIELDS_REQUIRE_REVIEW", "node": typed, "draft_id": draft["id"]})
                    continue
            elif kind in {"claim", "question", "concept"}:
                raw = node["fields"]
                if kind == "claim":
                    fields = {"canonical": node["label"], "status": "accepted"}
                    dependencies["concept_id"] = dependency(raw, "concept_id", "concept")
                elif kind == "question":
                    fields = {"canonical": node["label"], "status": "accepted"}
                    dependencies["topic_id"] = dependency(raw, "topic_id", "topic")
                elif raw.get("parent_id"):
                    dependencies["parent_id"] = dependency(raw, "parent_id", "concept")
                else:
                    dependencies["topic_id"] = dependency(raw, "topic_id", "topic")
                if not all(dependencies.values()):
                    losses.append({"code": "RKOS_REQUIRED_CONTEXT_NOT_MAPPED", "node": typed, "draft_id": draft["id"], "detail": "Required hierarchy is not declared; the adapter does not invent it."})
                    continue
            elif kind == "observation":
                source_node = node["source_node"]
                fields = {"statement": node["label"], "source_type": source_node.split(":", 1)[0]}
                dependencies["source_id"] = source_node
                for name in ("value", "unit", "direction", "comparator", "baseline", "context"):
                    if name in node["fields"]:
                        fields[name] = node["fields"][name]
                if fields.get("direction") not in {None, "increase", "decrease", "no-change", "mixed", "unknown"}:
                    losses.append({"code": "RKOS_INVALID_OBSERVATION_DIRECTION", "node": typed, "draft_id": draft["id"]})
                    continue
            elif kind == "expert":
                entity_type = node["fields"].get("entity_type")
                if entity_type not in {"person", "research-group", "laboratory", "center", "institution", "consortium"}:
                    losses.append({"code": "RKOS_EXPERT_ENTITY_TYPE_REQUIRED", "node": typed, "draft_id": draft["id"]})
                    continue
                fields.update(entity_type=entity_type, status="needs-review")
            elif kind in {"gap", "idea"}:
                fields = {"statement": node["label"], "origin": node["origin"], "status": "needs-review" if node["origin"] == "llm" else "accepted", **({"created_by": node["origin"]} if kind == "idea" else {})}
            elif kind in {"experiment", "project"}:
                if node["fields"].get("status") not in {"planned", "active", "completed", "dropped"}:
                    losses.append({"code": "RKOS_LIFECYCLE_NOT_DECLARED", "node": typed, "draft_id": draft["id"]})
                    continue
                fields["status"] = node["fields"]["status"]
            else:
                for name in ("aliases", "version", "license", "coverage", "resolution", "url", "doi", "description", "unit", "direction"):
                    if name in node["fields"]:
                        fields[name] = node["fields"][name]
            pending.append((node, typed, kind, key, fields, dependencies))
        # Topological admission avoids dangling references and hierarchy cycles.
        for _ in range(len(pending) + 1):
            remaining = []
            for node, typed, kind, key, fields, dependencies in pending:
                if any(target not in kept for target in dependencies.values()):
                    remaining.append((node, typed, kind, key, fields, dependencies))
                    continue
                fields.update({name: remap[target] for name, target in dependencies.items()})
                destination = authority if kind == "expert" else research if kind in {"idea", "experiment", "project"} or kind == "gap" and node["origin"] != "source" else literature
                destination.append(bib_entry(kind, key, fields))
                kept[typed] = (kind, key)
                if node.get("source_id"):
                    source_nodes[node["source_id"]] = (kind, key)
                exported.append({"draft_id": draft["id"], "node": typed, "rkos_id": key})
            if len(remaining) == len(pending):
                break
            pending = remaining
        for _, typed, _, _, _, _ in pending:
            losses.append({"code": "RKOS_DEPENDENCY_NOT_EXPORTED", "node": typed, "draft_id": draft["id"]})
        for category in ("edges", "assertions"):
            for relation in draft[category]:
                subject = kept.get(relation["subject"]) or externals.get(relation["subject"])
                object = kept.get(relation["object"]) or externals.get(relation["object"])
                native_only = relation["relation"] in {"mentions", "describes", "is_version_of", "derived_from"} or relation["relation"] == "part_of" and relation["subject"].startswith("release:") or relation["relation"] == "cites" and not relation["object"].startswith("paper:")
                provenance = source_nodes.get(relation.get("source_id"))
                if not subject or not object or native_only or relation.get("source_id") and not provenance:
                    losses.append({"code": "RKOS_RELATION_NOT_EXPORTED", "draft_id": draft["id"], "relation_id": relation["id"], "detail": "An endpoint, native relation type, or source provenance has no v3 mapping."})
                    continue
                confidence = relation.get("coding_confidence", "unknown")
                if confidence == "unknown":
                    losses.append({"code": "RKOS_CODING_CONFIDENCE_NOT_DECLARED", "draft_id": draft["id"], "relation_id": relation["id"], "detail": "v3 requires an explicit coding confidence; the adapter does not invent one."})
                    continue
                fields = {"subject_type": subject[0], "subject_id": subject[1], "object_type": object[0], "object_id": object[1], "relation": relation["relation"], "coded_by": relation["coded_by"], "coding_confidence": confidence, "status": "accepted" if confidence == "high" else "needs-review"}
                if category == "assertions":
                    if not relation["surface"]:
                        losses.append({"code": "RKOS_ASSERTION_SURFACE_REQUIRED", "draft_id": draft["id"], "relation_id": relation["id"]})
                        continue
                    fields.update(surface=relation["surface"], strength=relation.get("strength", "unknown"))
                if provenance:
                    fields.update(provenance_type=provenance[0], provenance_id=provenance[1])
                destination = authority if relation["relation"] in {"authored", "member_of"} else research if subject[0] in {"idea", "experiment", "project"} else literature
                destination.append(bib_entry("assertion" if category == "assertions" else "edge", f"{prefix}-{relation['id']}", fields))
                exported.append({"draft_id": draft["id"], "relation": relation["id"], "rkos_id": f"{prefix}-{relation['id']}"})
                if confidence in {"medium", "low"}:
                    losses.append({"code": "RKOS_CODING_REVIEW_REQUIRED", "draft_id": draft["id"], "relation_id": relation["id"], "detail": "Native review remains in JSON; v3 requires medium/low-confidence coding to stay needs-review."})
    return {"adapter": "rkos-v3-subset-1", "files": {"citations.bib": "\n".join(references), "rkos-references.bib": "\n".join(rkos_references), "library.literature.knowledge.bib": "\n".join(literature), "library.research.knowledge.bib": "\n".join(research), "library.authority.knowledge.bib": "\n".join(authority)}, "mapping": exported, "losses": losses, "complete": not losses, "validation": {"scope": "bounded typed mapping with explicit loss report", "upstream_lint_executed": False}}


def lint_graph(value):
    """Read-only hygiene findings over one stored draft payload; never repairs.

    Write-time validation already rejects malformed graphs. Lint reports issues
    that are structurally possible yet worth human attention during review:
    unsupported claims, isolated nodes, unused evidence, duplicated relations
    and dangling endpoints (possible in older or externally produced drafts).
    """
    nodes = value.get("nodes") or []
    relations = [(kind, item) for kind in ("edges", "assertions") for item in (value.get(kind) or [])]
    identities = {f"{node.get('type')}:{node.get('id')}" for node in nodes}
    entity = value.get("entity") or {}
    external = {f"{entity.get('kind')}:{entity.get('id')}"}
    findings = []
    seen = set()
    touched, claim_supported, evidence_used = set(), set(), set()
    observation_sources = {node.get("source_node") for node in nodes if node.get("type") == "observation"}
    touched |= {source for source in observation_sources if source}
    for kind, relation in relations:
        subject, object_, name = relation.get("subject"), relation.get("object"), relation.get("relation")
        for endpoint in (subject, object_):
            if endpoint not in identities and endpoint not in external:
                findings.append({"rule": "dangling-endpoint", "severity": "error", "relation_id": relation.get("id"), "endpoint": endpoint,
                                 "message": f"关系 {relation.get('id') or ''} 的端点不在本草稿或所属条目中：{endpoint}"})
            touched.add(endpoint)
            if isinstance(endpoint, str) and endpoint.split(":", 1)[0] in SOURCES:
                evidence_used.add(endpoint)
        signature = (kind, subject, object_, name)
        if signature in seen:
            findings.append({"rule": "duplicate-relation", "severity": "warning", "relation_id": relation.get("id"),
                             "message": f"重复的关系记录：{subject} → {name} → {object_}"})
        seen.add(signature)
        if kind == "assertions" and object_:
            claim_supported.add(object_)
            if subject:
                evidence_used.add(subject)
    for node in nodes:
        typed = f"{node.get('type')}:{node.get('id')}"
        if node.get("type") in {"claim", "gap"} and typed not in claim_supported:
            findings.append({"rule": "unsupported-claim", "severity": "warning", "node": typed,
                             "message": f"主张没有任何证据或观察支撑：{node.get('label', typed)[:120]}"})
        # A labelled difficulty record must show its evidence, whichever role the
        # reviewer assigns later; an unbacked one cannot be reviewed at all.
        if node.get("source_status") and typed not in claim_supported:
            findings.append({"rule": "challenge-without-evidence", "severity": "warning", "node": typed,
                             "message": f"难点记录缺少证据断言（{node['source_status']}）：{node.get('label', typed)[:120]}"})
        if typed not in touched:
            findings.append({"rule": "isolated-node", "severity": "info", "node": typed,
                             "message": f"孤立节点，没有任何关系连接：{node.get('label', typed)[:120]}"})
        if node.get("type") in SOURCES and typed not in evidence_used and typed not in observation_sources:
            findings.append({"rule": "unused-evidence", "severity": "info", "node": typed,
                             "message": f"证据材料未被任何主张或观察引用：{node.get('label', typed)[:120]}"})
        if node.get("type") == "observation":
            source_node = node.get("source_node") or ""
            if source_node.split(":", 1)[0] not in SOURCES or source_node not in identities:
                findings.append({"rule": "observation-without-source", "severity": "warning", "node": typed,
                                 "message": f"观察缺少指向证据/图/公式的来源节点：{node.get('label', typed)[:120]}"})
    counts = {"error": 0, "warning": 0, "info": 0}
    for finding in findings:
        counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1
    return findings, counts


def draft_lint(library, request):
    """Report hygiene findings for one saved draft; a read-only review aid."""
    value = get(library, "drafts", request.get("id"))
    findings, counts = lint_graph(value)
    return {"id": value["id"], "revision": value["revision"], "status": value["status"], "mode": value.get("mode"),
            "checked_at": stamp(), "findings": findings[:200], "truncated": len(findings) > 200, "counts": counts}


def dispatch(library, request):
    setup(library)
    action = request.get("action")
    if action == "knowledge_source_put":
        return source_put(library, request)
    if action == "knowledge_source_check":
        return source_check(library, request)
    if action == "knowledge_draft_put":
        return draft_put(library, request)
    if action == "knowledge_draft_review":
        return draft_review(library, request)
    if action == "knowledge_draft_lint":
        return draft_lint(library, request)
    if action == "knowledge_note_put":
        return note_put(library, request)
    if action == "knowledge_export":
        return export(library, request)
    for prefix, kind in (("source", "sources"), ("draft", "drafts"), ("note", "notes")):
        if action == f"knowledge_{prefix}_get":
            return get(library, kind, request.get("id"))
        if action == f"knowledge_{prefix}_list":
            return listing(library, kind, request)
    raise ValueError("KNOWLEDGE_INVALID: unsupported knowledge action")
