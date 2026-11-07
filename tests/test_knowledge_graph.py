"""Synthetic metadata-only tests for evidence graph persistence and bounds."""
import pytest
from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.knowledge_graph import dispatch_graph, get_graph, get_statistics


@pytest.fixture
def catalog(tmp_path):
    library = Library(tmp_path / "synthetic-graph-library")
    items = library.import_items(items=[
        {"id": "GraphOne", "title": "Synthetic evidence paper", "author": [{"family": "Reader", "given": "Ada", "affiliation": [{"name": "Synthetic Institute"}]}], "tags": ["mobility"]},
        {"id": "GraphTwo", "title": "Synthetic comparison", "author": [{"family": "Reader", "given": "Ada"}]},
    ])["items"]
    yield library, items
    library.close()


def put_node(library, paper, **extra):
    return dispatch_graph(library, "graph_node_put", {"id": paper["id"], "type": "claim", "label": "Synthetic claim", "evidence": {"page": 2, "quote": "A declared observation", "note": "Reader interpretation", "source": "section 2"}, **extra})


def test_statistics_cover_the_whole_active_catalog_and_preserve_missing_citation_values(tmp_path, monkeypatch):
    library = Library(tmp_path / "synthetic-statistics")
    items = library.import_items(items=[
        {"id": f"Statistics{index}", "title": f"Synthetic metadata {index}",
         **({"issued": {"date-parts": [[2020 + index % 3]]}} if index < 45 else {}),
         **({"is-referenced-by-count": 0} if index == 0 else {}),
         **({"is-referenced-by-count": 15, "openalex": {"cited_by_count": 27}} if index == 44 else {}),
         **({"semantic_scholar": {"citationCount": 600}} if index == 45 else {}),
         **({"citation_count": 12345, "reference-count": 900} if index == 46 else {})}
        for index in range(47)
    ])["items"]
    archived = library.create({"title": "Archived synthetic metadata", "issued": {"date-parts": [[1990]]}, "is-referenced-by-count": 999})
    library.archive(archived["id"])
    for name in ("pdf_path", "get", "list"):
        monkeypatch.setattr(library, name, lambda *_args, **_kwargs: pytest.fail("statistics must only aggregate SQL metadata"))
    statements = []
    library.db.set_trace_callback(statements.append)
    result = get_statistics(library)
    library.db.set_trace_callback(None)
    assert result["total_papers"] == 47 and len(items) == 47
    assert result["years"] == {"known": 45, "missing": 2, "items": [{"year": year, "count": 15} for year in (2020, 2021, 2022)], "other_count": 0, "truncated": False, "maximum_rows": 200}
    assert result["citations"]["known_papers"] == 3 and result["citations"]["missing_papers"] == 44
    crossref, openalex, semantic = result["citations"]["sources"]
    assert (crossref["known"], crossref["missing"]) == (2, 45)
    assert [item["count"] for item in crossref["buckets"]] == [1, 0, 1, 0, 0, 0]
    assert (openalex["known"], semantic["known"]) == (1, 1)
    assert semantic["buckets"][-1]["count"] == 1
    assert len(statements) == 1 and statements[0].lstrip().startswith("WITH catalog")
    library.close()


def test_statistics_ignore_untyped_counts_and_return_bounded_year_groups(tmp_path):
    library = Library(tmp_path / "synthetic-statistics")
    items = [{"id": f"Year{year}", "title": f"Synthetic year {year}", "issued": {"date-parts": [[year]]}} for year in range(1700, 1905)]
    for offset in (0, 100, 200):
        library.import_items(items=items, offset=offset)
    for index, value in enumerate((True, False, -1, 1.5, "12", 1000000001, None)):
        library.create({"title": f"Synthetic unknown count {index}", "is-referenced-by-count": value})
    library.create({"title": "Synthetic nested snapshot", "crossref": {"is-referenced-by-count": 4}})
    result = get_statistics(library)
    assert len(result["years"]["items"]) == 200
    assert result["years"]["items"][0]["year"] == 1705 and result["years"]["items"][-1]["year"] == 1904
    assert result["years"]["known"] == 205 and result["years"]["other_count"] == 5 and result["years"]["truncated"] is True
    assert result["years"]["missing"] == 8
    assert result["citations"]["known_papers"] == 1
    assert result["citations"]["sources"][0]["buckets"][1]["count"] == 1
    library.close()


