"""Reading projects: a project groups many papers, and a paper may belong to many projects."""
import pytest

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.projects import SCHEMA_SQL


@pytest.fixture
def catalog(tmp_path):
    value = Library(tmp_path / "library")
    yield value
    value.close()


def call(catalog, action, **values):
    return dispatch({"library": str(catalog.root), "action": action, **values})


def paper(catalog, index):
    return catalog.create({"title": f"Synthetic paper {index}", "citekey": f"synth{index}", "issued": {"date-parts": [[2020 + index]]}})


def project(catalog, title="城市感知"):
    return call(catalog, "project_create", title=title)["project"]


def test_projects_are_created_listed_updated_and_archived_in_the_catalog(catalog):
    created = call(catalog, "project_create", title="城市感知", description="综述项目", tags=["urban", "sensing", "urban"])
    identifier = created["project"]["id"]
    assert identifier.startswith("p-") and len(identifier) == 14
    assert created["created"] is True
    assert created["project"]["tags"] == ["urban", "sensing"], "duplicate tags collapse"
    assert created["project"]["paper_count"] == 0
    assert catalog.db.execute("PRAGMA user_version").fetchone()[0] == 3
    assert catalog.db.execute("SELECT count(*) FROM sqlite_master WHERE name IN ('projects','project_papers','project_archive')").fetchone()[0] == 3

    resolved = call(catalog, "project_update", id=identifier, title="城市感知 II", description="", tags=[])
    assert resolved["project"]["title"] == "城市感知 II"
    assert resolved["project"]["description"] == "" and resolved["project"]["tags"] == []

    assert call(catalog, "project_list")["total"] == 1
    assert call(catalog, "project_list", query="感知")["total"] == 1
    assert call(catalog, "project_list", query="不存在")["total"] == 0
    assert call(catalog, "project_list", query="urban")["total"] == 0, "tags were cleared"

    archived = call(catalog, "project_archive", id=identifier)
    assert archived["project"]["archived"] is True
    assert call(catalog, "project_list")["total"] == 0
    assert call(catalog, "project_list", include_archived=True)["total"] == 1
    with pytest.raises(ValueError, match="已归档"):
        call(catalog, "project_get", id=identifier)
    assert call(catalog, "project_get", id=identifier, include_archived=True)["project"]["id"] == identifier
    assert call(catalog, "project_restore", id=identifier)["project"]["archived"] is False
    assert call(catalog, "project_list")["total"] == 1


def test_a_paper_belongs_to_many_projects_and_a_project_to_many_papers(catalog):
    first, second, third = paper(catalog, 1), paper(catalog, 2), paper(catalog, 3)
    left = project(catalog, "左项目")
    right = project(catalog, "右项目")
    for identifier, entry in ((left["id"], first), (left["id"], second), (right["id"], second), (right["id"], third)):
        linked = call(catalog, "project_link", id=identifier, paper_id=entry["id"])
        assert linked["linked"] is True and linked["duplicate"] is False

    left_view = call(catalog, "project_get", id=left["id"])
    assert [item["id"] for item in left_view["papers"]] == [first["id"], second["id"]]
    assert left_view["project"]["paper_count"] == 2
    assert left_view["papers"][0]["title"] == "Synthetic paper 1"
    assert left_view["papers"][0]["year"] == 2021

    memberships = call(catalog, "project_for_paper", paper_id=second["id"])
    assert {item["title"] for item in memberships["projects"]} == {"左项目", "右项目"}, "one paper can sit in several projects"
    assert call(catalog, "project_for_paper", paper_id=first["id"])["total"] == 1
    assert call(catalog, "project_for_paper", paper_id="missing")["total"] == 0

    # Linking twice is idempotent rather than an error, and unlinking only removes the edge.
    again = call(catalog, "project_link", id=left["id"], paper_id=first["id"])
    assert again["duplicate"] is True and again["linked"] is False
    unlinked = call(catalog, "project_unlink", id=left["id"], paper_id=first["id"])
    assert unlinked["unlinked"] is True and unlinked["project"]["paper_count"] == 1
    assert call(catalog, "project_get", id=left["id"])["papers"][0]["id"] == second["id"]
    assert call(catalog, "project_unlink", id=left["id"], paper_id=first["id"])["unlinked"] is False
    assert catalog.get(first["id"])["title"] == "Synthetic paper 1", "unlinking never touches the paper"


def test_project_edges_refuse_unknown_papers_and_archived_papers(catalog):
    entry = paper(catalog, 1)
    target = project(catalog, "项目")
    with pytest.raises(ValueError, match="不在活动文献库"):
        call(catalog, "project_link", id=target["id"], paper_id="p-does-not-exist")
    call(catalog, "archive", id=entry["id"])
    with pytest.raises(ValueError, match="不在活动文献库"):
        call(catalog, "project_link", id=target["id"], paper_id=entry["id"])
    call(catalog, "restore", id=entry["id"])
    assert call(catalog, "project_link", id=target["id"], paper_id=entry["id"])["linked"] is True
    with pytest.raises(ValueError, match="不存在"):
        call(catalog, "project_link", id="p-missing", paper_id=entry["id"])
    with pytest.raises(ValueError, match="项目标识无效"):
        call(catalog, "project_get", id="not a project id")


def test_project_inputs_are_bounded_and_normalised(catalog):
    with pytest.raises(ValueError, match="标题不能为空"):
        call(catalog, "project_create", title="   ")
    with pytest.raises(ValueError, match="超过 200 个字符"):
        call(catalog, "project_create", title="x" * 201)
    with pytest.raises(ValueError, match="说明超过 2000 个字符"):
        call(catalog, "project_create", title="ok", description="x" * 2001)
    with pytest.raises(ValueError, match="标签最多 20 个"):
        call(catalog, "project_create", title="ok", tags=[f"t{index}" for index in range(21)])
    with pytest.raises(ValueError, match="项目标签不能为空"):
        call(catalog, "project_create", title="ok", tags=["  "])
    created = call(catalog, "project_create", title="  两边有空格  ")["project"]
    assert created["title"] == "两边有空格"
    with pytest.raises(ValueError, match="limit 必须是 1–200"):
        call(catalog, "project_list", limit=0)
    with pytest.raises(ValueError, match="offset 必须是 0–100000"):
        call(catalog, "project_list", offset=-1)
    with pytest.raises(ValueError, match="Unknown project action"):
        call(catalog, "project_frobnicate")


def test_the_project_schema_is_additive_for_an_existing_catalog(tmp_path):
    """An older catalog keeps its papers: the migration only adds tables and a version."""
    root = tmp_path / "library"
    created = Library(root)
    entry = created.create({"title": "Existing paper", "citekey": "existing"})
    created.close()

    reopened = Library(root)
    try:
        assert reopened.get(entry["id"])["title"] == "Existing paper"
        assert reopened.db.execute("PRAGMA user_version").fetchone()[0] == 3
        reopened.db.executescript(SCHEMA_SQL)  # idempotent by construction
        value = dispatch({"library": str(root), "action": "project_create", "title": "迁移后项目"})
        assert value["project"]["paper_count"] == 0
        assert dispatch({"library": str(root), "action": "project_link", "id": value["project"]["id"], "paper_id": entry["id"]})["linked"] is True
    finally:
        reopened.close()
