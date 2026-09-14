"""Synthetic metadata-only tests for evidence graph persistence and bounds."""
import pytest
from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.knowledge_graph import dispatch_graph, get_graph


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
