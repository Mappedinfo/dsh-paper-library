"""Synthetic single-reader reviews; native annotation recovery and real SyncTeX."""
import hashlib
import json
import shutil
from pathlib import Path

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch
from dsh_paper_library.latex import LatexConflict


def project(tmp_path, compile=True):
    root = tmp_path / "manuscript"
    root.mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\n\\input{one}\n\\clearpage\n\\input{two}\n\\end{document}\n")
    (root / "draft.tex").write_text("\\documentclass{article}\n\\begin{document}\nDraft only.\n\\end{document}\n")
    (root / "one.tex").write_text("First page review sentence.\nSecond sentence for the source anchor.\n")
    (root / "two.tex").write_text("Second page review sentence.\n")
    library = tmp_path / "library"
    created = dispatch({"library": str(library), "action": "latex_project_create", "root": str(root)})["project"]
    def call(action, **kw):
        return dispatch({"library": str(library), "action": action, "id": created["id"], **kw})
    if compile:
        built = call("latex_compile", engine="pdflatex")
        assert built["ok"], built
    return root, library, call


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic SyncTeX test requires latexmk and pdflatex")
def test_real_synctex_build_input_file_page_mapping_and_stale_source(tmp_path):
    root, library, call = project(tmp_path)
    layout = call("latex_pdf_pages")
    assert layout["build"]["verified"] and layout["page_count"] == 2
    forward = call("latex_synctex_view", path="two.tex", line=1)
    assert forward["page"] == 2
    back = call("latex_synctex_edit", page=2, x=forward["x"], y=forward["y"], pdf_version=layout["build"]["pdf_version"])
    assert back["path"] == "two.tex" and back["line"] == 1
    assert back["source_revision"] == call("latex_read", path="two.tex")["revision"]
    with pytest.raises(ValueError, match="PDF 版本"):
        call("latex_synctex_edit", page=2, x=100, y=100, pdf_version="0" * 64)
    (root / "two.tex").write_text("Inserted sentence.\nSecond page changed.\n")
    assert not call("latex_pdf_pages")["build"]["verified"]
    with pytest.raises(ValueError, match="源码已改"):
        call("latex_synctex_view", path="two.tex", line=1)
    assert call("latex_compile", engine="pdflatex")["ok"]
    assert call("latex_pdf_pages")["build"]["verified"]
    # An externally replaced PDF must not be blessed by a no-op latexmk run.
    with fitz.open() as forged:
        forged.new_page().insert_text((50, 60), "Synthetic replacement, no matching SyncTeX")
        forged.save(root / "main.pdf")
    assert not call("latex_pdf_pages")["build"]["verified"]
    assert call("latex_compile", engine="pdflatex")["ok"]
    assert call("latex_pdf_pages")["build"]["verified"]
    with fitz.open(root / "main.pdf") as rebuilt:
        assert rebuilt.page_count == 2 and "Synthetic replacement" not in rebuilt[0].get_text()


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic SyncTeX test requires latexmk and pdflatex")
def test_build_verification_rejects_project_external_source_and_old_manifest(tmp_path):
    root = tmp_path / "review"
    shared = tmp_path / "shared"
    root.mkdir()
    shared.mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\n\\input{../shared/body.tex}\n\\end{document}\n")
    (shared / "body.tex").write_text("External synthetic source.\n")
    config = {"library": str(tmp_path / "library")}
    project_id = dispatch({**config, "action": "latex_project_create", "root": str(root)})["project"]["id"]
    def call(action, **kw):
        return dispatch({**config, "action": action, "id": project_id, **kw})

    built = call("latex_compile", engine="pdflatex")
    assert built["ok"]
    status = call("latex_pdf_pages")["build"]
    assert not status["verified"] and "上级目录" in status["reason"]
    with pytest.raises(ValueError, match="上级目录"):
        call("latex_synctex_view", path="main.tex", line=3)

    # A build record created before scope checking must not be trusted either.
    manifest_path = next((tmp_path / "library").glob("latex-review/*/*/build.json"))
    manifest = json.loads(manifest_path.read_text())
    manifest["verified"] = True
    manifest.pop("scope_checked")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    status = call("latex_pdf_pages")["build"]
    assert not status["verified"] and "范围" in status["reason"]


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex") and shutil.which("bibtex")), reason="Synthetic bibliography test requires TeX tools")
def test_nested_main_tracks_project_internal_shared_bibliography(tmp_path):
    root = tmp_path / "project"
    (root / "review").mkdir(parents=True)
    (root / "shared").mkdir()
    (root / "review" / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nCitation \\cite{sample}.\n"
        "\\bibliographystyle{plain}\n\\bibliography{../shared/refs}\n\\end{document}\n"
    )
    refs = root / "shared" / "refs.bib"
    refs.write_text("@article{sample,author={A. Example},title={Synthetic},journal={Test},year={2024}}\n")
    config = {"library": str(tmp_path / "library")}
    project_id = dispatch({**config, "action": "latex_project_create", "root": str(root), "main_path": "review/main.tex"})["project"]["id"]
    def call(action, **kw):
        return dispatch({**config, "action": action, "id": project_id, **kw})

    result = call("latex_compile", engine="pdflatex")
    assert result["ok"], result["log_tail"]
    status = call("latex_pdf_pages")["build"]
    assert status["verified"] and "shared/refs.bib" in status["source_revisions"]
    refs.write_text(refs.read_text().replace("Synthetic", "Changed"))
    assert not call("latex_pdf_pages")["build"]["verified"]


