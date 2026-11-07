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
STATISTICS_YEARS = 200
# Only these named source snapshots have an unambiguous inbound-citation
# meaning. Generic citation_count, references and missing values stay unknown.
CITATION_SOURCES = (
    ("crossref", "Crossref", ('$."is-referenced-by-count"', '$.crossref."is-referenced-by-count"')),
    ("openalex", "OpenAlex", ('$.openalex.cited_by_count',)),
    ("semantic-scholar", "Semantic Scholar", ('$.semantic_scholar.citationCount',)),
)


def get_statistics(library):
    """Aggregate saved active-catalog metadata, without PDF or network access.

    One SQL statement gives a consistent snapshot across counts/distributions;
    it returns at most 200 years and 18 citation buckets, never paper bodies.
    Source snapshots are intentionally kept separate rather than summed.
    """
    def citation_value(paths):
        values = [f"CASE WHEN json_type(metadata, '{path}')='integer' "
                  f"AND json_extract(metadata, '{path}') BETWEEN 0 AND 1000000000 "
                  f"THEN json_extract(metadata, '{path}') END" for path in paths]
        return "COALESCE(" + ",".join(values) + ")" if len(values) > 1 else values[0]

    aliases = ["crossref_count", "openalex_count", "semantic_count"]
    fields = ",".join(f"{citation_value(paths)} AS {alias}" for (_, _, paths), alias in zip(CITATION_SOURCES, aliases))
    citation_rows = " UNION ALL ".join(f"SELECT '{source}' AS source,{alias} AS value FROM valueset WHERE {alias} IS NOT NULL"
                                       for (source, _, _), alias in zip(CITATION_SOURCES, aliases))
    known = " OR ".join(f"{alias} IS NOT NULL" for alias in aliases)
    row = library.db.execute(f"""
        WITH catalog AS (
          SELECT CASE WHEN json_valid(p.metadata) THEN p.metadata ELSE '{{}}' END AS metadata
          FROM papers p WHERE NOT EXISTS(SELECT 1 FROM paper_archive a WHERE a.paper_id=p.id)
        ), valueset AS (
          SELECT CASE WHEN json_type(metadata,'$.issued."date-parts"[0][0]')='integer'
                   AND json_extract(metadata,'$.issued."date-parts"[0][0]') BETWEEN 1 AND 9999
                 THEN json_extract(metadata,'$.issued."date-parts"[0][0]') END AS year,
                 {fields} FROM catalog
        ), year_groups AS (
          SELECT year,count(*) AS count FROM valueset WHERE year IS NOT NULL
          GROUP BY year ORDER BY year DESC LIMIT {STATISTICS_YEARS}
        ), citation_rows AS ({citation_rows}), citation_groups AS (
          SELECT source,CASE WHEN value=0 THEN 0 WHEN value<10 THEN 1 WHEN value<50 THEN 2
                 WHEN value<100 THEN 3 WHEN value<500 THEN 4 ELSE 5 END AS bucket,count(*) AS count
          FROM citation_rows GROUP BY source,bucket
        )
        SELECT (SELECT count(*) FROM valueset) AS total,
               (SELECT count(year) FROM valueset) AS year_known,
               (SELECT count(*) FROM valueset WHERE {known}) AS citation_known,
               (SELECT json_group_array(json_object('year',year,'count',count)) FROM year_groups) AS years,
               (SELECT json_group_array(json_object('source',source,'bucket',bucket,'count',count)) FROM citation_groups) AS citations
        """).fetchone()
    total, year_known = row["total"], row["year_known"]
    years = sorted(json.loads(row["years"]), key=lambda item: item["year"])
    groups = {(item["source"], item["bucket"]): item["count"] for item in json.loads(row["citations"])}
    sources = []
    labels = ("0", "1–9", "10–49", "50–99", "100–499", "500+")
    for source, label, paths in CITATION_SOURCES:
        buckets = [{"label": name, "count": groups.get((source, index), 0)} for index, name in enumerate(labels)]
        count = sum(item["count"] for item in buckets)
        sources.append({"id": source, "label": label, "fields": [path.removeprefix("$.") for path in paths],
                        "known": count, "missing": total - count, "buckets": buckets})
    other = year_known - sum(item["count"] for item in years)
    return {"scope": "active-library", "total_papers": total,
            "years": {"known": year_known, "missing": total - year_known, "items": years,
                      "other_count": other, "truncated": bool(other), "maximum_rows": STATISTICS_YEARS},
            "citations": {"known_papers": row["citation_known"], "missing_papers": total - row["citation_known"], "sources": sources},
            "semantics": "Saved catalog metadata only; citation sources are separate snapshots, missing is not zero; no PDF reading or online refresh"}


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


