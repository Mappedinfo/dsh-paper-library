import os

import pymupdf as fitz
import pytest

from dsh_paper_library import catalog_search, projects
from dsh_paper_library.core import Library, dispatch


@pytest.fixture
def library(tmp_path):
    value = Library(tmp_path / "library")
    yield value
    value.close()


def attach(library, title, pages):
    source = library.root.parent / f"{title}.pdf"
    with fitz.open() as doc:
        for text in pages:
            page = doc.new_page()
            if text:
                page.insert_text((50, 60), text)
        doc.save(source)
    item = library.create({"title": title})
    library.attach(item["id"], str(source))
    return item["id"], source


def search(library, query="body-only phrase", **values):
    return dispatch({"library": str(library.root), "action": "catalog_text_search", "query": query, **values})


def all_batches(library, **values):
    cursor = None
    for _ in range(10):
        result = search(library, cursor=cursor, **values)
        yield result
        cursor = result["next_cursor"]
        if cursor is None:
            return
    pytest.fail("Search did not finish")


def test_catalog_search_scans_the_entire_scope_in_read_only_batches(library, monkeypatch):
    first, source = attach(library, "Synthetic article A", ["BODY-ONLY PHRASE", "", "Later body-only phrase"])
    second, _ = attach(library, "Synthetic article B", ["body-only phrase outside the project"])
    archived, _ = attach(library, "Synthetic trashed article", ["body-only phrase in trash"])
    missing, _ = attach(library, "Synthetic missing PDF", ["body-only phrase in missing attachment"])
    library.pdf_path(missing).unlink()
    metadata_only = library.create({"title": "body-only phrase in the title"})["id"]
    project = projects.create(library, title="Synthetic reading project")["project"]["id"]
    for paper_id in (first, archived, metadata_only):
        projects.link(library, id=project, paper_id=paper_id)
    library.archive(archived)

    managed = library.pdf_path(first)
    before = source.read_bytes(), managed.read_bytes()

    def no_render(*args, **kwargs):
        pytest.fail("Text search must not render pages")

    monkeypatch.setattr(fitz.Page, "get_pixmap", no_render)
    monkeypatch.setattr(catalog_search, "PAGE_LIMIT", 2)
    monkeypatch.setattr(catalog_search, "FILE_LIMIT", 1)
    batches = list(all_batches(library, limit=1))
    hits = [hit for batch in batches for hit in batch["matches"]]
    assert {(hit["paper_id"], hit["page"]) for hit in hits} == {(first, 1), (first, 3), (second, 1)}
    assert hits and len(hits) == 3
    assert any(hit["snippet"] == "BODY-ONLY PHRASE" for hit in hits)
    assert all(len(batch["matches"]) <= 1 and batch["scanned_pages"] <= 2 for batch in batches)
    assert batches[-1]["pdfs_completed"] == batches[-1]["pdf_count"] == 3
    assert batches[-1]["without_pdf"] == 1
    assert sum(batch["unreadable_pdfs"] for batch in batches) == 1
    assert sum(batch["no_text_pages"] for batch in batches) == 1
    scoped = list(all_batches(library, project_id=project))
    assert [hit["page"] for batch in scoped for hit in batch["matches"]] == [1, 3]
    assert scoped[-1]["pdf_count"] == 1
    assert before == (source.read_bytes(), managed.read_bytes())


def test_cursor_rejects_keyword_project_attachment_and_membership_changes(library):
    paper, _ = attach(library, "Synthetic versioned PDF", ["body-only phrase", "body-only phrase again"])
    cursor = search(library, limit=1)["next_cursor"]
    project = projects.create(library, title="Synthetic scope")["project"]["id"]
    projects.link(library, id=project, paper_id=paper)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, query="other", cursor=cursor)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, project_id=project, cursor=cursor)
    path = library.pdf_path(paper)
    current = path.stat()
    os.utime(path, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000_000))
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, cursor=cursor)
    scoped_cursor = search(library, project_id=project, limit=1)["next_cursor"]
    projects.unlink(library, id=project, paper_id=paper)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, project_id=project, cursor=scoped_cursor)


def test_empty_scope_and_invalid_requests_are_distinct(library):
    empty = search(library)
    assert empty["matches"] == []
    assert empty["pdf_count"] == 0
    assert empty["next_cursor"] is None
    for values in ({"query": ""}, {"limit": 41}, {"cursor": {"page": 1}}, {"project_id": "../outside"}):
        with pytest.raises(ValueError):
            search(library, **values)