def test_source_anchor_unicode_cas_status_stale_and_dual_entry_isolation(tmp_path):
    root, library, call = project(tmp_path, compile=False)
    (root / "one.tex").write_text("中文😀选段\nNext line\n")
    read = call("latex_read", path="one.tex")
    anchor = {"kind": "source", "path": "one.tex", "revision": read["revision"], "start": 2, "end": 5, "text": "😀选段"}
    before = (root / "one.tex").read_bytes()
    note = call("latex_review_put", anchor=anchor, comment="检查这一处表达", request_id="a" * 32)["annotation"]
    assert not note["stale"] and note["anchor"]["line"] == 1
    assert call("latex_review_put", anchor=anchor, comment="检查这一处表达", request_id="a" * 32)["duplicate"]
    changed = call("latex_review_put", note_id=note["id"], expected_version=note["version"], status="resolved", comment="已核对")["annotation"]
    assert changed["status"] == "resolved"
    with pytest.raises(LatexConflict):
        call("latex_review_put", note_id=note["id"], expected_version=note["version"], comment="stale write")
    assert call("latex_review_list")["annotations"][0]["comment"] == "已核对"
    assert (root / "one.tex").read_bytes() == before
    call("latex_project_update", main_path="draft.tex")
    assert call("latex_review_list")["annotations"] == []
    call("latex_project_update", main_path="main.tex")
    (root / "one.tex").write_text("New first line\n中文😀选段\nNext line\n")
    assert call("latex_review_list")["annotations"][0]["stale"]
    with pytest.raises(ValueError, match="源码修订"):
        call("latex_review_put", anchor=anchor, comment="old selection")
    with pytest.raises(ValueError, match="超出项目"):
        call("latex_review_put", anchor={**anchor, "path": "../private.tex"}, comment="escape")


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic PDF review test requires latexmk and pdflatex")
def test_pdf_notes_recover_from_native_copy_preserve_original_and_export(tmp_path):
    root, library, call = project(tmp_path)
    original = root / "main.pdf"
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    page = call("latex_pdf_page", page=2, scale=2)
    assert page["words"]
    word = page["words"][0]
    token = call("latex_pdf_pages")["build"]["pdf_version"]
    anchor = {"kind": "pdf", "pdf_version": token, "page": 2, "rects": [word[:4]], "text": word[4]}
    call("latex_review_put", anchor=anchor, type="highlight", comment="为什么这样定义？", request_id="b" * 32)
    assert call("latex_review_put", anchor=anchor, type="highlight", comment="为什么这样定义？", request_id="b" * 32)["duplicate"]
    notes = call("latex_review_list")["annotations"]
    assert len(notes) == 1 and notes[0]["comment"] == "为什么这样定义？" and not notes[0]["stale"]
    assert call("latex_pdf_page", page=2)["annotations"][0]["type"] == "highlight"
    call("latex_review_put", note_id=notes[0]["id"], expected_version=notes[0]["version"], status="resolved", comment="已想清楚")
    updated = call("latex_review_list")["annotations"][0]
    assert updated["status"] == "resolved"
    with pytest.raises(LatexConflict):
        call("latex_review_put", note_id=notes[0]["id"], expected_version=notes[0]["version"], comment="old")
    review = next(library.glob("latex-review/*/*/*.pdf"))
    with fitz.open(review) as doc:
        native_page = doc[1]
        annotation = next(native_page.annots())
        assert annotation.type[0] == 8 and "latex_review" in annotation.info["subject"]
        assert annotation.info["content"] == "已想清楚"
    assert list((library / "backups").glob("latex-*.bak"))
    exported = call("latex_review_export", format="pdf")
    with fitz.open(exported["path"]) as doc:
        native_page = doc[1]
        assert next(native_page.annots()).type[0] == 8
        assert json.loads(doc.embfile_get("paper-library.latex-review.json"))["schema"] == "paper-library.annotations.v1"
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before
    record = json.loads(call("latex_review_export", format="json")["text"])
    assert record["schema"] == "paper-library.annotations.v1" and len(record["annotations"]) == 1
    assert "已想清楚" in call("latex_review_export", format="markdown")["text"]
    (root / "two.tex").write_text("Changed text on second page.\n")
    assert call("latex_review_list")["annotations"][0]["stale"]
    assert call("latex_compile", engine="pdflatex")["ok"]
    assert call("latex_review_list")["annotations"][0]["stale"]
    assert call("latex_pdf_page", page=2)["annotations"] == []