def test_empty_statistics_are_unknown_not_zero_cited_papers(tmp_path):
    result = dispatch({"action": "graph_statistics", "library": str(tmp_path / "synthetic-empty-statistics")})
    assert result["total_papers"] == 0 and result["years"]["items"] == []
    assert result["citations"]["known_papers"] == 0
    assert all(source["known"] == 0 and all(bucket["count"] == 0 for bucket in source["buckets"]) for source in result["citations"]["sources"])


def test_graph_projects_authors_units_and_preserves_legacy_without_reading_pdf(catalog, monkeypatch):
    library, (first, second) = catalog
    monkeypatch.setattr(library, "pdf_path", lambda *_: pytest.fail("graph must not open a PDF"))
    library.link(first["id"], second["id"], "supports", "Explicit earlier paper link")
    graph = get_graph(library, first["id"])
    assert {node["type"] for node in graph["nodes"]} == {"paper", "author", "institution", "tag"}
    assert {edge["relation"] for edge in graph["edges"]} >= {"authored_by", "affiliated_with", "tagged", "supports"}
    legacy = next(edge for edge in graph["edges"] if edge.get("legacy"))
    assert legacy["evidence"]["note"] == "Explicit earlier paper link"
    assert legacy["provenance"] == "user-asserted"
    assert all(not node["editable"] for node in graph["nodes"])
    another = get_graph(library, second["id"])
    assert next(n["id"] for n in graph["nodes"] if n["type"] == "author") != next(n["id"] for n in another["nodes"] if n["type"] == "author")


def test_manual_node_relation_roundtrip_and_delete_cascades_only_graph_records(catalog):
    library, (paper, _) = catalog
    claim = put_node(library, paper)
    evidence = put_node(library, paper, type="evidence", label="Measured sample")
    edge = dispatch_graph(library, "graph_edge_put", {"id": paper["id"], "source": evidence["id"], "target": claim["id"], "relation": "supports", "evidence": {"page": 4, "note": "Narrowly supports the observation"}})
    edited = put_node(library, paper, node_id=claim["id"], label="Revised claim", evidence={"page": None, "source": "figure 3"})
    assert edited["created"] == claim["created"]
    assert edited["evidence"]["page"] is None
    updated = dispatch_graph(library, "graph_edge_put", {"id": paper["id"], "edge_id": edge["id"], "source": evidence["id"], "target": claim["id"], "relation": "contradicts", "evidence": {"quote": "Negative result"}})
    assert updated["id"] == edge["id"]
    graph = get_graph(library, paper["id"])
    assert next(node for node in graph["nodes"] if node["id"] == claim["id"])["label"] == "Revised claim"
    assert any(value["relation"] == "contradicts" and value["editable"] for value in graph["edges"])
    removed = dispatch_graph(library, "graph_node_delete", {"id": paper["id"], "node_id": claim["id"]})
    assert removed["removed_edges"] == 1
    assert library.get(paper["id"])["title"] == paper["title"]
    assert evidence["id"] in {node["id"] for node in get_graph(library, paper["id"])["nodes"]}
    with pytest.raises(ValueError, match="not found"):
        dispatch_graph(library, "graph_edge_delete", {"id": paper["id"], "edge_id": edge["id"]})


def test_edge_direction_duplicate_scope_and_metadata_immutability(catalog):
    library, (paper, other) = catalog
    claim = put_node(library, paper)
    foreign = put_node(library, other)
    args = {"id": paper["id"], "source": paper["id"], "target": claim["id"], "relation": "supports"}
    edge = dispatch_graph(library, "graph_edge_put", args)
    with pytest.raises(ValueError, match="already exists"):
        dispatch_graph(library, "graph_edge_put", args)
    reverse = dispatch_graph(library, "graph_edge_put", {**args, "source": claim["id"], "target": paper["id"]})
    assert reverse["id"] != edge["id"]
    with pytest.raises(ValueError, match="another paper"):
        dispatch_graph(library, "graph_edge_put", {**args, "target": foreign["id"]})
    with pytest.raises(ValueError, match="not found"):
        put_node(library, paper, node_id=foreign["id"])
    author = next(node for node in get_graph(library, paper["id"])["nodes"] if node["type"] == "author")
    with pytest.raises(ValueError, match="not found"):
        dispatch_graph(library, "graph_node_delete", {"id": paper["id"], "node_id": author["id"]})
    dispatch_graph(library, "graph_edge_delete", {"id": paper["id"], "edge_id": edge["id"]})
    assert reverse["id"] in {e["id"] for e in get_graph(library, paper["id"])["edges"]}


