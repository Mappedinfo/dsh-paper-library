"""Dataset identity, bounded catalogue, citation and evidence regression fixtures."""
import json
from pathlib import Path

import pytest

from dsh_paper_library.core import Library, csl_item, parse_ris
from dsh_paper_library.datasets import DatasetConflictError, dispatch, resource_get


@pytest.fixture
def library(tmp_path):
    value = Library(tmp_path / "library")
    yield value
    value.close()


def call(library, action, **values):
    return dispatch(library, {"action": action, **values})


def dataset(library, **metadata):
    return call(library, "dataset_put", metadata={"title": "Synthetic dataset", **metadata}, expected_revision=0)


def test_dataset_revision_restart_and_unknown_metadata_stay_unknown(library, monkeypatch):
    monkeypatch.setattr(Library, "_open_pdf", lambda *args: pytest.fail("Opened PDF during dataset CRUD"))
    created = dataset(library, description="Synthetic independent catalogue")
    assert created["id"].startswith("dataset_") and created["resource_kind"] == "dataset"
    assert created["revision"] == 1 and not created["pdf"]
    assert not ({"DOI", "author", "issued", "version", "license"} & created.keys())
    updated = call(library, "dataset_put", id=created["id"], metadata={"description": "Revised"}, expected_revision=1)
    assert updated["revision"] == 2 and updated["title"] == created["title"]
    with pytest.raises(DatasetConflictError) as conflict:
        call(library, "dataset_put", id=created["id"], metadata={"title": "Lost update"}, expected_revision=1)
    assert conflict.value.current["revision"] == 2
    with LibraryFixture(library.root) as reopened:
        restored = call(reopened, "dataset_get", id=created["id"])
        assert restored["description"] == "Revised" and restored["releases"] == []
    for values in ({"metadata": {}}, {"metadata": {"title": ""}}, {"metadata": {"title": "A"}, "expected_revision": True}):
        with pytest.raises(ValueError):
            call(library, "dataset_put", **values)


class LibraryFixture:
    def __init__(self, path): self.path = path
    def __enter__(self): self.library = Library(self.path); return self.library
    def __exit__(self, *args): self.library.close()


def test_distinct_families_versions_and_papers_never_auto_merge(library):
    first = dataset(library, DOI="10.5555/series", citekey="Series", author=[{"literal": "Synthetic Agency"}], published="2020")
    other = dataset(library)
    assert first["id"] != other["id"]
    release = call(library, "dataset_release_put", id=first["id"], metadata={"version": "2026.1", "DOI": "10.5555/release", "citekey": "Series2026", "published": "2026-03"}, expected_revision=0)
    assert release["metadata"]["version"] == "2026.1"
    assert release["metadata"]["issued"] == {"date-parts": [[2026, 3]]}
    resolved = call(library, "dataset_cite", id=first["id"], release_id=release["id"])["item"]
    assert resolved["DOI"] == "10.5555/release" and resolved["author"] == first["author"]
    assert resolved["id"] == release["id"] and resolved["citekey"] == "Series2026"
    no_doi = call(library, "dataset_release_put", id=first["id"], metadata={"version": "undated release"}, expected_revision=0)
    sparse = call(library, "dataset_cite", id=first["id"], release_id=no_doi["id"])
    assert "DOI" not in sparse["item"] and "issued" not in sparse["item"]
    assert sparse["warnings"]
    with pytest.raises(ValueError, match="another resource"):
        dataset(library, DOI="10.5555/release")
    with pytest.raises(ValueError, match="dataset or release"):
        library.create({"title": "Wrong identity", "DOI": "10.5555/series"})
    with pytest.raises(ValueError, match="unknown version"):
        call(library, "dataset_release_put", id=first["id"], metadata={}, expected_revision=0)
    assert resource_get(library, "release", release["id"])["dataset_id"] == first["id"]


