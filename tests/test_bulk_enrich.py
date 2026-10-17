"""bulk_enrich 离线测试：合成语料 + 注入式 fake providers，不访问网络。"""
import json
from pathlib import Path

from dsh_paper_library.core import Library, dispatch
from dsh_paper_library import bulk_enrich


def make_pdf(path, text="合成论文。", pages=1):
    import pymupdf as fitz
    path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open() as doc:
        for index in range(pages):
            doc.new_page(width=400, height=500).insert_text((50, 80 + index * 10), text)
        doc.save(path)
    return path


def bootstrap(tmp_path, files):
    library = Library(tmp_path / "library")
    base = tmp_path / "synced"
    for name, text in files.items():
        make_pdf(base / name, text)
    sources = [{"id": "paperassets-test", "root": str(base), "label": "测试源"}]
    dispatch({"library": str(tmp_path / "library"), "action": "external_scan", "sources": sources})
    return library, sources[0]


def fake_fetchers(calls):
    def arxiv(arxiv_id):
        calls.append(("arxiv", arxiv_id))
        if arxiv_id == "2411.17019":
            return {
                "itemType": "preprint",
                "title": "UniST a prompt-empowered universal model for urban spatio-temporal prediction",
                "creators": [{"firstName": " Yuan", "family": "Yuan", "creatorType": "author"}],
                "date": "2024-11-26",
                "url": "https://arxiv.org/abs/2411.17019",
                "archiveID": "arXiv:2411.17019",
            }
        return None

    def crossref_doi(doi):
        calls.append(("doi", doi))
        if doi == "10.5555/deep-learning-cities":
            return {
                "itemType": "journalArticle",
                "title": "Deep learning for cities",
                "creators": [{"firstName": "Malone", "family": "Malone", "creatorType": "author"}],
                "date": "2019", "DOI": "10.5555/deep-learning-cities",
                "publicationTitle": "Cities",
            }
        return None

    def crossref_title(title):
        calls.append(("title", title))
        if "deep learning" in title.lower():
            return {
                "itemType": "journalArticle",
                "title": "Deep learning for cities",
                "creators": [{"firstName": "Malone", "family": "Malone", "creatorType": "author"}],
                "date": "2019", "DOI": "10.5555/deep-learning-cities",
                "publicationTitle": "Cities",
            }
        return None

    return {"arxiv": arxiv, "crossref_doi": crossref_doi, "crossref_title": crossref_title}


def test_enrich_fills_missing_fields_and_records_provenance(tmp_path):
    calls = []
    library, source = bootstrap(tmp_path, {
        "2411.17019v1.pdf": "UniST 论文全文。",
        "Malone - 2019 - Deep learning for cities.pdf": "Deep learning for cities 全文。",
    })
    report = bulk_enrich.enrich_source(library, source, fake_fetchers(calls), apply=True)
    assert (report["enriched"], report["unmatched"], report["failures"]) == (2, 0, 0)

    papers = dispatch({"library": str(tmp_path / "library"), "action": "list", "limit": 20})["items"]
    by_title = {paper["title"]: paper for paper in papers}
    assert by_title["UniST a prompt-empowered universal model for urban spatio-temporal prediction"].get("DOI", "") == ""
    rows = library.db.execute("SELECT metadata FROM papers").fetchall()
    enriched = [json.loads(row["metadata"]) for row in rows]
    by_meta = {value["title"]: value for value in enriched}
    unist = by_meta["UniST a prompt-empowered universal model for urban spatio-temporal prediction"]
    assert unist.get("DOI", "") == ""
    assert unist["parse"]["field_sources"]["author"] == "arxiv-api"
    cities = by_meta["Deep learning for cities"]
    assert cities["DOI"] == "10.5555/deep-learning-cities"
    assert cities["parse"]["field_sources"]["DOI"] == "crossref-api"
    assert cities["parse"]["enriched"]["via"] == "crossref-title"


def test_unmatched_stays_visible_and_catalog_untouched(tmp_path):
    calls = []
    library, source = bootstrap(tmp_path, {"0112110v2.pdf": "无元数据线索的扫描件。"})
    report = bulk_enrich.enrich_source(library, source, fake_fetchers(calls), apply=True)
    assert report["unmatched"] == 1
    out_dir = report["report_dir"]
    unmatched = (Path(out_dir) / "unmatched.tsv").read_text()
    assert "0112110v2" in unmatched
    row = library.db.execute("SELECT metadata FROM papers").fetchone()
    value = json.loads(row["metadata"])
    assert value["parse"]["field_sources"]["title"] == "synced-filename"


def test_dry_run_leaves_catalog_and_reports_untouched(tmp_path):
    library, source = bootstrap(tmp_path, {"2411.17019v1.pdf": "UniST 论文全文。"})
    report = bulk_enrich.enrich_source(library, source, fake_fetchers([]), apply=False)
    assert report["applied"] is False
    assert report["report_dir"] == ""
    row = library.db.execute("SELECT metadata FROM papers").fetchone()
    value = json.loads(row["metadata"])
    assert "arxiv-api" not in json.dumps(value.get("parse", {}))
