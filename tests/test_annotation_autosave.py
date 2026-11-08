"""侧栏批注自动保存的合成 PDF 幂等创建与并发更新。"""
import json
from pathlib import Path
import uuid

import pymupdf as fitz
import pytest

from dsh_paper_library.core import dispatch


def request(tmp_path, action, **values):
    return dispatch({"library": str(tmp_path / "library"), "action": action, **values})


def fixture(tmp_path):
    original = tmp_path / "synthetic-autosave.pdf"
    with fitz.open() as doc:
        for _ in range(2):
            page = doc.new_page(width=400, height=500)
            page.insert_text((60, 90), "Synthetic source for independent annotations")
        page = doc[0]
        external = page.add_text_annot((20, 30), "External annotation stays intact")
        external.set_info(title="External synthetic reader")
        external.update()
        doc.save(original)
    before = original.read_bytes()
    paper = request(tmp_path, "import", path=str(original))["items"][0]
    managed = Path(request(tmp_path, "export_pdf", id=paper["id"])["path"])
    return paper["id"], original, before, managed


@pytest.mark.parametrize("kind", ["highlight", "underline", "strikeout", "square", "note"])
def test_create_retries_reuse_native_object_and_preserve_later_comment(tmp_path, kind):
    paper, original, before, managed = fixture(tmp_path)
    body = {"id": paper, "page": 1, "type": kind, "annotation_id": str(uuid.uuid4()),
            "rects": [[50, 70, 160, 95]], "text": "Synthetic source", "comment": "", "color": "#336699"}
    first = request(tmp_path, "annotate", **body)["annotation"]
    assert first["version"]
    saved_pdf = managed.read_bytes()
    backup_count = len(list((tmp_path / "library" / "backups").glob("*.bak")))
    retry = request(tmp_path, "annotate", **body)
    assert retry["duplicate"] is True
    assert retry["annotation"]["id"] == first["id"]
    assert retry["annotation"]["version"] == first["version"]
    assert managed.read_bytes() == saved_pdf
    assert len(list((tmp_path / "library" / "backups").glob("*.bak"))) == backup_count
    edited = request(tmp_path, "annotation_update", id=paper, annotation_id=first["id"],
                     comment="Independent question", version=first["version"])["annotation"]
    assert edited["version"] != first["version"]
    after_edit = managed.read_bytes()
    retry_after_edit = request(tmp_path, "annotate", **body)
    assert retry_after_edit["annotation"]["comment"] == "Independent question"
    assert retry_after_edit["annotation"]["version"] == edited["version"]
    assert managed.read_bytes() == after_edit
    notes = request(tmp_path, "annotations", id=paper)["annotations"]
    assert len(notes) == 2
    assert any(note["comment"] == "External annotation stays intact" for note in notes)
    assert original.read_bytes() == before
    # 保存请求身份随原生对象一起保存在 PDF，不依赖目录行。
    with fitz.open(managed) as doc:
        page = doc[0]
        native = next(a for a in page.annots() if a.info["id"] == first["id"])
        metadata = json.loads(native.info["subject"].removeprefix("paper-library:"))
        assert len(metadata["create_request_hash"]) == 64


@pytest.mark.parametrize("change", [
    {"comment": "different initial request"}, {"rects": [[50, 70, 180, 95]]},
    {"text": "different source"}, {"page": 2}, {"type": "note"},
    {"color": "#ff0000"}, {"width": 4}, {"author": "Another reader"},
])
def test_reused_create_identity_rejects_changed_request_even_on_another_page(tmp_path, change):
    paper, _, _, managed = fixture(tmp_path)
    body = {"id": paper, "page": 1, "type": "square", "annotation_id": uuid.uuid4().hex,
            "rects": [[50, 70, 160, 95]]}
    request(tmp_path, "annotate", **body)
    before = managed.read_bytes()
    with pytest.raises(ValueError, match="different content"):
        request(tmp_path, "annotate", **{**body, **change})
    assert managed.read_bytes() == before


def test_concurrent_edits_are_checked_and_lost_response_retry_does_not_write_again(tmp_path):
    paper, _, _, managed = fixture(tmp_path)
    note = request(tmp_path, "annotate", id=paper, page=1, type="note", comment="original")["annotation"]
    updated = request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                      version=note["version"], comment="first writer")["annotation"]
    before = managed.read_bytes()
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                version=note["version"], comment="second writer")
    assert managed.read_bytes() == before
    repeated = request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                       version=note["version"], comment="first writer")
    assert repeated["duplicate"] is True
    assert repeated["annotation"]["version"] == updated["version"]
    assert managed.read_bytes() == before
    with pytest.raises(ValueError, match="SHA-256"):
        request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"], version="bad", comment="x")
    assert managed.read_bytes() == before


def test_independent_annotations_on_same_region_have_independent_versions(tmp_path):
    paper, _, _, _ = fixture(tmp_path)
    notes = [request(tmp_path, "annotate", id=paper, page=1, type="underline", annotation_id=uuid.uuid4().hex,
                     rects=[[50, 70, 160, 95]], text="same quote")["annotation"] for _ in range(2)]
    assert notes[0]["id"] != notes[1]["id"]
    request(tmp_path, "annotation_update", id=paper, annotation_id=notes[0]["id"], version=notes[0]["version"], comment="first question")
    second = request(tmp_path, "annotation_update", id=paper, annotation_id=notes[1]["id"], version=notes[1]["version"], comment="second question")
    values = {a["id"]: a for a in request(tmp_path, "annotations", id=paper)["annotations"]}
    assert values[notes[0]["id"]]["comment"] == "first question"
    assert values[notes[1]["id"]]["comment"] == "second question"
    assert values[notes[1]["id"]]["version"] == second["annotation"]["version"]


def test_long_comments_keep_full_edit_versions_without_expanding_ai_reference_budget(tmp_path):
    paper, _, _, managed = fixture(tmp_path)
    initial = "Long synthetic comment. " * 600
    note = request(tmp_path, "annotate", id=paper, page=1, type="note", comment=initial)["annotation"]
    assert len(initial) > 8000
    assert "version" not in note
    assert len(note["edit_version"]) == 64
    listed = next(a for a in request(tmp_path, "annotations", id=paper)["annotations"] if a["id"] == note["id"])
    rendered = next(a for a in request(tmp_path, "page", id=paper, page=1, scale=.5)["annotations"] if a["id"] == note["id"])
    assert listed["edit_version"] == rendered["edit_version"] == note["edit_version"]
    assert "version" not in listed and "version" not in rendered
    changed = request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                      version=note["edit_version"], comment=initial + "Changed by first writer")["annotation"]
    assert changed["edit_version"] != note["edit_version"] and "version" not in changed
    before = managed.read_bytes()
    with pytest.raises(ValueError, match="ANNOTATION_STALE"):
        request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                version=note["edit_version"], comment=initial + "Second writer")
    assert managed.read_bytes() == before
    retry = request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                    version=note["edit_version"], comment=changed["comment"])
    assert retry["duplicate"] is True and retry["annotation"]["edit_version"] == changed["edit_version"]
    assert managed.read_bytes() == before
    short = request(tmp_path, "annotation_update", id=paper, annotation_id=note["id"],
                    version=changed["edit_version"], comment="Short comment")["annotation"]
    assert short["edit_version"] == short["version"]
