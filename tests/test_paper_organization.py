"""Synthetic metadata only: user organization survives import and filters before paging."""
import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.worker import dispatch_request
from dsh_paper_library.paper_organization import normalize_tag


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setattr(Library, "_open_pdf", lambda *args: pytest.fail("Organization must not read PDFs"))
    root = str(tmp_path / "library")
    def call(action, **values):
        return dispatch_request({"action": action, "library": root, **values})
    return call


def paper(call, name="Synthetic paper", **metadata):
    return call("create", metadata={"title": name, **metadata})


def test_organization_is_independent_persistent_and_revision_checked(catalog):
    p = paper(catalog, tags=["source/topic"])
    assert p["favorite"] is False and p["manual_tags"] == [] and p["organization_modified"] is None
    changed = catalog("paper_organization_update", id=p["id"], favorite=True, tags=["  # 方法 / 深度学习 / Transformer ", "方法/深度学习/Transformer"], expected_organization_modified=None)
    assert changed["manual_tags"] == ["#方法/深度学习/Transformer"]
    assert changed["favorite"] and changed["organization_modified"]
    with pytest.raises(ValueError, match="其他窗口"):
        catalog("paper_organization_update", id=p["id"], tags=["#stale"], expected_organization_modified=None)
    no_op = catalog("paper_organization_update", id=p["id"], favorite=True)
    assert no_op == changed
    catalog("update", id=p["id"], metadata={"title": "Updated source", "tags": ["replacement"], "manual_tags": ["bad"], "favorite": False})
    again = catalog("get", id=p["id"])
    assert again["tags"] == ["replacement"]
    assert again["manual_tags"] == changed["manual_tags"] and again["favorite"]
    # Partial writes preserve the other organization field across process restarts.
    catalog("paper_organization_update", id=p["id"], favorite=False)
    final = catalog("paper_organization_update", id=p["id"], tags=[])
    assert final["manual_tags"] == [] and final["favorite"] is False


def test_filters_combine_before_pagination_and_respect_hierarchy(catalog):
    ids = []
    for i in range(7):
        p = paper(catalog, f"Synthetic {i}", tags=["method/source"] if i == 6 else [])
        ids.append(p["id"])
        catalog("paper_organization_update", id=p["id"], favorite=i % 2 == 0,
                tags=["#method/deep/transformer" if i < 5 else "#methodology"])
    catalog("dataset_put", metadata={"title": "Synthetic dataset", "tags": ["method"]}, expected_revision=0)
    result = catalog("resource_list", kind="all", favorite=True, tag="#method", query="Synthetic", sort="title", order="asc", offset=1, limit=2)
    assert result["total"] == 4
    assert [p["id"] for p in result["items"]] == [ids[2], ids[4]]
    assert all(p["resource_kind"] == "paper" for p in result["items"])
    assert catalog("resource_list", kind="dataset", favorite=True)["total"] == 0
    assert catalog("list", favorite=True, tag="#method/deep")["total"] == 3
    project = catalog("project_create", title="Synthetic project")["project"]
    catalog("project_link", id=project["id"], paper_id=ids[4])
    assert catalog("resource_list", project=project["id"], favorite=True, tag="method")["total"] == 1
    catalog("archive", id=ids[4])
    assert catalog("resource_list", favorite=True, tag="method")["total"] == 3
    assert catalog("resource_list", favorite=True, tag="method", archived=True)["total"] == 1
    with pytest.raises(ValueError, match="archived"):
        catalog("paper_organization_update", id=ids[4], favorite=False)
    catalog("restore", id=ids[4])
    assert catalog("get", id=ids[4])["favorite"]


def test_tag_candidates_include_parents_count_papers_and_page(catalog):
    a = paper(catalog, tags=["method/deep", "method/deep/model", "shared"])
    b = paper(catalog, tags=["method/source", "shared"])
    catalog("paper_organization_update", id=a["id"], favorite=True, tags=["#method/deep", "#method/deep/model", "#other"])
    found = catalog("paper_tags_list", query="method")
    counts = {item["tag"]: item["count"] for item in found["items"]}
    assert counts == {"#method": 2, "#method/deep": 1, "#method/deep/model": 1, "#method/source": 1}
    first = catalog("paper_tags_list", limit=2)
    second = catalog("paper_tags_list", offset=first["next_offset"], limit=2)
    assert first["total"] == second["total"] == 6
    assert not set(item["tag"] for item in first["items"]) & set(item["tag"] for item in second["items"])
    assert {item["tag"]: item["count"] for item in catalog("paper_tags_list", query="method", favorite=True)["items"]} == {"#method": 1, "#method/deep": 1, "#method/deep/model": 1}
    catalog("archive", id=b["id"])
    assert catalog("paper_tags_list", query="#method/source")["total"] == 0
    assert catalog("paper_tags_list", query="#method/source", archived=True)["total"] == 1


def test_literal_tag_filters_do_not_expand_sql_wildcards(catalog):
    for tag in ["#x%/part", "#xyz/part", "#x_/part", "#xZ/part", "#quote' OR 1=1/part", "#slash\\/part"]:
        p = paper(catalog)
        catalog("paper_organization_update", id=p["id"], tags=[tag])
    for tag in ["#x%", "#x_", "#quote' OR 1=1", "#slash\\"]:
        assert catalog("resource_list", tag=tag)["total"] == 1
        assert catalog("paper_tags_list", query=tag)["total"] == 2


@pytest.mark.parametrize("value", ["", "#", "#a//b", "#a/", "#a/#b", "#a\nb", 1, None, "a/" * 8 + "b", "a" * 200])
def test_tag_validation(value):
    with pytest.raises(ValueError):
        normalize_tag(value)


def test_invalid_requests_do_not_silently_widen_scope(catalog):
    p = paper(catalog)
    for action, values in [
        ("paper_organization_update", {"id": p["id"], "favorite": 1}),
        ("paper_organization_update", {"id": p["id"], "tags": "#a"}),
        ("paper_organization_update", {"id": p["id"], "tags": ["a"] * 101}),
        ("paper_organization_update", {"id": "missing", "favorite": True}),
        ("resource_list", {"favorite": "true"}),
        ("resource_list", {"tag": []}),
        ("paper_tags_list", {"limit": 101}),
        ("paper_tags_list", {"offset": True}),
        ("paper_tags_list", {"project": "missing"}),
    ]:
        with pytest.raises(ValueError):
            catalog(action, **values)


def test_external_rescan_preserves_user_organization_and_original(tmp_path, catalog):
    import os
    import pymupdf
    source = tmp_path / "synced"
    source.mkdir()
    path = source / "Example - 2026 - Synthetic external paper.pdf"
    with pymupdf.open() as doc:
        doc.new_page().insert_text((50, 50), "Synthetic source: organization must not write here.")
        doc.save(path)
    original = path.read_bytes()
    sources = [{"id": "synthetic-source", "root": str(source), "label": "Synthetic"}]
    catalog("external_scan", sources=sources)
    p = catalog("list")["items"][0]
    saved = catalog("paper_organization_update", id=p["id"], favorite=True, tags=["#manual/topic"])
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
    catalog("external_scan", sources=sources)
    refreshed = catalog("get", id=p["id"])
    assert refreshed["favorite"] and refreshed["manual_tags"] == saved["manual_tags"]
    assert refreshed["organization_modified"] == saved["organization_modified"]
    assert refreshed["tags"] == ["外部同步"]
    assert path.read_bytes() == original
