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


def write_pdf(path, pages):
    with fitz.open() as doc:
        for text in pages:
            page = doc.new_page()
            if text:
                page.insert_text((50, 60), text)
        doc.save(path)


def attach(library, title, pages):
    source = library.root.parent / f"{title}.pdf"
    write_pdf(source, pages)
    item = library.create({"title": title})
    library.attach(item["id"], str(source))
    return item["id"], source


def call(library, action, **values):
    return dispatch({"library": str(library.root), "action": action, **values})


def search(library, query="body-only phrase", **values):
    return call(library, "catalog_text_search", query=query, **values)


def all_batches(library, **values):
    for _ in range(12):
        coverage = call(library, "catalog_search_prepare", **values)
        yield coverage
        if not coverage["pdfs_pending"]:
            return
    pytest.fail("Index preparation did not finish")


def test_index_prepares_in_read_only_batches_and_warm_search_does_not_open_pdfs(library, monkeypatch):
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
        pytest.fail("Text indexing must not render pages")

    monkeypatch.setattr(fitz.Page, "get_pixmap", no_render)
    monkeypatch.setattr(catalog_search, "PAGE_LIMIT", 2)
    monkeypatch.setattr(catalog_search, "FILE_LIMIT", 1)
    cold = search(library)
    assert cold["matches"] == []
    assert cold["pdfs_pending"] == 3
    batches = list(all_batches(library))
    assert len(batches) >= 3
    assert batches[-1]["pdfs_completed"] == batches[-1]["pdf_count"] == 3
    assert batches[-1]["without_pdf"] == 1
    assert batches[-1]["unreadable_pdfs"] == 1
    assert batches[-1]["no_text_pages"] == 1
    assert batches[-1]["indexed_pages"] == 3
    assert before == (source.read_bytes(), managed.read_bytes())
    assert (library.root / catalog_search.INDEX_NAME).stat().st_mode & 0o777 == 0o600

    def no_pdf(*args, **kwargs):
        pytest.fail("Warm queries and unchanged rebuilds must not reopen PDFs")

    monkeypatch.setattr(Library, "_open_pdf", no_pdf)
    assert list(all_batches(library, project_id=project))[-1]["pdfs_completed"] == 1
    cursor, hits = None, []
    for _ in range(3):
        result = search(library, limit=1, cursor=cursor)
        hits.extend(result["matches"])
        cursor = result["next_cursor"]
    assert cursor is None
    assert {(hit["paper_id"], hit["page"]) for hit in hits} == {(first, 1), (first, 3), (second, 1)}
    assert len(hits) == 3
    assert any(hit["snippet"] == "BODY-ONLY PHRASE" for hit in hits)
    scoped = search(library, project_id=project)
    assert [hit["page"] for hit in scoped["matches"]] == [1, 3]


def test_updated_attachment_invalidates_pagination_and_replaces_fts_text(library):
    paper, _ = attach(library, "Synthetic versioned PDF", ["body-only phrase", "body-only phrase again"])
    list(all_batches(library))
    cursor = search(library, limit=1)["next_cursor"]
    project = projects.create(library, title="Synthetic scope")["project"]["id"]
    projects.link(library, id=project, paper_id=paper)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, query="other", cursor=cursor)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, project_id=project, cursor=cursor)
    scoped_cursor = search(library, project_id=project, limit=1)["next_cursor"]

    path = library.pdf_path(paper)
    temp = path.with_suffix(".new.pdf")
    write_pdf(temp, ["Replacement text"])
    os.replace(temp, path)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, cursor=cursor)
    stale = search(library)
    assert stale["matches"] == []
    assert stale["pdfs_pending"] == 1
    list(all_batches(library, project_id=project))
    assert search(library)["matches"] == []
    assert [hit["page"] for hit in search(library, query="replacement")["matches"]] == [1]

    projects.unlink(library, id=project, paper_id=paper)
    with pytest.raises(catalog_search.CatalogSearchChanged):
        search(library, project_id=project, cursor=scoped_cursor)


def test_ligatures_dashes_and_line_breaks_match_a_physical_page(library):
    paper, _ = attach(library, "Synthetic compound", ["Unrelated", 'Spatio-\nTemporal Traffic Prediction: "A study"'])
    list(all_batches(library))
    for query in ("Spatio-Temporal Trafﬁc Prediction", "spatio‑temporal traffic prediction", 'prediction: "a study"', 'y"'):
        hit = search(library, query=query)["matches"][0]
        assert (hit["paper_id"], hit["page"]) == (paper, 2)
        assert "Spatio-Temporal Traffic Prediction" in hit["snippet"]


def test_empty_scope_and_invalid_requests_are_distinct(library):
    empty = search(library)
    assert empty["matches"] == []
    assert empty["pdf_count"] == 0
    assert empty["next_cursor"] is None
    for values in ({"query": ""}, {"limit": 41}, {"cursor": {"page": 1}}, {"project_id": "../outside"}):
        with pytest.raises(ValueError):
            search(library, **values)