def _draft_projection(library, paper_id):
    """投影已保存、有来源的分析草稿；不读 PDF、不调用模型、不自动核准。"""
    if not library.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_drafts'").fetchone():
        return [], [], False
    rows = library.db.execute("SELECT old.payload FROM knowledge_drafts old WHERE old.entity_kind='paper' AND old.entity_id=? AND old.status!='rejected' AND json_array_length(old.payload,'$.nodes')>0 AND (old.status='accepted' OR NOT EXISTS(SELECT 1 FROM knowledge_drafts newer WHERE newer.entity_kind=old.entity_kind AND newer.entity_id=old.entity_id AND newer.status!='rejected' AND json_array_length(newer.payload,'$.nodes')>0 AND json_extract(newer.payload,'$.supersedes_draft_id')=old.id)) ORDER BY old.created DESC,old.id DESC LIMIT 21", (paper_id,)).fetchall()
    nodes, edges = [], []
    for row in rows[:20]:
        draft = json.loads(row["payload"])
        mapping = {f"{node['type']}:{node['id']}": _identifier("analysis", draft["id"], node["type"], node["id"]) for node in draft.get("nodes", [])}
        mapping[f"paper:{paper_id}"] = paper_id
        sources = {}
        for source_id in draft.get("source_ids", [])[:40]:
            source = library.db.execute("SELECT payload FROM knowledge_sources WHERE id=? AND entity_kind='paper' AND entity_id=?", (source_id, paper_id)).fetchone()
            if source:
                sources[source_id] = json.loads(source[0])
        by_id = {f"{node['type']}:{node['id']}": node for node in draft.get("nodes", [])}
        provenance = "ai-analysis" if draft.get("origin") == "llm" else "user-asserted"
        common = {"paper_id": paper_id, "editable": False, "provenance": provenance, "review_status": draft["status"], "draft_id": draft["id"]}
        def evidence(value):
            support = by_id.get(value.get("source_node"), value)
            source = sources.get(support.get("source_id"), {})
            return {"page": source.get("locator", {}).get("page"), "quote": support.get("quote", ""), "note": value.get("surface", ""), "source": support.get("source_id", draft["id"])}
        for node in draft.get("nodes", []):
            node_id = mapping[f"{node['type']}:{node['id']}"]
            nodes.append({**common, "id": node_id, "type": node["type"], "label": node["label"][:500], "description": "\n".join(f"{k}: {v}" for k, v in node.get("fields", {}).items())[:4000], "evidence": evidence(node)})
            edges.append({**common, "id": _identifier("analysis-contains", node_id), "source": paper_id, "target": node_id, "relation": "contains", "evidence": evidence(node)})
        for edge in draft.get("edges", []) + draft.get("assertions", []):
            source, target = mapping.get(edge["subject"]), mapping.get(edge["object"])
            if source and target:
                edges.append({**common, "id": _identifier("analysis-edge", draft["id"], edge["id"]), "source": source, "target": target, "relation": edge["relation"], "evidence": evidence(edge)})
    return nodes, edges, len(rows) > 20


def _reference_links(library, item):
    """仅以已保存参考文献的精确 DOI 匹配库内论文，不将共同作者视为引用。"""
    refs = item.get("reference", item.get("crossref", {}).get("reference", []) if isinstance(item.get("crossref"), dict) else [])
    if not isinstance(refs, list):
        return []
    result = []
    for ref in refs[:200]:
        if not isinstance(ref, dict):
            continue
        doi = str(ref.get("DOI", ref.get("doi", ""))).strip().lower().removeprefix("https://doi.org/")
        if not doi.startswith("10.") or len(doi) > 300:
            continue
        matches = library.db.execute("SELECT id FROM papers WHERE lower(json_extract(metadata,'$.DOI'))=? AND NOT EXISTS(SELECT 1 FROM paper_archive WHERE paper_id=papers.id) LIMIT 2", (doi,)).fetchall()
        if len(matches) == 1 and matches[0]["id"] != item["id"]:
            result.append({"source": item["id"], "target": matches[0]["id"], "relation": "cites", "note": "已保存参考文献 DOI: " + doi, "provenance": "catalog-reference"})
    return result


