from contextlib import closing

import pymupdf as fitz

from dsh_paper_library.bibliography import audit
from dsh_paper_library.core import Library, csl_item, parse_ris


def test_manual_pdf_accepts_optional_doi_and_round_trips_metadata(tmp_path):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as pdf:
        pdf.new_page().insert_text((72, 72), "Synthetic Tool Manual")
        pdf.save(source)
    original = source.read_bytes()
    with closing(Library(tmp_path / "library")) as library:
        item = library.import_items(path=str(source))["items"][0]
        assert item["pdf"] and not item.get("DOI")
        saved = library.update(item["id"], {
            "type": "manual", "doi_status": "not-applicable", "URL": "https://example.org/guide",
        }, expected_modified=item["modified"])
        assert (saved["type"], saved["genre"], saved["doi_status"]) == ("report", "Manual", "not-applicable")
        assert "DOI" not in saved and saved["URL"] == "https://example.org/guide"
        report = audit(library, {})
        assert report["missing"]["doi"]["count"] == 0
        assert report["doi_not_applicable"]["ids"] == [item["id"]]
        assert library.inspect_pdf(library.pdf_path(item["id"]))["metadata"]["doi_status"] == "not-applicable"
        assigned = library.update(item["id"], {"DOI": "10.1234/synthetic"})
        assert assigned["DOI"] == "10.1234/synthetic" and "doi_status" not in assigned
    assert source.read_bytes() == original


def test_zotero_and_ris_preserve_resource_types():
    zotero = csl_item({"itemType": "report", "title": "Example Guide", "reportType": "Manual",
                      "institution": "Example University"})
    assert (zotero["type"], zotero["genre"], zotero["publisher"]) == ("report", "Manual", "Example University")
    for zotero_type, expected in (("computerProgram", "software"), ("map", "map"), ("standard", "standard"),
                                  ("presentation", "speech"), ("webpage", "webpage")):
        assert csl_item({"itemType": zotero_type})["type"] == expected
    entries = parse_ris("TY  - RPRT\nTI  - Example Guide\nM3  - Manual\nER  -\nTY  - COMP\nTI  - Example Tool\nER  -")
    assert [(item["type"], item.get("genre")) for item in entries] == [("report", "Manual"), ("software", None)]
