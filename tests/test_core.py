import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET

import pymupdf as fitz
import pytest

from dsh_paper_library.core import Library, dispatch


def make_pdf(path, rotation=0):
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((50, 80), "Evidence from the original paper.")
        external = page.add_text_annot((200, 150), "External reader comment")
        external.set_info(title="External reader")
        external.update()
        page.set_rotation(rotation)
        doc.save(path)
    return path


def request(tmp_path, action, **kw):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **kw})


def test_portable_roundtrip_original_and_external_annotations(tmp_path):
    original = make_pdf(tmp_path / "source.pdf")
    original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
    item = request(tmp_path, "import", items=[{"id": "Wang2026", "title": "城市论文", "author": [{"family": "王", "given": "世琦"}], "DOI": "https://doi.org/10.1234/TEST"}])["items"][0]
    item = request(tmp_path, "attach", id=item["id"], path=str(original))
    page = request(tmp_path, "page", id=item["id"])
    word = page["words"][0]
    annotation = request(tmp_path, "annotate", id=item["id"], page=1, rects=[word[:4]], text=word[4], comment="这句话有何依据？")["annotation"]
    assert annotation["comment"] == "这句话有何依据？"
    request(tmp_path, "update", id=item["id"], metadata={"title": "更新标题"})
    exported = request(tmp_path, "export_pdf", id=item["id"])
    copied = tmp_path / "portable.pdf"
    shutil.copy2(exported["path"], copied)
    imported = dispatch({"library": str(tmp_path / "fresh"), "action": "import", "path": str(copied)})["items"][0]
    assert imported["title"] == "更新标题"
    assert imported["citekey"] == "Wang2026"
    recovered = dispatch({"library": str(tmp_path / "fresh"), "action": "annotations", "id": imported["id"]})["annotations"]
    assert {a["comment"] for a in recovered} == {"External reader comment", "这句话有何依据？"}
    assert hashlib.sha256(original.read_bytes()).hexdigest() == original_hash
    assert len(list((tmp_path / "library" / "backups").iterdir())) == 1
    for fmt in ("json", "markdown", "xfdf"):
        data = request(tmp_path, "export_annotations", id=item["id"], format=fmt)
        assert "这句话有何依据？" in data["text"]
        if fmt == "xfdf":
            ET.fromstring(data["text"])
    request(tmp_path, "annotation_update", id=item["id"], annotation_id=annotation["id"], comment="Updated")
    request(tmp_path, "annotation_delete", id=item["id"], annotation_id=annotation["id"])
    assert len(request(tmp_path, "annotations", id=item["id"])["annotations"]) == 1


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotated_words_annotations_and_render_cap(tmp_path, rotation):
    original = make_pdf(tmp_path / "rotated.pdf", rotation)
    item = request(tmp_path, "import", path=str(original))["items"][0]
    page = request(tmp_path, "page", id=item["id"], scale=100)
    assert page["width"] == (500 if rotation in {90, 270} else 400)
    assert page["scale"] <= 2
    word = page["words"][0]
    annotation = request(tmp_path, "annotate", id=item["id"], page=1, rects=[word[:4]], text=word[4], comment="Rotation")["annotation"]
    assert annotation["rects"][0] == pytest.approx(word[:4], abs=0.001)
    assert request(tmp_path, "annotations", id=item["id"])["annotations"][-1]["text"] == "Evidence"


def test_metadata_dedup_search_pagination_and_graph(tmp_path):
    data = [{"id": "one", "title": "Literal 100%_ research", "DOI": "10.1/one", "tags": ["城市"]}, {"id": "two", "title": "Another", "tags": ["城市"]}]
    imported = request(tmp_path, "import", items=data)
    first, second = imported["items"]
    assert request(tmp_path, "import", items=[{"title": "Duplicate", "DOI": "https://doi.org/10.1/ONE"}])["duplicates"] == 1
    assert request(tmp_path, "list", query="%_")["total"] == 1
    assert request(tmp_path, "list", query="' OR 1=1 --")["total"] == 0
    assert len(request(tmp_path, "list", limit=1, offset=1)["items"]) == 1
    request(tmp_path, "link", source=first["id"], target=second["id"], relation="supports", note="Reader interpretation")
    graph = request(tmp_path, "graph")
    assert any(e["provenance"] == "user-asserted" and e["relation"] == "supports" for e in graph["edges"])
    assert any(n["type"] == "tag" for n in graph["nodes"])