def get_graph(library, id=None, limit=100, offset=0, focus_id=None, view="all"):
    _schema(library)
    if view not in {"all", "citations"}:
        raise ValueError("Graph view must be all or citations")
    if isinstance(limit, bool):
        raise ValueError("Graph limit must be an integer")
    try:
        limit = max(1, min(MAX_NODES, int(limit)))
    except (ValueError, TypeError):
        raise ValueError("Graph limit must be an integer") from None
    if type(offset) is not int or not 0 <= offset <= 10000000:
        raise ValueError("Graph offset must be an integer from 0 to 10000000")
    if id:
        current = library.get(id)
        items = [current]
    else:
        # The global view is deliberately a bounded catalog window.
        listing = library.list(limit=min(limit, 40), offset=offset)
        items = listing["items"]
    window_count = len(items)
    if focus_id and not id:
        focus = library.get(focus_id)
        items = [focus] + [item for item in items if item["id"] != focus_id]
    nodes, edges, seen = [], [], set()
    truncated = bool(not id and listing["total"] > len(items))
    warnings, reference_snapshots = [], []

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
        # 引用先于分析／作者投影，避免有效参考文献被普通知识节点耗尽预算。
        from .paper_references import project as project_references
        reference_nodes, reference_edges, reference_snapshot = project_references(library, item)
        if reference_snapshot:
            reference_snapshots.append(reference_snapshot)
            warnings.extend(reference_snapshot['warnings'])
        for node in reference_nodes:
            append_node(node)
        for edge in reference_edges:
            append_edge(edge)
        if view == "all":
            rows = library.db.execute("SELECT * FROM knowledge_nodes WHERE paper_id=? ORDER BY created,id LIMIT ?", (paper_id, limit + 1)).fetchall()
            truncated |= len(rows) > limit
            for row in rows[:limit]:
                node = _node(row)
                if append_node(node):
                    append_edge({"id": _identifier("contains", paper_id, node["id"]), "paper_id": paper_id,
                                 "source": paper_id, "target": node["id"], "relation": "contains", "editable": False,
                                 "provenance": "user-asserted", "evidence": node["evidence"]})
            analysis_nodes, analysis_edges, clipped = _draft_projection(library, paper_id) if len(nodes) < limit else ([], [], True)
            truncated |= clipped
            for node in analysis_nodes:
                append_node(node)
            for edge in analysis_edges:
                append_edge(edge)
            derived_nodes, derived_edges, clipped = _metadata_projection(item)
            truncated |= clipped
            for node in derived_nodes:
                append_node(node)
            for edge in derived_edges:
                append_edge(edge)
        links = library.db.execute("SELECT * FROM links WHERE source=? OR target=? ORDER BY created,source,target LIMIT ?", (paper_id, paper_id, MAX_EDGES + 1)).fetchall()
        truncated |= len(links) > MAX_EDGES
        for row in [dict(row) for row in links[:MAX_EDGES]] + _reference_links(library, item):
            if view == "citations" and row["relation"] != "cites":
                continue
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
            if view == "all" or row["relation"] == "cites" and all(any(n["id"] == end and n["type"] == "paper" for n in nodes) for end in (row["source"], row["target"])):
                append_edge(_edge(row))
    unique_edges = list({edge["id"]: edge for edge in edges}.values())
    if truncated:
        warnings.append("当前图谱只显示部分节点或关系；缩小范围或分别查看相关论文。")
    return {"nodes": nodes, "edges": unique_edges, "truncated": truncated, "warnings": warnings,
            "scope": {"paper_id": id, "focus_id": focus_id, "view": view, "max_nodes": limit, "max_edges": MAX_EDGES,
                      **({"paper_offset": offset, "paper_count": window_count, "total_papers": listing["total"],
                          "next_offset": offset + window_count if offset + window_count < listing["total"] else None,
                          "previous_offset": max(0, offset - min(limit, 40)) if offset else None} if not id else {})},
            "semantics": "Catalog metadata, reader assertions and explicitly labeled saved AI analysis drafts; no person identity merging",
            "reference_snapshots": reference_snapshots, "node_types": list(NODE_TYPES), "relations": list(RELATIONS)}


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
