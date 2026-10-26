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