def test_cross_resource_citekeys_are_unique_both_directions_and_aliases_retained(library):
    paper = library.create({"title": "Synthetic paper", "citekey": "Paper"})
    with pytest.raises(ValueError, match="Citation key"):
        dataset(library, citekey="Paper")
    first = dataset(library, citekey="Dataset")
    with pytest.raises(ValueError, match="Citation key"):
        library.create({"title": "Cannot reuse", "citekey": "Dataset"})
    with pytest.raises(ValueError, match="Citation key"):
        library.update(paper["id"], {"citekey": "Dataset"})
    result = library.import_items(items=[{"title": "Cannot import", "citekey": "Dataset"}])
    assert result["skipped"] == 1 and result["imported"] == 0
    call(library, "dataset_put", id=first["id"], metadata={"citekey": "DatasetNew"}, expected_revision=1)
    assert call(library, "resource_list", query="Dataset")["items"][0]["id"] == first["id"]
    with pytest.raises(ValueError, match="retained alias"):
        dataset(library, citekey="Dataset")
    library.update(paper["id"], {"citekey": "PaperNew"})
    assert call(library, "resource_list", query="Paper")["items"][0]["id"] == paper["id"]
    with pytest.raises(ValueError, match="Citation key"):
        dataset(library, citekey="Paper")
    with pytest.raises(ValueError, match="alias"):
        library.create({"title": "Another paper", "citekey": "Paper"})


def test_unified_bounded_search_sort_and_archive(library, monkeypatch):
    monkeypatch.setattr(Library, "_open_pdf", lambda *args: pytest.fail("Browsing opened PDF"))
    paper = library.create({"title": "Zeta paper", "citekey": "Paper"})
    first = dataset(library, title="Alpha data", aliases=["Mobility fixture"], author=[{"literal": "Agency"}])
    other = dataset(library, title="Beta data")
    listing = call(library, "resource_list", sort="title", order="asc", limit=2)
    assert [v["id"] for v in listing["items"]] == [first["id"], other["id"]]
    assert listing["total"] == 3 and listing["truncated"]
    assert call(library, "resource_list", query="Mobility")["total"] == 1
    assert call(library, "resource_list", kind="paper")["items"][0]["id"] == paper["id"]
    assert call(library, "resource_list", limit=999)["limit"] == 200
    assert call(library, "resource_list", query="%")["total"] == 0
    archived = call(library, "dataset_archive", id=first["id"], expected_revision=1)
    assert archived["revision"] == 2 and archived["archived"]
    assert call(library, "resource_list")["total"] == 2
    assert call(library, "resource_list", archived=True)["items"][0]["id"] == first["id"]
    with pytest.raises(ValueError, match="archived"):
        call(library, "dataset_get", id=first["id"])
    assert call(library, "dataset_restore", id=first["id"], expected_revision=2)["id"] == first["id"]
    for field in ("title", "author", "year", "journal", "publisher", "modified", "created", "citekey", "kind", "jcr"):
        assert call(library, "resource_list", sort=field)["total"] == 3
    for args in ({"kind": "csv"}, {"sort": "title;drop table papers"}, {"order": "SIDEWAYS"}, {"archived": "false"}):
        with pytest.raises(ValueError): call(library, "resource_list", **args)