def test_zotero_relative_import_and_native_annotation(tmp_path):
    pdf = make_pdf(tmp_path / "attachment.pdf")
    export = tmp_path / "zotero.json"
    export.write_text(json.dumps({"items": [{"itemType": "journalArticle", "title": "Zotero export", "citationKey": "Wang2026Zotero", "date": "2026-09-14", "creators": [{"creatorType": "author", "firstName": "Shiqi", "lastName": "Wang"}], "attachments": [{"path": "attachment.pdf", "annotations": [{"annotationType": "highlight", "annotationPosition": json.dumps({"pageIndex": 0, "rects": [[50, 420, 100, 435]]}), "annotationText": "Evidence", "annotationComment": "From Zotero"}, {"annotationType": "ink", "annotationPosition": {"pageIndex": 0}}]}]}]}))
    result = request(tmp_path, "import", path=str(export))
    item = result["items"][0]
    assert item["citekey"] == "Wang2026Zotero"
    assert item["author"] == [{"given": "Shiqi", "family": "Wang"}]
    assert item["issued"]["date-parts"] == [[2026, 9, 14]]
    assert any(a["comment"] == "From Zotero" for a in request(tmp_path, "annotations", id=item["id"])["annotations"])
    assert any("unsupported Zotero" in warning for warning in result["warnings"])


def test_feedback_context_and_portable_generated_note(tmp_path):
    item = request(tmp_path, "import", path=str(make_pdf(tmp_path / "paper.pdf")))["items"][0]
    annotation = request(tmp_path, "annotate", id=item["id"], page=1, type="note", comment="请解释此结论。")["annotation"]
    context = request(tmp_path, "feedback_context", id=item["id"], annotation_ids=[annotation["id"]])
    assert "untrusted" in context["prompt"]
    result = request(tmp_path, "save_feedback", id=item["id"], text="AI 建议，需要检查论证。", model="test-model", annotation_ids=[annotation["id"]])
    assert result["kind"] == "ai-feedback"
    feedback = request(tmp_path, "feedback", id=item["id"])["feedback"]
    assert feedback[0]["kind"] == "ai-feedback"
    assert "AI-generated" in feedback[0]["comment"]
    assert len(request(tmp_path, "feedback_context", id=item["id"])["annotations"]) == 2  # external note + source note, AI excluded