def test_external_pdf_annotations_are_preserved_and_missing_mapping_is_honest(tmp_path):
    root, library, call = project(tmp_path, compile=False)
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 60), "External compiled page")
        page.add_text_annot((50, 90), "Existing outside note")
        doc.save(root / "main.pdf")
    call("latex_project_update", main_path="main.tex")
    before = (root / "main.pdf").read_bytes()
    build = call("latex_pdf_pages")["build"]
    assert not build["verified"] and "SyncTeX" in build["reason"]
    anchor = {"kind": "pdf", "page": 1, "rects": [[70, 120, 130, 140]], "text": "", "pdf_version": build["pdf_version"]}
    call("latex_review_put", anchor=anchor, comment="My region thought")
    assert len(call("latex_review_list")["annotations"]) == 1
    with fitz.open(call("latex_review_export", format="pdf")["path"]) as doc:
        comments = [a.info["content"] for a in doc[0].annots()]
        assert "Existing outside note" in comments and "My region thought" in comments
    review = next(library.glob("latex-review/*/*/*.pdf"))
    with fitz.open(review) as doc:
        page = doc[0]
        own = next(a for a in page.annots() if a.info["content"] == "My region thought")
        reply = page.add_text_annot((150, 190), "External reply must survive")
        doc.xref_set_key(reply.xref, "IRT", f"{own.xref} 0 R")
        doc.saveIncr()
    note = call("latex_review_list")["annotations"][0]
    call("latex_review_delete", note_id=note["id"], expected_version=note["version"])
    assert call("latex_review_list")["annotations"] == []
    with fitz.open(call("latex_review_export", format="pdf")["path"]) as doc:
        comments = [a.info["content"] for a in doc[0].annots()]
        assert sorted(comments) == ["Existing outside note", "External reply must survive"]
    assert (root / "main.pdf").read_bytes() == before


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic version test requires latexmk and pdflatex")
def test_manual_version_keeps_old_native_reviews_and_shared_project_identity(tmp_path):
    root, library, call = project(tmp_path)
    reading = dispatch({"library": str(library), "action": "project_create", "title": "manuscript"})["project"]
    source = call("latex_read", path="one.tex")
    source_note = {"kind": "source", "path": "one.tex", "revision": source["revision"], "start": 0, "end": 10, "text": source["content"][:10]}
    call("latex_review_put", anchor=source_note, comment="synthetic source review")
    page = call("latex_pdf_page", page=1)
    word = page["words"][0]
    old_sha = call("latex_pdf_pages")["build"]["pdf_version"]
    anchor = {"kind": "pdf", "pdf_version": old_sha, "page": 1, "rects": [word[:4]], "text": word[4]}
    call("latex_review_put", anchor=anchor, type="strikeout", comment="synthetic deletion")
    before_review = next(library.glob("latex-review/*/*/*.pdf")).read_bytes()
    with fitz.open(stream=before_review, filetype="pdf") as doc:
        page = doc[0]
        assert next(page.annots()).type[1] == "StrikeOut"
    (root / "two.tex").write_text("A different synthetic second page.\n")
    snapshot_source = (root / "two.tex").read_bytes()
    built = call("latex_compile", engine="pdflatex", save_version=True)
    assert built["ok"] and built.get("version_error") is None
    version = built["version"]
    assert version["reading_project_id"] != reading["id"], "same-named projects must never be merged"
    assert version["review_count"] == 2 and version["stale_review_count"] >= 1
    assert {entry["pdf_version"] for entry in version["review_pdfs"]} == {old_sha}
    assert (root / "two.tex").read_bytes() == snapshot_source
    assert next(library.glob("latex-review/*/*/*.pdf")).read_bytes() == before_review
    by_latex = call("latex_version_list")["versions"]
    by_reading = dispatch({"library": str(library), "action": "latex_version_list", "reading_project_id": version["reading_project_id"]})["versions"]
    assert by_latex[0]["id"] == by_reading[0]["id"] == version["id"]
    assert call("latex_project_get")["project"]["reading_project_id"] == version["reading_project_id"]
    data = dispatch({"library": str(library), "action": "latex_version_get", "version_id": version["id"]})
    assert any(item["path"] == "two.tex" for item in data["sources"])
    read = dispatch({"library": str(library), "action": "latex_version_read", "version_id": version["id"], "path": "two.tex"})
    assert read["content"].encode() == snapshot_source
    notes = dispatch({"library": str(library), "action": "latex_version_review", "version_id": version["id"]})
    assert len(notes["annotations"]) == 2 and any(n["stale"] for n in notes["annotations"])
    old = dispatch({"library": str(library), "action": "latex_version_get", "version_id": version["id"], "review_pdf_version": old_sha})
    with fitz.open(old["pdf_path"]) as doc:
        page = doc[0]
        assert next(page.annots()).type[1] == "StrikeOut"
    pages = dispatch({"library": str(library), "action": "latex_version_pdf_pages", "version_id": version["id"], "review_pdf_version": old_sha})
    assert pages["page_count"] == 2 and not pages["build"]["verified"]
    rendered = dispatch({"library": str(library), "action": "latex_version_pdf_page", "version_id": version["id"], "review_pdf_version": old_sha, "page": 1})
    assert rendered["words"] and any(item["type"] == "strikeout" for item in rendered["annotations"])
    with pytest.raises(ValueError, match="不属于"):
        dispatch({"library": str(library), "action": "latex_version_get", "version_id": version["id"], "review_pdf_version": "0" * 64})
    with pytest.raises(ValueError, match="不属于"):
        dispatch({"library": str(library), "action": "latex_version_read", "version_id": version["id"], "path": "../outside"})
    second = call("latex_compile", engine="pdflatex", save_version=True)["version"]
    assert second["reading_project_id"] == version["reading_project_id"]
    assert call("latex_version_list")["total"] == 2
    linked = call("latex_project_link_reading", reading_project_id=reading["id"])
    assert linked["project"]["reading_project_id"] == reading["id"]
    assert dispatch({"library": str(library), "action": "latex_version_list", "reading_project_id": reading["id"]})["total"] == 2
    assert dispatch({"library": str(library), "action": "latex_version_list", "reading_project_id": version["reading_project_id"]})["total"] == 0
    third = call("latex_compile", engine="pdflatex", save_version=True)["version"]
    assert third["reading_project_id"] == reading["id"]
    assert dispatch({"library": str(library), "action": "latex_version_list", "reading_project_id": reading["id"]})["total"] == 3


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic version test requires latexmk and pdflatex")
def test_version_review_export_preserves_snapshot_native_and_all_review_records(tmp_path):
    from dsh_paper_library import latex, latex_versions
    from dsh_paper_library.core import Library

    root, library, call = project(tmp_path)
    def add_pdf_note(comment):
        word = call("latex_pdf_page", page=1)["words"][0]
        sha = call("latex_pdf_pages")["build"]["pdf_version"]
        call("latex_review_put", anchor={"kind": "pdf", "pdf_version": sha, "page": 1,
                                         "rects": [word[:4]], "text": word[4]},
             type="highlight", comment=comment)

    add_pdf_note("old PDF anchor")
    (root / "two.tex").write_text("Changed second page for next build.\n")
    assert call("latex_compile", engine="pdflatex")["ok"]
    add_pdf_note("current PDF anchor")
    source = call("latex_read", path="one.tex")
    call("latex_review_put", anchor={"kind": "source", "path": "one.tex", "revision": source["revision"],
                                     "start": 0, "end": 5, "text": source["content"][:5]}, comment="source note")
    identifier = call("latex_project_get")["project"]["id"]
    db = Library(str(library))
    try:
        row = latex._project(db, identifier)
        version = latex_versions.create(db, row, "pdflatex", latex_versions.capture_sources(db, row))
    finally:
        db.close()
    snapshot = library / "latex-versions" / version["id"]
    preview_before = (snapshot / "preview.pdf").read_bytes()
    review_before = (snapshot / "review.json").read_bytes()
    assert version["current_pdf_annotated"]

    # Later live comments must not appear in the immutable version export.
    add_pdf_note("later live note")
    result = dispatch({"library": str(library), "action": "latex_version_review_export", "version_id": version["id"]})
    with fitz.open(result["path"]) as doc:
        page = doc[0]
        assert [a.info["content"] for a in page.annots()] == ["current PDF anchor"]
        record = json.loads(doc.embfile_get("paper-library.latex-review.json"))
        assert record["schema"] == "paper-library.annotations.v1" and record["version_id"] == version["id"]
        assert {note["comment"] for note in record["annotations"]} == {"old PDF anchor", "current PDF anchor", "source note"}
        assert any(note["stale"] and note["comment"] == "old PDF anchor" for note in record["annotations"])
    assert (snapshot / "preview.pdf").read_bytes() == preview_before
    assert (snapshot / "review.json").read_bytes() == review_before


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic version test requires latexmk and pdflatex")
def test_version_failure_is_visible_without_claiming_saved_or_changing_sources(tmp_path, monkeypatch):
    root, library, call = project(tmp_path)
    from dsh_paper_library import latex_versions
    before = (root / "main.tex").read_bytes()
    def fail(*args):
        raise ValueError("synthetic snapshot failure")
    monkeypatch.setattr(latex_versions, "capture_sources", fail)
    built = call("latex_compile", engine="pdflatex", save_version=True)
    assert built["ok"] and built["version"] is None
    assert "synthetic snapshot failure" in built["version_error"]
    assert (root / "main.tex").read_bytes() == before
    assert call("latex_version_list")["total"] == 0
    assert dispatch({"library": str(library), "action": "project_list"})["total"] == 0


@pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdflatex")), reason="Synthetic version test requires latexmk and pdflatex")
def test_partial_version_copy_does_not_publish_a_record_or_project(tmp_path, monkeypatch):
    root, library, call = project(tmp_path)
    from dsh_paper_library import latex, latex_versions
    from dsh_paper_library.core import Library
    identifier = call("latex_project_get")["project"]["id"]
    original_pdf = (root / "main.pdf").read_bytes()
    original_tex = (root / "main.tex").read_bytes()
    def fail(*args):
        raise OSError("synthetic copy failure")
    monkeypatch.setattr(latex_versions.shutil, "copyfile", fail)
    db = Library(str(library))
    try:
        row = latex._project(db, identifier)
        sources = latex_versions.capture_sources(db, row)
        with pytest.raises(OSError, match="synthetic copy failure"):
            latex_versions.create(db, row, "pdflatex", sources)
    finally:
        db.close()
    assert call("latex_version_list")["total"] == 0
    assert dispatch({"library": str(library), "action": "project_list"})["total"] == 0
    assert not list((library / "latex-versions").iterdir())
    assert (root / "main.tex").read_bytes() == original_tex
    assert (root / "main.pdf").read_bytes() == original_pdf
