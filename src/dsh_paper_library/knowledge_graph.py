"""Bounded, on-demand literature graph with explicit reader-authored evidence.

PDFs are never opened here. Metadata projections are read-only; scientific
relationships are assertions saved by the reader, not inferred from co-occurrence.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone

NODE_TYPES = ("method", "dataset", "claim", "evidence", "concept", "author", "institution")
RELATIONS = ("supports", "contradicts", "uses", "evaluates", "derived_from", "explains", "extends", "cites", "related", "authored_by", "affiliated_with", "published_by")
MAX_NODES = 200
MAX_EDGES = 400
MAX_PER_PAPER = 2000


def _now():
    return datetime.now(timezone.utc).isoformat()


def _schema(library):
    # DDL is transactional under the same catalog write lock as other mutations.
    with library.lock():
        library.db.executescript("""
        CREATE TABLE IF NOT EXISTS knowledge_nodes(
          id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, kind TEXT NOT NULL,
          label TEXT NOT NULL, description TEXT NOT NULL, evidence TEXT NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS knowledge_nodes_paper ON knowledge_nodes(paper_id,id);
        CREATE TABLE IF NOT EXISTS knowledge_edges(
          id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, source TEXT NOT NULL,
          target TEXT NOT NULL, relation TEXT NOT NULL, evidence TEXT NOT NULL,
          created TEXT NOT NULL, modified TEXT NOT NULL,
          UNIQUE(paper_id,source,target,relation));
        CREATE INDEX IF NOT EXISTS knowledge_edges_paper ON knowledge_edges(paper_id,id);
        """)


def _text(value, name, maximum, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{name} must be text")
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise ValueError(f"{name} requires {'1–' if required else '0–'}{maximum} characters")
    return value


def _evidence(value):
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("Evidence must be an object")
    page = value.get("page")
    if page == "":
        page = None
    if page is not None and (isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 100000):
        raise ValueError("Evidence page must be a positive integer or null")
    return {"page": page, "quote": _text(value.get("quote"), "Evidence quote", 4000),
            "note": _text(value.get("note"), "Evidence note", 2000),
            "source": _text(value.get("source"), "Evidence source", 1000),
            "annotation_id": _text(value.get("annotation_id"), "Annotation identifier", 200)}


def _identifier(prefix, *parts):
    return prefix + ":" + hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


def _node(row):
    return {"id": row["id"], "paper_id": row["paper_id"], "type": row["kind"], "label": row["label"],
            "description": row["description"], "evidence": json.loads(row["evidence"]),
            "provenance": "user-asserted", "editable": True, "created": row["created"], "modified": row["modified"]}


def _edge(row):
    value = dict(row)
    value.update(evidence=json.loads(row["evidence"]), provenance="user-asserted", editable=True)
    return value


def _metadata_projection(item):
    """Scope identity to one paper: equal names do not prove the same person."""
    nodes, edges, seen = [], [], set()
    paper_id = item["id"]
    truncated = False

    def add(kind, label, identity, source):
        nonlocal truncated
        node_id = _identifier(kind, paper_id, identity)
        if node_id not in seen:
            if len(nodes) >= MAX_NODES:
                truncated = True
                return None
            seen.add(node_id)
            nodes.append({"id": node_id, "paper_id": paper_id, "label": str(label)[:500], "type": kind,
                          "provenance": "catalog-metadata", "editable": False,
                          "evidence": {"page": None, "quote": "", "note": "", "source": source, "annotation_id": ""}})
        return node_id

    def connect(source, target, relation, field):
        nonlocal truncated
        if source is None or target is None or len(edges) >= MAX_EDGES:
            truncated = True
            return
        edges.append({"id": _identifier("metadata-edge", source, target, relation), "paper_id": paper_id,
                      "source": source, "target": target, "relation": relation, "provenance": "catalog-metadata",
                      "editable": False, "evidence": {"page": None, "quote": "", "note": "", "source": field, "annotation_id": ""}})

    authors = item.get("author", [])
    if not isinstance(authors, list):
        authors = []
    truncated |= len(authors) > 80
    author_occurrences = {}
    def author_identity(author):
        supplied_id = author.get("ORCID") or author.get("orcid")
        if supplied_id:
            return "orcid:" + str(supplied_id).strip().lower().removeprefix("https://orcid.org/")
        name = {key: author.get(key, "") for key in
                ("literal", "given", "family", "suffix", "dropping-particle", "non-dropping-particle")}
        affiliations = author.get("affiliation", [])
        if not isinstance(affiliations, list):
            affiliations = [affiliations]
        affiliation_names = sorted(str(value.get("ror") or value.get("id") or value.get("name", ""))
                                   if isinstance(value, dict) else str(value) for value in affiliations[:30])
        return "name:" + json.dumps([name, affiliation_names], sort_keys=True, ensure_ascii=False)
    identities = [author_identity(author) for author in authors[:80] if isinstance(author, dict)]
    for index, author in enumerate(authors[:80]):
        if not isinstance(author, dict):
            continue
        label = author.get("literal") or " ".join(str(author.get(key) or "") for key in ("given", "family")).strip()
        if not label:
            continue
        # Never anchor a reader-authored edge to the position in an author list.
        # Distinct names survive reordering; changed identities become missing
        # endpoints instead of silently rebinding to another person. Duplicate
        # identical names remain separate occurrences within this paper.
        identity = author_identity(author)
        occurrence = author_occurrences.get(identity, 0)
        author_occurrences[identity] = occurrence + 1
        author_id = add("author", label, f"{identity}:occurrence:{occurrence}", f"author[{index}]")
        if author_id:
            next(node for node in nodes if node["id"] == author_id)["identity_reliable"] = identities.count(identity) == 1
        connect(paper_id, author_id, "authored_by", f"author[{index}]")
        affiliations = author.get("affiliation", [])
        if not isinstance(affiliations, list):
            affiliations = [affiliations]
        truncated |= len(affiliations) > 30
        for affiliation in affiliations[:30]:
            name = affiliation.get("name") if isinstance(affiliation, dict) else affiliation
            if name:
                institution_id = add("institution", name, str(name).strip().casefold(), f"author[{index}].affiliation")
                connect(author_id, institution_id, "affiliated_with", f"author[{index}].affiliation")
    publisher = item.get("publisher")
    if isinstance(publisher, str) and publisher.strip():
        institution_id = add("institution", publisher, publisher.strip().casefold(), "publisher")
        connect(paper_id, institution_id, "published_by", "publisher")
    # Both CSL keywords and imported Zotero tags are already normalized by core.
    tags = item.get("tags", [])
    if not isinstance(tags, list):
        tags = []
    truncated |= len(tags) > 30
    for tag in tags[:30]:
        label = str(tag)[:500]
        node_id = "tag:" + label
        if node_id not in seen:
            if len(nodes) >= MAX_NODES:
                truncated = True
                continue
            seen.add(node_id)
            nodes.append({"id": node_id, "paper_id": paper_id, "label": label, "type": "tag", "editable": False,
                          "provenance": "catalog-metadata", "evidence": {"page": None, "source": "tags"}})
        connect(paper_id, node_id, "tagged", "tags")
    return nodes, edges, truncated


def _active(library, paper_id):
    try:
        return library.get(paper_id)
    except ValueError:
        return None


def get_graph(library, id=None, limit=100):
    _schema(library)
    if isinstance(limit, bool):
        raise ValueError("Graph limit must be an integer")
    try:
        limit = max(1, min(MAX_NODES, int(limit)))
    except (ValueError, TypeError):
        raise ValueError("Graph limit must be an integer") from None
    if id:
        current = library.get(id)
        items = [current]
    else:
        # The global view is deliberately a bounded catalog window.
        listing = library.list(limit=min(limit, 40))
        items = listing["items"]
    nodes, edges, seen = [], [], set()
    truncated = bool(not id and listing["total"] > len(items))
    warnings = []

    def append_node(node):
        nonlocal truncated
        if node["id"] in seen:
            return True
        if len(nodes) >= limit:
            truncated = True
            return False
        seen.add(node["id"])
        nodes.append(node)
        return True

    def append_edge(edge):
        nonlocal truncated
        if edge["source"] not in seen or edge["target"] not in seen:
            truncated = True
            if edge.get("editable"):
                message = "部分已保存关系的端点未显示，可能超出当前范围或因资料更新而改变；原记录仍保留。"
                if message not in warnings:
                    warnings.append(message)
            return
        if edge.get("editable") and any(node.get("identity_reliable") is False and node["id"] in
                                        (edge["source"], edge["target"]) for node in nodes):
            truncated = True
            message = "部分作者身份目前无法区分，相关读者关系暂不展示；请先补充作者资料。"
            if message not in warnings:
                warnings.append(message)
            return
        if len(edges) >= MAX_EDGES:
            truncated = True
            return
        edges.append(edge)

    # Give each explicit paper priority over derived author/tag projections.
    for item in items:
        append_node({"id": item["id"], "paper_id": item["id"], "label": item["title"], "type": "paper",
                     "editable": False, "provenance": "catalog-metadata", "evidence": {"page": None, "source": "title"}})
    for item in items:
        paper_id = item["id"]
        rows = library.db.execute("SELECT * FROM knowledge_nodes WHERE paper_id=? ORDER BY created,id LIMIT ?", (paper_id, limit + 1)).fetchall()
        truncated |= len(rows) > limit
        for row in rows[:limit]:
            node = _node(row)
            if append_node(node):
                append_edge({"id": _identifier("contains", paper_id, node["id"]), "paper_id": paper_id,
                             "source": paper_id, "target": node["id"], "relation": "contains", "editable": False,
                             "provenance": "user-asserted", "evidence": node["evidence"]})
        derived_nodes, derived_edges, clipped = _metadata_projection(item)
        truncated |= clipped
        for node in derived_nodes:
            append_node(node)
        for edge in derived_edges:
            append_edge(edge)
        links = library.db.execute("SELECT * FROM links WHERE source=? OR target=? ORDER BY created,source,target LIMIT ?", (paper_id, paper_id, MAX_EDGES + 1)).fetchall()
        truncated |= len(links) > MAX_EDGES
        for row in links[:MAX_EDGES]:
            other_id = row["target"] if row["source"] == paper_id else row["source"]
            if other_id not in seen:
                other = _active(library, other_id)
                if not other:
                    continue
                append_node({"id": other_id, "paper_id": other_id, "type": "paper", "label": other["title"],
                             "editable": False, "provenance": "catalog-metadata", "evidence": {"page": None, "source": "title"}})
            append_edge({**dict(row), "id": _identifier("legacy", row["source"], row["target"], row["relation"]),
                         "paper_id": paper_id, "editable": False, "legacy": True,
                         "evidence": {"page": None, "quote": "", "note": row["note"], "source": "", "annotation_id": ""}})
        stored_edges = library.db.execute("SELECT * FROM knowledge_edges WHERE paper_id=? ORDER BY created,id LIMIT ?", (paper_id, MAX_EDGES + 1)).fetchall()
        truncated |= len(stored_edges) > MAX_EDGES
        for row in stored_edges[:MAX_EDGES]:
            append_edge(_edge(row))
    unique_edges = list({edge["id"]: edge for edge in edges}.values())
    if truncated:
        warnings.append("当前图谱只显示部分节点或关系；缩小范围或分别查看相关论文。")
    return {"nodes": nodes, "edges": unique_edges, "truncated": truncated, "warnings": warnings,
            "scope": {"paper_id": id, "max_nodes": limit, "max_edges": MAX_EDGES},
            "semantics": "Reader-authored assertions and catalog metadata; no automatic scientific inference or person identity merging",
            "node_types": list(NODE_TYPES), "relations": list(RELATIONS)}


def _endpoint(library, paper_id, node_id):
    if not isinstance(node_id, str) or len(node_id) > 600:
        raise ValueError("Invalid relation endpoint")
    if node_id == paper_id:
        return
    if library.db.execute("SELECT 1 FROM knowledge_nodes WHERE id=? AND paper_id=?", (node_id, paper_id)).fetchone():
        return
    nodes, _, _ = _metadata_projection(library.get(paper_id))
    for node in nodes:
        if node["id"] == node_id:
            if node.get("identity_reliable") is False:
                raise ValueError("Indistinguishable author entries need distinct ORCID or affiliation before attaching reader relations")
            return
    if library.db.execute("SELECT 1 FROM links WHERE (source=? AND target=?) OR (source=? AND target=?)", (paper_id, node_id, node_id, paper_id)).fetchone() and _active(library, node_id):
        return
    raise ValueError("Relation endpoint is missing or belongs to another paper; refresh the graph")


def dispatch_graph(library, action, request):
    _schema(library)
    paper_id = request.get("id")
    library.get(paper_id)
    node_id, edge_id = request.get("node_id"), request.get("edge_id")
    for value in (node_id, edge_id):
        if value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 200):
            raise ValueError("Graph record identifier must be text of 1–200 characters")
    with library.lock():
        # Recheck after obtaining the write lock so an intervening archive cannot
        # admit a mutation into a paper that has just moved to trash.
        library.get(paper_id)
        if action == "graph_node_put":
            kind = request.get("type")
            if kind not in NODE_TYPES:
                raise ValueError("Unsupported graph node type")
            label = _text(request.get("label"), "Node label", 500, required=True)
            description = _text(request.get("description"), "Node description", 4000)
            evidence = json.dumps(_evidence(request.get("evidence")), ensure_ascii=False)
            existing = library.db.execute("SELECT * FROM knowledge_nodes WHERE id=? AND paper_id=?", (node_id, paper_id)).fetchone() if node_id else None
            if node_id and not existing:
                raise ValueError("Editable node not found in this paper")
            if not existing and library.db.execute("SELECT count(*) FROM knowledge_nodes WHERE paper_id=?", (paper_id,)).fetchone()[0] >= MAX_PER_PAPER:
                raise ValueError("This paper has reached the 2000-node storage limit")
            node_id = node_id or "node:" + uuid.uuid4().hex
            created = existing["created"] if existing else _now()
            library.db.execute("INSERT INTO knowledge_nodes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,description=excluded.description,evidence=excluded.evidence,modified=excluded.modified", (node_id, paper_id, kind, label, description, evidence, created, _now()))
            return _node(library.db.execute("SELECT * FROM knowledge_nodes WHERE id=?", (node_id,)).fetchone())
        if action == "graph_node_delete":
            if not library.db.execute("SELECT 1 FROM knowledge_nodes WHERE id=? AND paper_id=?", (node_id, paper_id)).fetchone():
                raise ValueError("Editable node not found in this paper")
            removed = library.db.execute("DELETE FROM knowledge_edges WHERE paper_id=? AND (source=? OR target=?)", (paper_id, node_id, node_id)).rowcount
            library.db.execute("DELETE FROM knowledge_nodes WHERE id=? AND paper_id=?", (node_id, paper_id))
            return {"deleted": True, "node_id": node_id, "removed_edges": removed}
        if action == "graph_edge_put":
            source, target, relation = request.get("source"), request.get("target"), request.get("relation")
            if relation not in RELATIONS:
                raise ValueError("Unsupported graph relation")
            _endpoint(library, paper_id, source)
            _endpoint(library, paper_id, target)
            if source == target:
                raise ValueError("Choose two distinct relation endpoints")
            evidence = json.dumps(_evidence(request.get("evidence")), ensure_ascii=False)
            existing = library.db.execute("SELECT * FROM knowledge_edges WHERE id=? AND paper_id=?", (edge_id, paper_id)).fetchone() if edge_id else None
            if edge_id and not existing:
                raise ValueError("Editable relation not found in this paper")
            duplicate = library.db.execute("SELECT id FROM knowledge_edges WHERE paper_id=? AND source=? AND target=? AND relation=?", (paper_id, source, target, relation)).fetchone()
            if duplicate and duplicate["id"] != edge_id:
                raise ValueError("This directed relation already exists; edit the existing relation")
            if not existing and library.db.execute("SELECT count(*) FROM knowledge_edges WHERE paper_id=?", (paper_id,)).fetchone()[0] >= MAX_PER_PAPER:
                raise ValueError("This paper has reached the 2000-relation storage limit")
            edge_id = edge_id or "edge:" + uuid.uuid4().hex
            created = existing["created"] if existing else _now()
            library.db.execute("INSERT INTO knowledge_edges VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,target=excluded.target,relation=excluded.relation,evidence=excluded.evidence,modified=excluded.modified", (edge_id, paper_id, source, target, relation, evidence, created, _now()))
            return _edge(library.db.execute("SELECT * FROM knowledge_edges WHERE id=?", (edge_id,)).fetchone())
        if action == "graph_edge_delete":
            if not library.db.execute("DELETE FROM knowledge_edges WHERE id=? AND paper_id=?", (edge_id, paper_id)).rowcount:
                raise ValueError("Editable relation not found in this paper")
            return {"deleted": True, "edge_id": edge_id}
        raise ValueError("Unknown graph action")