@pytest.mark.parametrize("extra,message", [
    ({"type": "automatic-causality"}, "Unsupported"),
    ({"label": ""}, "Node label"),
    ({"label": "a" * 501}, "Node label"),
    ({"evidence": {"page": True}}, "positive integer"),
    ({"evidence": {"page": 0}}, "positive integer"),
    ({"evidence": {"quote": "q" * 4001}}, "Evidence quote"),
    ({"evidence": []}, "object"),
])
def test_invalid_data_does_not_persist(catalog, extra, message):
    library, (paper, _) = catalog
    with pytest.raises(ValueError, match=message):
        put_node(library, paper, **extra)
    assert not any(node["editable"] for node in get_graph(library, paper["id"])["nodes"])


def test_graph_scope_budget_and_archive_recovery(catalog):
    library, (paper, other) = catalog
    for index in range(12):
        put_node(library, paper, label=f"Claim {index}")
    graph = get_graph(library, paper["id"], limit=5)
    assert len(graph["nodes"]) == 5 and graph["truncated"] and graph["warnings"]
    assert all(edge["source"] in {n["id"] for n in graph["nodes"]} and edge["target"] in {n["id"] for n in graph["nodes"]} for edge in graph["edges"])
    library.link(paper["id"], other["id"])
    library.archive(other["id"])
    assert other["id"] not in {node["id"] for node in get_graph(library, paper["id"])["nodes"]}
    library.archive(paper["id"])
    with pytest.raises(ValueError, match="archived"):
        get_graph(library, paper["id"])
    library.restore(paper["id"])
    assert len([n for n in get_graph(library, paper["id"])["nodes"] if n["editable"]]) == 12


def test_graph_public_worker_dispatch_persists_between_process_lifetimes(tmp_path):
    root = str(tmp_path / "synthetic-worker-library")
    item = dispatch({"action": "create", "library": root, "metadata": {"title": "Synthetic worker paper"}})
    node = dispatch({"action": "graph_node_put", "library": root, "id": item["id"], "type": "method", "label": "Transparent baseline", "evidence": {"note": "Reader-described method"}})
    graph = dispatch({"action": "graph", "library": root, "id": item["id"]})
    assert any(value["id"] == node["id"] and value["type"] == "method" for value in graph["nodes"])


def test_author_reorder_preserves_manual_edge_and_identity_change_never_rebinds(catalog):
    library, (paper, _) = catalog
    first = {"given": "Ada", "family": "Reader"}
    second = {"given": "Bo", "family": "Author"}
    library.update(paper["id"], {"author": [first, second]})
    author = next(n for n in get_graph(library, paper["id"])["nodes"] if n["label"] == "Ada Reader")
    claim = put_node(library, paper)
    edge = dispatch_graph(library, "graph_edge_put", {"id": paper["id"], "source": claim["id"], "target": author["id"], "relation": "related"})
    library.update(paper["id"], {"author": [second, first]})
    reordered = get_graph(library, paper["id"])
    assert next(n for n in reordered["nodes"] if n["label"] == "Ada Reader")["id"] == author["id"]
    assert any(e["id"] == edge["id"] and e["target"] == author["id"] for e in reordered["edges"])
    library.update(paper["id"], {"author": [second, {"given": "Cy", "family": "Another"}]})
    changed = get_graph(library, paper["id"])
    assert not any(e["id"] == edge["id"] for e in changed["edges"])
    assert changed["truncated"]
    assert library.db.execute("SELECT target FROM knowledge_edges WHERE id=?", (edge["id"],)).fetchone()[0] == author["id"]


def test_indistinguishable_author_entries_cannot_silently_own_reader_relations(catalog):
    library, (paper, _) = catalog
    person = {"given": "Ada", "family": "Reader"}
    library.update(paper["id"], {"author": [person]})
    original = next(node for node in get_graph(library, paper["id"])["nodes"] if node["type"] == "author")
    prior = dispatch_graph(library, "graph_edge_put", {"id": paper["id"], "source": paper["id"], "target": original["id"], "relation": "related"})
    library.update(paper["id"], {"author": [person, person]})
    graph = get_graph(library, paper["id"])
    authors = [node for node in graph["nodes"] if node["type"] == "author"]
    assert graph["truncated"] and not any(edge["id"] == prior["id"] for edge in graph["edges"])
    assert len({node["id"] for node in authors}) == 2
    assert all(node["identity_reliable"] is False for node in authors)
    with pytest.raises(ValueError, match="Indistinguishable author"):
        dispatch_graph(library, "graph_edge_put", {"id": paper["id"], "source": paper["id"], "target": authors[0]["id"], "relation": "related"})


