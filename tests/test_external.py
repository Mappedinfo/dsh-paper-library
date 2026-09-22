"""Synced corpora are indexed by symlink: no copies, no writes to the source tree."""
import json
import os
from pathlib import Path

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch


def make_pdf(path, text="Evidence from the synced paper.", pages=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open() as doc:
        for index in range(pages):
            doc.new_page(width=400, height=500).insert_text((50, 80 + index * 10), text)
        doc.save(path)
    return path


def request(root, action, **kw):
    return dispatch({"library": str(root / "library"), "action": action, **kw})


def corpus(root, files):
    base = root / "synced"
    for name, text in files.items():
        make_pdf(base / name, text)
    return [{"id": "synced-academic", "root": str(base), "label": "同步的学术资料"}], base


def test_scan_stages_symlinks_and_reads_evidence_from_filenames(tmp_path):
    sources, base = corpus(tmp_path, {
        "Collection A/Liu 等 - 2023 - STAEformer for traffic forecasting.pdf": "A",
        "Collection A/2020 - 空间交互分析方法.pdf": "B",
        "Collection B/0112110v1.pdf": "C",
        "Collection B/Malone - 2019 - Deep learning for cities.pdf": "D",
    })
    report = request(tmp_path, "external_scan", sources=sources)
    source = report["sources"][0]
    assert (source["indexed"], source["walked"], source["failures"], source["truncated"]) == (4, 4, [], False)
    assert source["root"] == str(base)

    papers = request(tmp_path, "list", limit=20)["items"]
    titles = sorted(paper["title"] for paper in papers)
    assert titles == sorted([
        "STAEformer for traffic forecasting",
        "空间交互分析方法",
        "0112110v1",
        "Deep learning for cities",
    ])
    by_title = {paper["title"]: paper for paper in papers}
    assert by_title["STAEformer for traffic forecasting"]["author"] == [{"family": "Liu"}]
    assert by_title["STAEformer for traffic forecasting"]["issued"] == {"date-parts": [[2023]]}
    assert by_title["Deep learning for cities"]["author"] == [{"family": "Malone"}]
    assert by_title["空间交互分析方法"]["issued"] == {"date-parts": [[2020]]}
    assert all(paper["title"] != "STAEformer" for paper in papers)
    assert by_title["0112110v1"].get("author") is None
    for paper in papers:
        assert paper["parse"]["status"] == "external-index"
        assert paper["parse"]["needs_review"] is True
        assert paper["parse"]["field_sources"]["title"] == "synced-filename"
        assert paper["external_source"]["synced"] is True
        assert paper["tags"] == ["外部同步"]
        assert paper["external_source"]["size"] > 0

    staged = tmp_path / "library" / "external"
    links = sorted(path for path in staged.rglob("*") if path.is_symlink())
    assert len(links) == 4
    for link in links:
        assert Path(os.readlink(link)).is_file()
        assert Path(os.readlink(link)).is_relative_to(base)
    instructions = staged / "README.md"
    assert instructions.is_file() and "符号链接" in instructions.read_text(encoding="utf-8")
    assert (instructions.stat().st_mode & 0o777) == 0o600

    # Nothing was copied, and the synced tree was not touched.
    assert not any((tmp_path / "library" / "pdfs").iterdir()) if (tmp_path / "library" / "pdfs").is_dir() else True
    before = sorted((path.name, path.stat().st_size) for path in base.rglob("*.pdf"))
    request(tmp_path, "external_scan", sources=sources)
    assert sorted((path.name, path.stat().st_size) for path in base.rglob("*.pdf")) == before

    first = by_title["STAEformer for traffic forecasting"]
    page = request(tmp_path, "page", id=first["id"], page=1, scale=1)
    assert page["page_count"] == 1 and len(page["image"]) > 100
    assert request(tmp_path, "status")["external_indexed"] == 4
    assert request(tmp_path, "status")["external_missing"] == 0


def test_rescan_skips_unchanged_and_refreshes_changed_files(tmp_path):
    sources, base = corpus(tmp_path, {"Paper One - 2021 - First study.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    again = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (again["indexed"], again["skipped"], again["refreshed"]) == (0, 1, 0)

    target = base / "Paper One - 2021 - First study.pdf"
    make_pdf(target, "A longer body that changes the file size.", pages=2)
    changed = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (changed["indexed"], changed["skipped"], changed["refreshed"]) == (0, 0, 1)
    papers = request(tmp_path, "list", limit=10)["items"]
    assert len(papers) == 1
    assert papers[0]["external_source"]["size"] == target.stat().st_size


def test_missing_file_is_flagged_not_deleted_and_restored(tmp_path):
    sources, base = corpus(tmp_path, {"Kept - 2018 - A study.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    paper = request(tmp_path, "list", limit=10)["items"][0]
    target = base / "Kept - 2018 - A study.pdf"
    body = target.read_bytes()
    target.unlink()

    report = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (report["missing"], report["indexed"]) == (1, 0)
    staged = tmp_path / "library" / "external" / "synced-academic" / "Kept - 2018 - A study.pdf"
    assert not staged.exists()
    still_there = request(tmp_path, "get", id=paper["id"])
    assert still_there["external_source"]["missing"] is True
    assert still_there["title"] == "A study"
    with pytest.raises(ValueError, match="Synced PDF is missing"):
        request(tmp_path, "page", id=paper["id"], page=1, scale=1)
    assert request(tmp_path, "status")["external_missing"] == 1

    target.write_bytes(body)
    restored = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (restored["refreshed"], restored["indexed"]) == (1, 0)
    assert request(tmp_path, "get", id=paper["id"])["external_source"].get("missing") in (None, False)
    assert request(tmp_path, "page", id=paper["id"], page=1, scale=1)["page_count"] == 1

    # prune drops the stale link but never the catalog record.
    target.unlink()
    request(tmp_path, "external_scan", sources=sources)
    pruned = request(tmp_path, "external_prune", sources=sources, source="synced-academic")
    assert pruned["removed"] == 1
    assert request(tmp_path, "get", id=paper["id"])["title"] == "A study"


def test_first_write_promotes_a_managed_copy_and_leaves_the_source_alone(tmp_path):
    sources, base = corpus(tmp_path, {"Chen - 2022 - Cities and models.pdf": "Original body"})
    request(tmp_path, "external_scan", sources=sources)
    paper = request(tmp_path, "list", limit=10)["items"][0]
    target = base / "Chen - 2022 - Cities and models.pdf"
    original = target.read_bytes()

    request(tmp_path, "annotate", id=paper["id"], page=1, type="highlight", rects=[[50, 70, 200, 90]], text="Original body")
    promoted = request(tmp_path, "get", id=paper["id"])
    assert promoted["pdf_filename"].startswith("Chen-2022-Cities-and-models--")
    assert promoted["external_source"]["promoted_path"].startswith("pdfs/")
    assert promoted["external_source"]["synced"] is True
    managed = tmp_path / "library" / promoted["external_source"]["promoted_path"]
    assert managed.is_file() and managed.read_bytes()[:5] == b"%PDF-"
    # The synced file is byte-identical: the library never wrote through the link,
    # and the staged link is gone until a rescan rebuilds the address for it.
    assert target.read_bytes() == original
    staged_link = tmp_path / "library" / "external" / "synced-academic" / target.name
    assert not staged_link.is_symlink()

    # A promotion before any write copies the file exactly and still leaves the source alone.
    elsewhere = make_pdf(tmp_path / "synced" / "Ng - 2015 - Unedited study.pdf", "Untouched body")
    body = elsewhere.read_bytes()
    request(tmp_path, "external_scan", sources=sources)
    untouched = [paper for paper in request(tmp_path, "list", limit=20)["items"] if paper["title"] == "Unedited study"][0]
    copied = request(tmp_path, "external_promote", id=untouched["id"])
    assert Path(copied["path"]).read_bytes() == body
    assert elsewhere.read_bytes() == body
    assert request(tmp_path, "get", id=untouched["id"])["external_source"]["promoted_path"] == copied["path"].split("library/")[1]
    assert staged_link.is_symlink()  # a rescan keeps the one address complete
    assert [row["type"] for row in request(tmp_path, "annotations", id=paper["id"])["annotations"]] == ["highlight"]

    # A later write edits the managed copy, and a rescan does not demote it.
    request(tmp_path, "annotate", id=paper["id"], page=1, type="note", rects=[[50, 70, 200, 90]], comment="Follow-up")
    assert target.read_bytes() == original
    request(tmp_path, "external_scan", sources=sources)
    assert request(tmp_path, "get", id=paper["id"])["pdf_filename"] == promoted["pdf_filename"]
    assert len([row for row in request(tmp_path, "annotations", id=paper["id"])["annotations"]]) == 2

    promoted_twice = request(tmp_path, "external_promote", id=paper["id"])
    assert Path(promoted_twice["path"]).name == promoted["pdf_filename"]


def test_rename_is_followed_without_duplicating_the_record(tmp_path):
    sources, base = corpus(tmp_path, {"Old Name - 2017 - A study.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    paper = request(tmp_path, "list", limit=10)["items"][0]
    (base / "Old Name - 2017 - A study.pdf").rename(base / "New Name - 2017 - A study.pdf")

    report = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (report["renamed"], report["indexed"], report["missing"]) == (1, 0, 0)
    papers = request(tmp_path, "list", limit=10)["items"]
    assert [item["id"] for item in papers] == [paper["id"]]
    assert papers[0]["title"] == "A study"
    staged = tmp_path / "library" / "external" / "synced-academic"
    assert (staged / "New Name - 2017 - A study.pdf").is_symlink()
    assert not (staged / "Old Name - 2017 - A study.pdf").exists()


def test_scan_is_bounded_and_resumes(tmp_path):
    sources, _ = corpus(tmp_path, {f"Study {index:02d} - 2020 - Title {index}.pdf": f"body {index}" for index in range(5)})
    first = request(tmp_path, "external_scan", sources=sources, limit=2)["sources"][0]
    assert (first["indexed"], first["pending"], first["truncated"]) == (2, 3, True)
    second = request(tmp_path, "external_scan", sources=sources, limit=2)["sources"][0]
    assert (second["indexed"], second["pending"], second["truncated"]) == (2, 1, True)
    third = request(tmp_path, "external_scan", sources=sources, limit=2)["sources"][0]
    assert (third["indexed"], third["pending"], third["truncated"]) == (1, 0, False)
    assert request(tmp_path, "status")["external_indexed"] == 5
    assert len(request(tmp_path, "list", limit=20)["items"]) == 5


def test_sources_are_validated_before_any_work(tmp_path):
    with pytest.raises(ValueError, match="absolute"):
        request(tmp_path, "external_scan", sources=[{"id": "sync", "root": "relative/path"}])
    with pytest.raises(ValueError, match="lowercase"):
        request(tmp_path, "external_scan", sources=[{"id": "Bad Id", "root": str(tmp_path / "synced")}])
    with pytest.raises(ValueError, match="at most 8"):
        request(tmp_path, "external_scan", sources=[{"id": f"s{index}", "root": str(tmp_path / f"x{index}")} for index in range(9)])
    with pytest.raises(ValueError, match="inside the managed library"):
        request(tmp_path, "external_scan", sources=[{"id": "sync", "root": str(tmp_path / "library")}])
    with pytest.raises(ValueError, match="unknown external source"):
        request(tmp_path, "external_scan", sources=[{"id": "sync", "root": str(tmp_path / "synced")}], source="other")
    assert request(tmp_path, "external_status", sources=[])["sources"] == []
    with pytest.raises(ValueError, match="unknown external source"):
        request(tmp_path, "external_prune", sources=[], source="sync")


def test_status_reports_configuration_and_staged_address(tmp_path):
    sources, base = corpus(tmp_path, {"One - 2019 - A.pdf": "A"})
    empty = request(tmp_path, "external_status", sources=sources)
    assert empty["sources"][0] == {"id": "synced-academic", "label": "同步的学术资料", "root": str(base), "exists": True, "indexed": 0, "missing": 0, "scanned_at": None}
    assert empty["staged_root"] == str(tmp_path / "library" / "external")
    request(tmp_path, "external_scan", sources=sources)
    filled = request(tmp_path, "external_status", sources=sources)
    assert filled["staged_present"] is True
    assert filled["sources"][0]["indexed"] == 1 and filled["sources"][0]["scanned_at"]

    missing_root = request(tmp_path, "external_status", sources=[{"id": "gone", "root": str(tmp_path / "nowhere")}])
    assert missing_root["sources"][0]["exists"] is False
    scan = request(tmp_path, "external_scan", sources=[{"id": "gone", "root": str(tmp_path / "nowhere")}])["sources"][0]
    assert scan["exists"] is False and scan["failures"] == ["source directory is not readable"]


def test_staged_regular_file_is_never_overwritten(tmp_path):
    sources, base = corpus(tmp_path, {"Conflict - 2016 - A study.pdf": "A"})
    staged = tmp_path / "library" / "external" / "synced-academic" / "Conflict - 2016 - A study.pdf"
    staged.parent.mkdir(parents=True)
    staged.write_text("someone else's file", encoding="utf-8")
    report = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert report["indexed"] == 0 and len(report["failures"]) == 1 and "regular file" in report["failures"][0]
    assert staged.read_text(encoding="utf-8") == "someone else's file"
    assert request(tmp_path, "list", limit=10)["items"] == []
    assert request(tmp_path, "status")["external_indexed"] == 0


def test_external_and_managed_papers_coexist(tmp_path):
    sources, _ = corpus(tmp_path, {"Synced - 2023 - From the sync service.pdf": "A"})
    managed_source = make_pdf(tmp_path / "local.pdf", "Managed body")
    managed = request(tmp_path, "import", path=str(managed_source))["items"][0]
    request(tmp_path, "external_scan", sources=sources)
    synced = request(tmp_path, "list", limit=10)["items"]
    assert len(synced) == 2
    ids = {paper["id"] for paper in synced}
    assert managed["id"] in ids
    external = [paper for paper in synced if paper.get("external_source")][0]
    local = [paper for paper in synced if not paper.get("external_source")][0]
    assert external["external_source"]["id"] == "synced-academic"
    assert local["pdf_filename"].endswith(".pdf")

    exported = request(tmp_path, "export_pdf", id=external["id"])
    assert exported["filename"] == "Synced - 2023 - From the sync service.pdf"
    assert Path(exported["path"]).is_file()
    page = request(tmp_path, "page_layout", id=local["id"])
    assert page["pages"][0]["width"] == 400
    assert request(tmp_path, "page_layout", id=external["id"])["pages"][0]["width"] == 400
    assert request(tmp_path, "status")["count"] == 2


def test_library_root_refuses_to_contain_a_source(tmp_path):
    sources, base = corpus(tmp_path, {"One - 2019 - A.pdf": "A"})
    with pytest.raises(ValueError, match="contains the library's staged directory"):
        request(tmp_path, "external_scan", sources=[{"id": "sync", "root": str(tmp_path)}])
    assert base.is_dir()


def test_metadata_from_filenames_never_invents_missing_fields(tmp_path):
    sources, _ = corpus(tmp_path, {"just-a-filename.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    paper = request(tmp_path, "list", limit=10)["items"][0]
    assert paper["title"] == "just-a-filename"
    assert paper.get("author") is None and paper.get("issued") is None
    assert paper["external_source"]["relative"] == "just-a-filename.pdf"

def test_legacy_size_only_records_gain_the_rename_columns(tmp_path):
    """A library indexed before the rename index existed migrates in place."""
    sources, base = corpus(tmp_path, {"Owner - 2014 - Old schema.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    paper = request(tmp_path, "list", limit=10)["items"][0]
    library = Library(str(tmp_path / "library"))
    library.db.execute("DROP INDEX IF EXISTS external_files_place")
    library.db.execute("ALTER TABLE external_files DROP COLUMN name")
    library.db.execute("ALTER TABLE external_files DROP COLUMN parent")
    library.db.commit()
    library.close()
    (base / "Owner - 2014 - Old schema.pdf").rename(base / "Owner - 2014 - New schema.pdf")
    report = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    assert (report["renamed"], report["indexed"], report["missing"]) == (1, 0, 0)
    papers = request(tmp_path, "list", limit=10)["items"]
    assert [item["id"] for item in papers] == [paper["id"]]


def test_ambiguous_same_size_disappearances_are_not_merged(tmp_path):
    """Two vanished files of one size cannot both explain a single new name."""
    sources, base = corpus(tmp_path, {
        "One - 2013 - Alpha study.pdf": "same body",
        "Two - 2013 - Beta study.pdf": "same body",
    })
    request(tmp_path, "external_scan", sources=sources)
    before = len(request(tmp_path, "list", limit=10)["items"])
    (base / "One - 2013 - Alpha study.pdf").unlink()
    (base / "Two - 2013 - Beta study.pdf").rename(base / "Three - 2013 - Gamma study.pdf")
    report = request(tmp_path, "external_scan", sources=sources)["sources"][0]
    # The new name could belong to either vanished file, so neither record is reused:
    # one new record appears while both originals are flagged as missing.
    assert (report["renamed"], report["indexed"], report["missing"]) == (0, 1, 2)
    assert len(request(tmp_path, "list", limit=10)["items"]) == before + 1
    assert request(tmp_path, "status")["external_missing"] == 2

def test_one_directory_keeps_one_identity(tmp_path):
    """Indexing the same root under a second id must not duplicate every record."""
    sources, base = corpus(tmp_path, {"Only - 2012 - One study.pdf": "A"})
    request(tmp_path, "external_scan", sources=sources)
    before = request(tmp_path, "status")["count"]
    renamed = [{"id": "renamed-source", "root": sources[0]["root"], "label": "renamed"}]
    report = request(tmp_path, "external_scan", sources=renamed)["sources"][0]
    assert report["indexed"] == 0 and report["refreshed"] == 0
    assert report["conflict"] == "synced-academic"
    assert "已经按 id synced-academic 索引" in report["failures"][0]
    assert request(tmp_path, "status")["count"] == before
    assert len(request(tmp_path, "list", limit=10)["items"]) == 1
