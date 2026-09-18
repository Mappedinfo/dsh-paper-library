"""Synthetic catalogue management and supplied metadata provenance contracts."""
import hashlib
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, csl_item, dispatch


def request(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def ranking(quartile="Q2", year=2025, category="Synthetic category"):
    return {"system": "JCR", "year": year, "category": category, "quartile": quartile,
            "source": "Synthetic test fixture, not real journal data", "verified_at": "2026-09-14"}


def metadata():
    return {"title": "Synthetic catalogue paper", "author": [{"family": "Wang", "given": "Example",
            "affiliation": [{"name": "Synthetic Institution", "source": "Fixture title page"}]}],
            "issued": {"date-parts": [[2026, 8, 5]]}, "publication_dates": {"published": "2026-08-05",
            "online": "2026-07", "received": "2025-11-09", "accepted": "2026-06-02"},
            "journal_rankings": [ranking()], "container-title": "Synthetic Journal"}


def no_pdf(*args, **kwargs):
    raise AssertionError("Metadata-only operation opened a PDF")


def test_manual_create_list_edit_archive_restore_never_open_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(Library, "_open_pdf", no_pdf)
    blank = request(tmp_path, "create")
    assert blank["title"] == "Untitled" and not blank["pdf"]
    assert "author" not in blank and "publication_dates" not in blank and "journal_rankings" not in blank
    created = request(tmp_path, "create", metadata=metadata())
    assert created["provenance"]["source"] == "manual"
    edited = request(tmp_path, "update", id=created["id"], metadata={"title": "Revised Synthetic catalogue paper"})
    assert edited["publication_dates"] == metadata()["publication_dates"]
    assert edited["journal_rankings"] == metadata()["journal_rankings"]
    assert request(tmp_path, "list", query="Synthetic Institution")["total"] == 1
    archived = request(tmp_path, "archive", id=created["id"])
    assert archived["archived"] and archived["archived_at"]
    assert request(tmp_path, "archive", id=created["id"])["archived_at"] == archived["archived_at"]
    assert request(tmp_path, "list", query="Synthetic")["total"] == 0
    trash = request(tmp_path, "list", query="Synthetic", archived=True)
    assert trash["total"] == 1 and trash["active_count"] == 1 and trash["archived_count"] == 1
    assert request(tmp_path, "get", id=created["id"], include_archived=True)["id"] == created["id"]
    with pytest.raises(ValueError, match="archived"):
        request(tmp_path, "get", id=created["id"])
    with pytest.raises(ValueError, match="archived"):
        request(tmp_path, "update", id=created["id"], metadata={"title": "Not allowed"})
    assert [item["id"] for item in request(tmp_path, "export_metadata")["items"]] == [blank["id"]]
    counts = request(tmp_path, "status")
    assert (counts["count"], counts["archived_count"], counts["total_count"]) == (1, 1, 2)
    restored = request(tmp_path, "restore", id=created["id"])
    assert not restored["archived"] and restored["archived_at"] is None
    assert restored["id"] == created["id"] and restored["created"] == created["created"]
    assert restored["modified"] == edited["modified"]
    assert request(tmp_path, "restore", id=created["id"])["id"] == created["id"]


def test_server_sorting_and_page_caps_are_stable_and_metadata_only(tmp_path, monkeypatch):
    monkeypatch.setattr(Library, "_open_pdf", no_pdf)
    library = Library(tmp_path / "library")
    try:
        with library.lock():
            for index in range(205):
                library._upsert({"title": f"Synthetic {204-index:03}", "citekey": f"key{index:03}",
                    "author": [{"family": f"Author {index:03}"}], "issued": {"date-parts": [[2000 + index % 20]]},
                    "container-title": f"Journal {index % 3}", "journal_rankings": [ranking(f"Q{1 + index % 4}")]})
        with library.lock():
            library.db.execute("UPDATE papers SET modified='2026-01-01',created='2025-01-01'")
    finally:
        library.close()
    first = request(tmp_path, "list", sort="title", order="asc", limit=1000)
    second = request(tmp_path, "list", sort="title", order="asc", limit=1000, offset=200)
    assert first["limit"] == 200 and first["total"] == 205 and len(second["items"]) == 5
    assert len({item["id"] for item in first["items"] + second["items"]}) == 205
    assert first["items"][0]["title"] == "Synthetic 000"
    assert second["items"][-1]["title"] == "Synthetic 204"
    assert request(tmp_path, "list", query="Synthetic", sort="title", order="desc", limit=1)["items"][0]["title"] == "Synthetic 204"
    assert request(tmp_path, "list", sort="author", limit=1)["items"][0]["author"][0]["family"] == "Author 000"
    assert request(tmp_path, "list", sort="year", limit=1)["items"][0]["issued"]["date-parts"][0][0] == 2019
    assert request(tmp_path, "list", sort="journal", limit=1)["items"][0]["container-title"] == "Journal 0"
    assert request(tmp_path, "list", sort="citekey", limit=1)["items"][0]["citekey"] == "key000"
    assert request(tmp_path, "list", sort="jcr", limit=1)["items"][0]["journal_rankings"][0]["quartile"] == "Q1"
    for field in ("modified", "created"):
        rows = request(tmp_path, "list", sort=field, limit=10)["items"]
        assert [row["id"] for row in rows] == sorted(row["id"] for row in rows)
    for invalid in ({"sort": "title;DROP TABLE papers"}, {"sort": []}, {"order": "asc"},
                    {"sort": "title", "order": "sideways"}, {"archived": "false"}):
        with pytest.raises(ValueError):
            request(tmp_path, "list", **invalid)


def test_jcr_sort_uses_latest_year_worst_category_and_missing_last(tmp_path):
    first = request(tmp_path, "create", metadata={"title": "Mixed", "journal_rankings": [ranking("Q1", 2024), ranking("Q2", 2025), ranking("Q4", 2025, "Other category")]})
    second = request(tmp_path, "create", metadata={"title": "Single", "journal_rankings": [ranking("Q2")]})
    missing = request(tmp_path, "create", metadata={"title": "Unknown"})
    assert [row["id"] for row in request(tmp_path, "list", sort="jcr")["items"]] == [second["id"], first["id"], missing["id"]]
    assert [row["id"] for row in request(tmp_path, "list", sort="jcr", order="desc")["items"]] == [first["id"], second["id"], missing["id"]]


def test_rich_metadata_roundtrips_in_portable_pdf_and_archive_preserves_everything(tmp_path):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((60, 60), "Synthetic source for metadata and archive roundtrip")
        annotation = page.add_text_annot((80, 80), "Synthetic external note")
        annotation.update()
        doc.save(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    first = request(tmp_path, "create", metadata=metadata())
    second = request(tmp_path, "create", metadata={"title": "Related synthetic paper"})
    request(tmp_path, "attach", id=first["id"], path=str(source))
    request(tmp_path, "link", source=first["id"], target=second["id"], relation="supports", note="Synthetic evidence")
    item = request(tmp_path, "update", id=first["id"], metadata={"publication_dates": {"published": "2026-08", "accepted": "2026-07-01"}})
    pdf = request(tmp_path, "export_pdf", id=item["id"])["path"]
    before = hashlib.sha256(Path(pdf).read_bytes()).hexdigest()
    request(tmp_path, "archive", id=item["id"])
    assert hashlib.sha256(Path(pdf).read_bytes()).hexdigest() == before
    with pytest.raises(ValueError, match="archived"):
        request(tmp_path, "export_pdf", id=item["id"])
    request(tmp_path, "restore", id=item["id"])
    assert request(tmp_path, "annotations", id=item["id"])["annotations"][0]["comment"] == "Synthetic external note"
    with sqlite3.connect(tmp_path / "library" / "catalog.sqlite3") as db:
        assert db.execute("SELECT note FROM links WHERE source=?", (item["id"],)).fetchone()[0] == "Synthetic evidence"
    fresh = dispatch({"library": str(tmp_path / "fresh"), "action": "import", "path": pdf})["items"][0]
    assert fresh["author"] == item["author"] and fresh["journal_rankings"] == item["journal_rankings"]
    assert fresh["publication_dates"] == item["publication_dates"]
    assert fresh["citekey"] == item["citekey"]
    with fitz.open(pdf) as doc:
        portable = json.loads(doc.embfile_get("paper-library.csl.json"))
        assert "archived" not in portable and "archived_at" not in portable
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash


@pytest.mark.parametrize("override", [
    {"publication_dates": {"received": "2026-02-29"}}, {"publication_dates": {"accepted": "2026-13"}},
    {"publication_dates": {"unknown": "2026"}}, {"issued": {"date-parts": [[2026, 2, 31]]}},
    {"journal_rankings": [ranking("Q5")]}, {"journal_rankings": [{**ranking(), "source": ""}]},
    {"journal_rankings": [{**ranking(), "year": "2025"}]}, {"journal_rankings": [{**ranking(), "year": True}]},
    {"journal_rankings": [{**ranking(), "category": ""}]}, {"journal_rankings": [ranking()] * 31},
    {"author": [{"family": "Example", "affiliation": [{"name": "x" * 501}]}]},
    {"author": [{"literal": "Example", "affiliation": [{"name": "Institution"}] * 31}]},
    {"abstract": "x" * (256 * 1024)},
])
def test_invalid_rich_metadata_rejects_before_catalog_mutation(tmp_path, override):
    item = request(tmp_path, "create", metadata=metadata())
    with pytest.raises(ValueError):
        request(tmp_path, "update", id=item["id"], metadata=override)
    assert request(tmp_path, "get", id=item["id"])["modified"] == item["modified"]


def test_archived_duplicate_cannot_be_silently_recreated_or_restored(tmp_path):
    item = request(tmp_path, "create", metadata={"title": "Synthetic", "DOI": "10.1234/synthetic"})
    request(tmp_path, "archive", id=item["id"])
    with pytest.raises(ValueError, match="record"):
        request(tmp_path, "create", metadata={"title": "Again", "DOI": "10.1234/synthetic"})
    imported = request(tmp_path, "import", items=[{"title": "Again", "DOI": "10.1234/synthetic"}])
    assert imported["imported"] == 0 and "archived" in imported["warnings"][0]
    assert request(tmp_path, "list", archived=True)["total"] == 1
    assert request(tmp_path, "list")["total"] == 0


def test_legacy_link_rechecks_archive_after_obtaining_the_write_lock(tmp_path, monkeypatch):
    library = Library(tmp_path / "library")
    competitor = Library(tmp_path / "library")
    try:
        source = library.create({"title": "Synthetic source"})
        target = library.create({"title": "Synthetic target"})
        original_lock = library.lock

        @contextmanager
        def archive_before_lock():
            # Deterministically model a second worker winning the shared write
            # lock while this link operation waits to enter its critical section.
            competitor.archive(target["id"])
            with original_lock():
                yield

        monkeypatch.setattr(library, "lock", archive_before_lock)
        with pytest.raises(ValueError, match="archived"):
            library.link(source["id"], target["id"], relation="supports", note="Synthetic assertion")
        assert library.db.execute("SELECT count(*) FROM links").fetchone()[0] == 0
        monkeypatch.setattr(library, "lock", original_lock)
        library.restore(target["id"])
        assert library.link(source["id"], target["id"], relation="supports")["target"] == target["id"]
    finally:
        competitor.close()
        library.close()


def test_old_catalog_migrates_search_once_and_preserves_original_columns(tmp_path):
    library = Library(tmp_path / "library")
    try:
        original = library.create(metadata())
        with library.lock():
            library.db.execute("PRAGMA user_version=0")
            library.db.execute("DELETE FROM paper_search")
    finally:
        library.close()
    assert request(tmp_path, "list", query="2026")["total"] == 1
    assert request(tmp_path, "list", query="Synthetic Journal")["items"][0]["id"] == original["id"]
    with sqlite3.connect(tmp_path / "library" / "catalog.sqlite3") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3, "the catalog is at the project-era schema version"
        assert len(db.execute("PRAGMA table_info(papers)").fetchall()) == 8
    assert csl_item({"author": [{"family": "Test", "affiliation": "Synthetic Institution"}]})["author"][0]["affiliation"] == [{"name": "Synthetic Institution"}]