def test_global_graph_pages_catalog_without_opening_pdf(catalog, monkeypatch):
    library, _ = catalog
    library.import_items(items=[{"id": f"Window{i}", "title": f"Synthetic window {i}"} for i in range(43)])
    monkeypatch.setattr(library, "pdf_path", lambda *_: pytest.fail("global graph must not open PDFs"))
    first = get_graph(library, limit=100)
    second = get_graph(library, limit=100, offset=first["scope"]["next_offset"])
    assert first["scope"]["paper_count"] == 40
    assert first["scope"]["total_papers"] == 45
    assert second["scope"]["paper_count"] == 5
    assert second["scope"]["previous_offset"] == 0
    assert second["scope"]["next_offset"] is None
    first_ids = {n["id"] for n in first["nodes"] if n["type"] == "paper"}
    second_ids = {n["id"] for n in second["nodes"] if n["type"] == "paper"}
    assert first_ids.isdisjoint(second_ids) and len(first_ids | second_ids) == 45
    for offset in (-1, True, 10000001):
        with pytest.raises(ValueError):
            get_graph(library, offset=offset)


def test_citation_mode_uses_directed_links_and_exact_saved_reference_dois(catalog):
    library, (first, second) = catalog
    # Metadata references are factual saved input, not inferred similarity.
    library.update(second['id'], {'DOI': '10.0000/synthetic-target'})
    library.update(first['id'], {'reference': [{'DOI': '10.0000/synthetic-target'}]})
    library.link(first['id'], second['id'], 'supports', 'not a citation')
    graph = get_graph(library, view='citations')
    assert all(node['type'] == 'paper' for node in graph['nodes'])
    assert len(graph['edges']) == 1
    assert (graph['edges'][0]['source'], graph['edges'][0]['target'], graph['edges'][0]['relation']) == (first['id'], second['id'], 'cites')
    assert graph['edges'][0]['provenance'] == 'catalog-reference'


def test_focus_paper_outside_catalog_window_keeps_its_relations(catalog):
    library, (first, second) = catalog
    node = put_node(library, first)
    graph = get_graph(library, offset=1, limit=10, focus_id=first['id'])
    assert graph['scope']['focus_id'] == first['id']
    assert graph['scope']['paper_count'] == 1
    assert any(n['id'] == node['id'] for n in graph['nodes'])
    assert graph['nodes'][0]['id'] == first['id']


def test_saved_ai_analysis_is_projected_with_evidence_and_review_status(catalog):
    from dsh_paper_library import library_knowledge as knowledge
    library, (first, _) = catalog
    def call(action, **args):
        return knowledge.dispatch(library, {'action': action, **args})
    entity = {'kind': 'paper', 'id': first['id']}
    source = call('knowledge_source_put', entity=entity, kind='user-text', text='Synthetic method uses twelve samples.', locator={'page': 2})
    draft = call('knowledge_draft_put', entity=entity, origin='llm', request_id='synthetic-analysis', source_ids=[source['id']], nodes=[
        {'id': 'method', 'type': 'method', 'label': 'Synthetic method'},
        {'id': 'quote', 'type': 'evidence', 'label': 'Twelve samples', 'source_id': source['id'], 'quote': 'twelve samples'},
        {'id': 'claim', 'type': 'claim', 'label': 'Synthetic claim'},
    ], edges=[{'subject': 'paper:' + first['id'], 'relation': 'uses', 'object': 'method:method'}], assertions=[{'subject': 'evidence:quote', 'relation': 'supports', 'object': 'claim:claim'}])
    graph = get_graph(library, first['id'])
    projected = [n for n in graph['nodes'] if n.get('provenance') == 'ai-analysis']
    assert len(projected) == 3 and all(n['review_status'] == 'needs-review' and not n['editable'] for n in projected)
    evidence = next(n for n in projected if n['type'] == 'evidence')
    assert evidence['evidence']['page'] == 2 and evidence['evidence']['quote'] == 'twelve samples'
    assert any(e['relation'] == 'supports' for e in graph['edges'])
    call('knowledge_draft_review', id=draft['id'], decision='rejected', reviewed_by='user', expected_revision=draft['revision'])
    assert not any(n.get('provenance') == 'ai-analysis' for n in get_graph(library, first['id'])['nodes'])