def test_concurrent_annotation_writes_and_atomic_failure(tmp_path, monkeypatch):
    item = request(tmp_path, "import", path=str(make_pdf(tmp_path / "paper.pdf")))["items"][0]
    def write(index):
        return request(tmp_path, "annotate", id=item["id"], page=1, type="note", comment=f"Concurrent {index}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(write, range(8)))
    assert len(request(tmp_path, "annotations", id=item["id"])["annotations"]) == 9
    library = Library(tmp_path / "library")
    managed = library.pdf_path(item["id"])
    before = managed.read_bytes()
    def fail(*args, **kwargs):
        raise OSError("Simulated save failure")
    monkeypatch.setattr(library, "_atomic_save", fail)
    with pytest.raises(OSError):
        library.annotate(item["id"], page=1, type="note", comment="must not persist")
    assert managed.read_bytes() == before
    library.close()


def test_encrypted_refusal_and_worker_protocol(tmp_path):
    source = tmp_path / "encrypted.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.save(source, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="reader")
    with pytest.raises(ValueError, match="Encrypted"):
        request(tmp_path, "import", path=str(source))
    process = subprocess.run([sys.executable, "-m", "dsh_paper_library.worker"], input=json.dumps({"library": str(tmp_path / "library"), "action": "status"}), text=True, capture_output=True)
    assert process.returncode == 0
    assert json.loads(process.stdout)["ok"] is True


def test_fts_index_updates_and_pdf_module_not_loaded_for_search(tmp_path):
    item = request(tmp_path, "import", items=[{"title": "交通机制 empirical", "id": "index2026", "author": [{"family": "Searchauthor"}], "tags": ["representation"]}])["items"][0]
    assert request(tmp_path, "list", query="交通机制")["search_mode"] == "fts5-trigram"
    assert request(tmp_path, "list", query="交通")["search_mode"] == "literal-short-query"
    assert request(tmp_path, "list", query="Searchauthor")["total"] == 1
    assert request(tmp_path, "list", query='" OR * NOT x')["total"] == 0
    request(tmp_path, "update", id=item["id"], metadata={"title": "Changed mechanism", "tags": ["newtag"]})
    assert request(tmp_path, "list", query="representation")["total"] == 0
    assert request(tmp_path, "list", query="Changed")["total"] == 1
    script = "import json,sys;from dsh_paper_library.core import dispatch;dispatch(json.loads(sys.stdin.read()));assert 'pymupdf' not in sys.modules"
    process = subprocess.run([sys.executable, "-c", script], input=json.dumps({"library": str(tmp_path / "library"), "action": "list", "query": "Changed"}), text=True, capture_output=True)
    assert process.returncode == 0, process.stderr


def test_directory_batched_pdf_import_and_hash_dedup(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    make_pdf(source / "a.pdf")
    make_pdf(source / "b.pdf", rotation=90)
    make_pdf(source / "c.pdf", rotation=180)
    first = request(tmp_path, "import", path=str(source), limit=2)
    assert first["imported"] == 2 and first["next_offset"] == 2 and not first["done"]
    second = request(tmp_path, "import", path=str(source), limit=2, offset=first["next_offset"])
    assert second["imported"] == 1 and second["done"]
    repeated = request(tmp_path, "import", path=str(source))
    assert repeated["duplicates"] == 3
    with pytest.raises(ValueError, match="outside the managed"):
        request(tmp_path, "import", path=str(tmp_path / "library"))


def test_ris_and_unsupported_signatures(tmp_path):
    ris = tmp_path / "export.ris"
    ris.write_text("TY  - JOUR\nTI  - Research paper\nAU  - Wang, Shiqi\nPY  - 2026\nDO  - 10.123/test\nER  -\n", encoding="utf-8")
    item = request(tmp_path, "import", path=str(ris))["items"][0]
    assert item["author"] == [{"family": "Wang", "given": "Shiqi"}]
    signed = tmp_path / "signed.pdf"
    with fitz.open() as doc:
        doc.new_page()
        xref = doc.get_new_xref()
        doc.update_object(xref, "<< /Type /Sig /ByteRange [0 1 2 3] >>")
        doc.save(signed)
    with pytest.raises(ValueError, match="signed"):
        request(tmp_path, "import", path=str(signed))


def test_concurrent_fresh_library_initialization(tmp_path):
    def insert(index):
        return request(tmp_path, "import", items=[{"id": f"fresh{index}", "title": f"Concurrent catalog {index}"}])
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(insert, range(8)))
    result = request(tmp_path, "list", query="Concurrent")
    assert result["total"] == 8
    assert len({item["id"] for item in result["items"]}) == 8


def test_feedback_snapshot_is_checked_atomically_before_pdf_write(tmp_path):
    item = request(tmp_path, "import", path=str(make_pdf(tmp_path / "paper.pdf")))["items"][0]
    annotation = request(tmp_path, "annotate", id=item["id"], page=1, type="note", comment="Initial question")["annotation"]
    context = request(tmp_path, "feedback_context", id=item["id"], annotation_ids=[annotation["id"]])
    assert len(context["context_hash"]) == 64
    request(tmp_path, "annotation_update", id=item["id"], annotation_id=annotation["id"], comment="Changed after generation")
    managed = Path(request(tmp_path, "export_pdf", id=item["id"])["path"])
    before = managed.read_bytes()
    with pytest.raises(ValueError, match="批注发生变化"):
        request(tmp_path, "save_feedback", id=item["id"], text="Stale generated answer", model="test", annotation_ids=[annotation["id"]], expected_context_hash=context["context_hash"])
    assert managed.read_bytes() == before
    assert not request(tmp_path, "feedback", id=item["id"])["feedback"]
    fresh = request(tmp_path, "feedback_context", id=item["id"], annotation_ids=[annotation["id"]])
    request(tmp_path, "save_feedback", id=item["id"], text="Current generated answer", model="test", annotation_ids=[annotation["id"]], expected_context_hash=fresh["context_hash"])
    assert len(request(tmp_path, "feedback", id=item["id"])["feedback"]) == 1


def test_metadata_import_batches_and_preserves_checkpoints_on_failure(tmp_path, monkeypatch):
    records = [{"id": f"batch{index}", "title": f"Batch paper {index}"} for index in range(205)]
    first = request(tmp_path, "import", items=records)
    assert first["imported"] == 100 and first["next_offset"] == 100 and first["total_records"] == 205
    second = request(tmp_path, "import", items=records, offset=first["next_offset"])
    assert second["imported"] == 100 and second["next_offset"] == 200
    third = request(tmp_path, "import", items=records, offset=second["next_offset"])
    assert third["imported"] == 5 and third["done"] and third["next_offset"] is None
    library = Library(tmp_path / "failure-library")
    upsert = library._upsert
    def fail_second(raw, source):
        if raw["id"] == "batch1":
            raise OSError("simulated interruption during later record")
        return upsert(raw, source)
    monkeypatch.setattr(library, "_upsert", fail_second)
    with pytest.raises(OSError):
        library.import_items(items=records[:3])
    library.close()
    resumed = Library(tmp_path / "failure-library")
    assert resumed.list()["total"] == 1
    result = resumed.import_items(items=records[:3])
    assert result["duplicates"] == 1 and result["imported"] == 2
    resumed.close()


def test_metadata_attachment_retry_reuses_durable_paper_identity(tmp_path, monkeypatch):
    source = make_pdf(tmp_path / "source.pdf")
    raw = {"id": "retry2026", "title": "Retry attachment", "attachments": [{"path": str(source)}]}
    library = Library(tmp_path / "library")
    original_attach = library._attach
    def interrupted(id, path):
        original_attach(id, path)
        raise KeyboardInterrupt("simulated termination after publishing attachment")
    monkeypatch.setattr(library, "_attach", interrupted)
    with pytest.raises(KeyboardInterrupt):
        library.import_items(items=[raw])
    library.close()
    resumed = Library(tmp_path / "library")
    before_id = resumed.list()["items"][0]["id"]
    result = resumed.import_items(items=[raw])
    assert result["duplicates"] == 1
    assert result["items"][0]["id"] == before_id
    assert result["items"][0]["pdf"]
    assert len(list((tmp_path / "library" / "pdfs").glob("*.pdf"))) == 1
    resumed.close()


def test_owner_encrypted_pdf_is_not_silently_decrypted(tmp_path):
    source = tmp_path / "owner-encrypted.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.save(source, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="")
    with pytest.raises(ValueError, match="Encrypted"):
        request(tmp_path, "import", path=str(source))


def test_citekey_collisions_do_not_silently_merge_distinct_papers(tmp_path):
    first = {"id": "sharedKey", "title": "First research paper", "DOI": "10.123/first"}
    request(tmp_path, "import", items=[first])
    conflicting = request(tmp_path, "import", items=[{"id": "sharedKey", "title": "Second research paper", "DOI": "10.123/second"}, {"id": "unrelatedKey", "title": "Third research paper"}])
    assert conflicting["skipped"] == 1 and conflicting["imported"] == 1 and conflicting["duplicates"] == 0
    assert any("conflicting DOI" in warning for warning in conflicting["warnings"])
    assert request(tmp_path, "list")["total"] == 2
    unchanged = request(tmp_path, "list", query="sharedKey")["items"][0]
    assert unchanged["DOI"] == "10.123/first" and unchanged["title"] == first["title"]
    same = request(tmp_path, "import", items=[first])
    assert same["duplicates"] == 1 and same["skipped"] == 0
    different_title = request(tmp_path, "import", items=[{"id": "unrelatedKey", "title": "A different DOI-less paper"}])
    assert different_title["skipped"] == 1 and any("different titles" in warning for warning in different_title["warnings"])
    title_revision_with_same_doi = request(tmp_path, "import", items=[{"id": "sharedKey", "title": "Revised title", "DOI": "10.123/first"}])
    assert title_revision_with_same_doi["duplicates"] == 1


def make_inspection_pdf(path):
    with fitz.open() as doc:
        page = doc.new_page(width=500, height=700)
        page.insert_text((45, 60), "Evidence for Neighborhood", fontsize=22)
        page.insert_text((45, 86), "Traffic Responses", fontsize=22)
        page.insert_text((45, 120), "A. Researcher and B. Scientist", fontsize=11)
        page.insert_text((45, 150), "DOI: 10.1234/primary.paper", fontsize=10)
        page.insert_text((45, 175), "arXiv: 2609.01234v2", fontsize=10)
        page.insert_text((45, 210), "Abstract", fontsize=14)
        page.insert_text((45, 235), "This paper examines a transparent neighborhood mechanism.", fontsize=11)
        page = doc.new_page()
        page.insert_text((45, 60), "A cited result uses DOI: 10.5678/cited.paper.")
        doc.new_page().insert_text((45, 60), "Third page evidence.")
        doc.new_page().insert_text((45, 60), "DOI: 10.9999/excluded.fourth.page")
        doc.save(path)
    return path


def test_bounded_pdf_inspection_has_candidate_evidence_not_fabricated_identity(tmp_path):
    original = make_inspection_pdf(tmp_path / "download.pdf")
    before = original.read_bytes()
    result = request(tmp_path, "inspect_pdf", path=str(original))
    assert result["metadata"]["title"] == "Evidence for Neighborhood Traffic Responses"
    assert "author" not in result["metadata"] and "issued" not in result["metadata"]
    assert "DOI" not in result["metadata"]
    assert result["doi_candidates"] == ["10.1234/primary.paper", "10.5678/cited.paper"]
    assert result["arxiv_candidates"] == ["2609.01234v2"]
    assert result["parse"]["pages_inspected"] == 3
    assert result["parse"]["text_characters"] <= 30000
    assert result["parse"]["needs_review"] and not result["parse"]["portable_metadata"]
    assert result["parse"]["field_sources"]["title"] == "first-page-layout-heuristic"
    assert result["parse"]["identifier_evidence"][0]["page"] == 1
    assert original.read_bytes() == before


def test_verified_pdf_import_names_real_file_and_preserves_embedded_edits(tmp_path):
    source = make_inspection_pdf(tmp_path / "download.pdf")
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    verified = {"title": "Verified Urban Evidence", "author": [{"family": "Wang", "given": "Shiqi"}], "issued": {"date-parts": [[2026]]}, "DOI": "10.1234/primary.paper", "citekey": "Wang2026Evidence"}
    item = request(tmp_path, "import", path=str(source), metadata=verified, metadata_source="crossref", metadata_verified=True)["items"][0]
    assert item["pdf_filename"] == f"Wang-2026-Verified-Urban-Evidence--{item['id'][:8]}.pdf"
    exported = request(tmp_path, "export_pdf", id=item["id"])
    assert Path(exported["path"]).name == exported["filename"] == item["pdf_filename"]
    assert item["parse"]["status"] == "verified-metadata" and not item["parse"]["needs_review"]
    assert item["parse"]["field_sources"]["DOI"] == "crossref"
    assert "text_excerpt" not in item["parse"]
    request(tmp_path, "update", id=item["id"], metadata={"title": "Reader Corrected Title"})
    managed = request(tmp_path, "export_pdf", id=item["id"])
    inspected = request(tmp_path, "inspect_pdf", path=managed["path"])
    assert inspected["parse"]["portable_metadata"]
    assert inspected["metadata"]["title"] == "Reader Corrected Title"
    copied = tmp_path / "transport.pdf"
    shutil.copy2(managed["path"], copied)
    imported = dispatch({"library": str(tmp_path / "fresh-named"), "action": "import", "path": str(copied), "metadata": {"title": "Old Network Title"}, "metadata_source": "crossref", "metadata_verified": True})["items"][0]
    assert imported["title"] == "Reader Corrected Title"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash


def test_parse_provenance_only_does_not_claim_metadata_verification(tmp_path):
    source = make_inspection_pdf(tmp_path / "download.pdf")
    item = request(tmp_path, "import", path=str(source), metadata={"acquisition": {"url": "https://example.test/paper.pdf", "source": "direct-url"}}, metadata_source="source-provenance", metadata_verified=False)["items"][0]
    assert item["parse"]["needs_review"]
    assert item["parse"]["status"] == "local-parse"
    assert "verified" not in item["parse"]
    assert item["acquisition"]["source"] == "direct-url"


def test_renaming_preserves_annotations_and_recovers_before_and_after_catalog_switch(tmp_path, monkeypatch):
    source = make_pdf(tmp_path / "source.pdf")
    item = request(tmp_path, "import", path=str(source))["items"][0]
    request(tmp_path, "annotate", id=item["id"], page=1, type="note", comment="Portable after rename")
    library = Library(tmp_path / "library")
    before_path = library.pdf_path(item["id"])
    before_bytes = before_path.read_bytes()
    atomic_save = library._atomic_save
    def fail_after_new_file(*args, **kwargs):
        atomic_save(*args, **kwargs)
        raise OSError("simulated interruption before catalog switch")
    monkeypatch.setattr(library, "_atomic_save", fail_after_new_file)
    with pytest.raises(OSError):
        library.update(item["id"], {"title": "Before commit failure"})
    assert library.pdf_path(item["id"]) == before_path
    assert before_path.read_bytes() == before_bytes
    assert len(list((tmp_path / "library" / "pdfs").glob("*.pdf"))) == 1
    monkeypatch.setattr(library, "_atomic_save", atomic_save)
    recover = library._recover_file_update
    def fail_cleanup():
        raise KeyboardInterrupt("simulated termination after catalog switch")
    monkeypatch.setattr(library, "_recover_file_update", fail_cleanup)
    with pytest.raises(KeyboardInterrupt):
        library.update(item["id"], {"title": "Committed human filename"})
    library.close()
    resumed = Library(tmp_path / "library")
    assert resumed.get(item["id"])["title"] == "Committed human filename"
    assert "Committed-human-filename" in resumed.pdf_path(item["id"]).name
    assert not before_path.exists()
    assert len(list((tmp_path / "library" / "pdfs").glob("*.pdf"))) == 1
    assert any(a["comment"] == "Portable after rename" for a in resumed.annotations(item["id"])["annotations"])
    resumed.close()


def test_unicode_filename_is_bounded_and_collisions_do_not_overwrite(tmp_path):
    source = make_pdf(tmp_path / "source.pdf")
    records = [{"id": f"unicode{index}", "title": "城市交通机制" * 80, "author": [{"family": "王世琦/研究"}], "issued": {"date-parts": [[2026]]}} for index in range(2)]
    items = request(tmp_path, "import", items=records)["items"]
    for item in items:
        attached = request(tmp_path, "attach", id=item["id"], path=str(source))
        assert len(attached["pdf_filename"].encode("utf-8")) <= 210
        assert "城市" in attached["pdf_filename"] and "/" not in attached["pdf_filename"]
    filenames = [request(tmp_path, "get", id=item["id"])["pdf_filename"] for item in items]
    assert filenames[0] != filenames[1]
    library = Library(tmp_path / "library")
    candidate = library._managed_destination({"title": "Collision"}, items[0]["id"])
    candidate.write_bytes(b"existing unrelated file")
    fallback = library._managed_destination({"title": "Collision"}, items[0]["id"])
    assert fallback != candidate and items[0]["id"] in fallback.name
    assert candidate.read_bytes() == b"existing unrelated file"
    library.close()


def test_metadata_only_record_keeps_pdf_evidence_and_repeat_file_identity(tmp_path):
    source = make_inspection_pdf(tmp_path / "downloaded.pdf")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    original = {"citekey": "MyExactKey", "title": "Reader Corrected Evidence Title", "DOI": "10.1234/primary.paper", "author": [{"family": "ReaderName"}], "issued": {"date-parts": [[2025]]}, "tags": ["keep-my-tag"], "acquisition": {"status": "metadata_only", "source_url": "https://doi.org/10.1234/primary.paper"}}
    metadata_only = request(tmp_path, "import", items=[original])["items"][0]
    acquisition = {"source_url": "https://papers.example/downloaded.pdf", "validation": "pdf_parser", "method": "direct-url"}
    fetched = {"citekey": "NetworkSuggestedKey", "title": "Evidence for Neighborhood Traffic Responses", "DOI": original["DOI"], "author": [{"family": "NetworkName"}], "issued": {"date-parts": [[2026]]}, "acquisition": acquisition}
    attached = request(tmp_path, "import", path=str(source), metadata=fetched, metadata_source="crossref", metadata_verified=True)["items"][0]
    assert attached["id"] == metadata_only["id"] and attached["pdf"]
    for key in ("citekey", "title", "DOI", "author", "issued", "tags"):
        assert attached[key] == original[key]
    assert attached["source_pdf_sha256"] == digest
    assert attached["parse"]["pages_inspected"] == 3
    assert attached["parse"]["field_sources"]["title"] == "existing-catalog"
    assert attached["acquisition"] == acquisition  # no stale metadata_only status remains
    managed = request(tmp_path, "export_pdf", id=attached["id"])
    portable = Library.read_portable(managed["path"])
    assert portable["source_pdf_sha256"] == digest
    assert portable["acquisition"] == acquisition
    assert portable["parse"] == attached["parse"]
    # The raw PDF has no embedded DOI. Its persisted source hash must suffice
    # to deduplicate a subsequent direct drop without another network lookup.
    repeated = request(tmp_path, "import", path=str(source))
    assert repeated["duplicates"] == 1 and repeated["imported"] == 0
    assert repeated["items"][0]["id"] == attached["id"]
    assert repeated["items"][0]["acquisition"] == acquisition
    assert request(tmp_path, "list")["total"] == 1
    assert len(list((tmp_path / "library" / "pdfs").glob("*.pdf"))) == 1
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