def test_bidirectional_usage_role_evidence_and_distinct_paper_counts(library):
    data = dataset(library)
    papers = [library.create({"title": f"Synthetic study {i}"}) for i in range(2)]
    release = call(library, "dataset_release_put", id=data["id"], metadata={"version": "1.0"}, expected_revision=0)
    args = {"paper_id": papers[0]["id"], "dataset_id": data["id"], "release_id": release["id"], "relation": "uses", "role": "training", "evidence": [{"quote": "Synthetic source states training usage", "page": 2}, {"source_uri": "https://example.test/docs"}], "review_status": "accepted", "expected_revision": 0}
    link = call(library, "dataset_link_put", **args)
    call(library, "dataset_link_put", **{**args, "role": "testing"})
    call(library, "dataset_link_put", **{**args, "paper_id": papers[1]["id"], "relation": "mentions", "release_id": None, "review_status": "needs-review"})
    reverse = call(library, "dataset_link_list", dataset_id=data["id"])
    assert reverse["total"] == 3 and reverse["paper_count"] == 2 and reverse["accepted_use_paper_count"] == 1
    forward = call(library, "dataset_link_list", paper_id=papers[0]["id"])
    assert forward["total"] == 2 and len(forward["items"][0]["evidence"]) == 2
    assert forward["items"][0]["paper_title"] == papers[0]["title"]
    with pytest.raises(DatasetConflictError): call(library, "dataset_link_delete", id=link["id"], expected_revision=0)
    library.archive(papers[0]["id"])
    assert call(library, "dataset_link_list", dataset_id=data["id"])["total"] == 1
    assert call(library, "dataset_link_list", dataset_id=data["id"], include_archived=True)["total"] == 3
    library.restore(papers[0]["id"])
    call(library, "dataset_link_delete", id=link["id"], expected_revision=1)
    assert call(library, "dataset_get", id=data["id"])["links_total"] == 2


def test_ai_and_unsourced_relations_cannot_become_verified_by_default(library):
    data, paper = dataset(library), library.create({"title": "Synthetic paper"})
    common = {"dataset_id": data["id"], "paper_id": paper["id"], "relation": "uses", "expected_revision": 0}
    ai = call(library, "dataset_link_put", **common, origin="ai", review_status="accepted", evidence={"quote": "AI selected source"})
    assert ai["review_status"] == "needs-review"
    assert call(library, "dataset_link_put", **common)["review_status"] == "needs-review"
    with pytest.raises(ValueError, match="supplied source"):
        call(library, "dataset_link_put", **common, review_status="accepted")
    reviewed = call(library, "dataset_link_put", id=ai["id"], expected_revision=1, origin="user", review_status="accepted")
    assert reviewed["review_status"] == "accepted" and reviewed["origin"] == "ai" and reviewed["reviewed_by"] == "user"
    with pytest.raises(ValueError, match="Evidence page"):
        call(library, "dataset_link_put", **common, evidence={"page": True})


def test_graph_promotion_preserves_local_identity_and_does_not_infer_usage(library):
    from dsh_paper_library.knowledge_graph import dispatch_graph, get_graph
    paper = library.create({"title": "Synthetic graph paper"})
    node = dispatch_graph(library, "graph_node_put", {"id": paper["id"], "type": "dataset", "label": "Synthetic local dataset", "description": "Observed in paper", "evidence": {"page": 3}})
    promoted = call(library, "dataset_graph_promote", paper_id=paper["id"], node_id=node["id"], expected_revision=0)
    assert promoted["node_preserved"] and not promoted["usage_inferred"]
    assert any(v["id"] == node["id"] for v in get_graph(library, paper["id"])["nodes"])
    assert call(library, "dataset_link_list", paper_id=paper["id"])["total"] == 0
    with pytest.raises(DatasetConflictError):
        call(library, "dataset_graph_promote", paper_id=paper["id"], node_id=node["id"], expected_revision=0)
    assert call(library, "resource_list", kind="dataset")["total"] == 1


def test_csl_and_zotero_versions_are_distinct():
    assert csl_item({"type": "dataset", "title": "CSL", "version": "2.3"})["version"] == "2.3"
    zotero = csl_item({"itemType": "dataset", "title": "Zotero", "version": 812, "versionNumber": "2026.2"})
    assert csl_item(zotero)["version"] == "2026.2"
    assert zotero["type"] == "dataset" and zotero["version"] == "2026.2"
    assert "version" not in csl_item({"itemType": "dataset", "title": "No release known", "version": 812})
    assert parse_ris("TY  - DATA\nTI  - Synthetic RIS data\nER  -")[0]["type"] == "dataset"


def test_resource_get_can_be_reused_inside_existing_shared_transaction(library):
    data = dataset(library)
    with library.lock():
        assert resource_get(library, "dataset", data["id"])["id"] == data["id"]
