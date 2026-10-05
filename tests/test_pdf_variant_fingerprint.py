"""仅使用合成 PDF 验证只读底稿／批注比较，不加载用户文献。"""
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

SPEC = importlib.util.spec_from_file_location(
    "pdf_variant_fingerprint", Path(__file__).parents[1] / "scripts/pdf_variant_fingerprint.py")
fp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fp)


def make_pdf(path, mutate=None, pages=1):
    with pymupdf.open() as doc:
        for index in range(pages):
            page = doc.new_page(width=240, height=320)
            page.insert_text((20, 40), f"Learning how to read. Page {index + 1}.")
            page.draw_rect(pymupdf.Rect(30, 70, 90, 120), color=(0, 0, 0))
        if mutate:
            mutate(doc, doc[0])
        doc.save(path)
    return path


def note(doc, page, text="A private synthetic comment", author="Reader"):
    annot = page.add_text_annot((130, 30), text)
    annot.set_info(title=author)
    annot.update()
    return annot


def highlight(doc, page, rect=(20, 27, 170, 43)):
    return page.add_highlight_annot(pymupdf.Rect(rect))


def render(path):
    result = fp.fingerprint(path, mode="render", dpi=96)
    assert result["status"] == "complete", result["warnings"]
    return result


def test_no_annotations_is_complete_and_source_stays_identical(tmp_path):
    path = make_pdf(tmp_path / "plain.pdf")
    before = path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_ctime_ns
    result = render(path)
    assert result["annotation_count"] == 0
    assert result["base_render_hash"] == result["annotation_visual_hash"]
    assert result["sha256"] == hashlib.sha256(before[0]).hexdigest()
    assert before == (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_ctime_ns)
    assert result["source_unchanged"] is True


def test_highlight_has_same_base_and_different_visual_and_semantics(tmp_path):
    plain = render(make_pdf(tmp_path / "plain.pdf"))
    marked = render(make_pdf(tmp_path / "highlight.pdf", highlight))
    assert plain["text_hash"] == marked["text_hash"]
    assert plain["geometry_hash"] == marked["geometry_hash"]
    assert plain["base_render_hash"] == marked["base_render_hash"]
    assert plain["annotation_visual_hash"] != marked["annotation_visual_hash"]
    assert plain["annotation_semantic_hash"] != marked["annotation_semantic_hash"]
    assert marked["annotation_counts"] == {"Highlight": 1}


def test_same_comment_count_different_text_or_author(tmp_path):
    paths = [make_pdf(tmp_path / f"note-{n}.pdf", lambda d, p, t=t, a=a: note(d, p, t, a))
             for n, (t, a) in enumerate([("One", "Reader"), ("Two", "Reader"), ("One", "Other")])]
    results = [render(path) for path in paths]
    assert len({r["base_render_hash"] for r in results}) == 1
    assert len({r["annotation_semantic_hash"] for r in results}) == 3
    assert all(r["annotation_count"] == 1 for r in results)
    assert "Reader" not in json.dumps(results)
    assert "One" not in json.dumps(results)


def test_ink_geometry_changes_with_same_base(tmp_path):
    results = []
    for offset in (0, 10):
        def mutate(d, p):
            a = p.add_ink_annot([[(20, 150), (40 + offset, 170), (70, 155)]])
            a.set_colors(stroke=(0.2, 0.1, 0.9))
            a.update()
        results.append(render(make_pdf(tmp_path / f"ink-{offset}.pdf", mutate)))
    assert results[0]["base_render_hash"] == results[1]["base_render_hash"]
    assert results[0]["annotation_semantic_hash"] != results[1]["annotation_semantic_hash"]


def test_same_text_different_chart_is_not_same_visual_base(tmp_path):
    plain = render(make_pdf(tmp_path / "plain.pdf"))
    changed = render(make_pdf(tmp_path / "chart.pdf", lambda d, p:
                             p.draw_circle((150, 130), 25, fill=(0, 0, 0))))
    assert plain["text_hash"] == changed["text_hash"]
    assert plain["base_render_hash"] != changed["base_render_hash"]


def test_flattened_mark_is_different_visual_base(tmp_path):
    native = render(make_pdf(tmp_path / "native.pdf", highlight))
    flat = render(make_pdf(tmp_path / "flat.pdf", lambda d, p:
                          p.draw_rect(pymupdf.Rect(20, 27, 170, 43), fill=(1, 1, 0), fill_opacity=0.5)))
    assert native["text_hash"] == flat["text_hash"]
    assert native["base_render_hash"] != flat["base_render_hash"]
    assert native["annotation_count"] == 1 and flat["annotation_count"] == 0


def test_dates_document_metadata_and_xref_numbers_do_not_change_annotation_semantics(tmp_path):
    results = []
    for offset in (0, 6):
        def mutate(d, p):
            for _ in range(offset):
                d.update_object(d.get_new_xref(), "<</Synthetic true>>")
            a = note(d, p)
            a.set_info(creationDate=f"D:2026010{offset + 1}000000Z",
                       modDate=f"D:2026020{offset + 1}000000Z")
            d.xref_set_key(a.xref, "NM", f"(random-name-{offset})")
            a.update()
            d.set_metadata({"title": f"A synthetic title {offset}"})
        results.append(render(make_pdf(tmp_path / f"meta-{offset}.pdf", mutate)))
    assert results[0]["sha256"] != results[1]["sha256"]
    assert results[0]["annotation_semantic_hash"] == results[1]["annotation_semantic_hash"]
    assert results[0]["annotation_visual_hash"] == results[1]["annotation_visual_hash"]


def test_reply_parent_relationship_is_hashed_without_xrefs(tmp_path):
    results = []
    for target in (0, 1):
        def mutate(d, p):
            first = highlight(d, p)
            second = highlight(d, p, (20, 55, 100, 65))
            child = note(d, p, "A reply")
            child.set_irt_xref([first.xref, second.xref][target])
        results.append(render(make_pdf(tmp_path / f"reply-{target}.pdf", mutate)))
    assert all(r["annotation_count"] == 3 for r in results)
    assert all(sum(bool(a["parent_semantic_hash"]) for a in r["annotations"]) == 1 for r in results)
    assert results[0]["annotation_semantic_hash"] != results[1]["annotation_semantic_hash"]


def test_reply_and_parent_xref_reordering_stays_stable(tmp_path):
    results = []
    for offset in (0, 7):
        def mutate(d, p):
            for _ in range(offset):
                d.update_object(d.get_new_xref(), "<</Synthetic true>>")
            parent = highlight(d, p)
            child = note(d, p, "A reply")
            child.set_irt_xref(parent.xref)
        results.append(render(make_pdf(tmp_path / f"reply-xref-{offset}.pdf", mutate)))
    assert results[0]["annotation_semantic_hash"] == results[1]["annotation_semantic_hash"]


def test_dsh_transaction_identity_ignored_but_transcription_source_retained(tmp_path):
    results = []
    for index, source in enumerate(("manual", "manual", "ocr")):
        def mutate(d, p):
            a = note(d, p)
            payload = {"kind": "linked-handwriting-text", "transcription_source": source,
                       "request_id": f"{index}", "request_hash": f"hash-{index}",
                       "parent_id": f"parent-{index}", "geometry_version": f"version-{index}"}
            a.set_info(subject="paper-library:" + json.dumps(payload))
            a.update()
        results.append(render(make_pdf(tmp_path / f"dsh-{index}.pdf", mutate)))
    assert results[0]["annotation_semantic_hash"] == results[1]["annotation_semantic_hash"]
    assert results[0]["annotation_semantic_hash"] != results[2]["annotation_semantic_hash"]


def test_attachment_payload_distinguishes_same_icon_and_comment(tmp_path):
    results = []
    for color in ("red", "blue"):
        def mutate(d, p):
            a = p.add_file_annot((120, 120), f'<svg><path stroke="{color}"/></svg>'.encode(),
                                "handwriting.svg", desc="Synthetic handwriting")
            a.set_info(content="Same comment", title="Reader")
            a.update()
        results.append(render(make_pdf(tmp_path / f"attachment-{color}.pdf", mutate)))
    assert results[0]["annotation_visual_hash"] == results[1]["annotation_visual_hash"]
    assert results[0]["annotation_semantic_hash"] != results[1]["annotation_semantic_hash"]


def test_appearance_stream_difference_is_detected_by_visual_hash(tmp_path):
    results = []
    for color in ("1 1 0", "0 1 0"):
        def mutate(d, p):
            a = highlight(d, p)
            xref = int(d.xref_get_key(a.xref, "AP/N")[1].split()[0])
            stream = d.xref_stream(xref)
            assert b"1 1 0 rg" in stream
            d.update_stream(xref, stream.replace(b"1 1 0 rg", f"{color} rg".encode()))
        results.append(render(make_pdf(tmp_path / f"appearance-{color}.pdf", mutate)))
    assert results[0]["annotation_semantic_hash"] == results[1]["annotation_semantic_hash"]
    assert results[0]["annotation_visual_hash"] != results[1]["annotation_visual_hash"]


def test_multiset_retains_duplicate_annotation_count(tmp_path):
    results = []
    for count in (1, 2):
        def mutate(d, p):
            for _ in range(count):
                note(d, p)
        results.append(render(make_pdf(tmp_path / f"multiplicity-{count}.pdf", mutate)))
    assert results[0]["annotations"][0]["semantic_hash"] == results[1]["annotations"][0]["semantic_hash"]
    assert results[0]["annotation_semantic_hash"] != results[1]["annotation_semantic_hash"]


def test_links_excluded_and_widgets_reported_as_partial(tmp_path):
    def mutate(d, p):
        p.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(20, 25, 100, 45),
                       "uri": "https://example.invalid/synthetic"})
        w = pymupdf.Widget()
        w.field_name = "synthetic-form"
        w.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        w.field_value = "A value"
        w.rect = pymupdf.Rect(20, 220, 180, 250)
        p.add_widget(w)
    result = fp.fingerprint(make_pdf(tmp_path / "form.pdf", mutate), mode="render")
    assert result["status"] == "partial"
    assert result["annotation_count"] == 0
    assert result["excluded_annotation_counts"] == {"Link": 1, "Popup": 0, "Widget": 1}
    assert "form_widgets_not_compared" in result["warnings"]


def test_unknown_annotation_type_is_not_complete_empty(tmp_path):
    def mutate(d, p):
        a = note(d, p)
        d.xref_set_key(a.xref, "Subtype", "/UnknownSynthetic")
    result = fp.fingerprint(make_pdf(tmp_path / "unknown.pdf", mutate))
    assert result["status"] == "partial"
    assert "unsupported_annotation_type" in result["warnings"]


def test_indirect_annotation_array_matches_direct_array(tmp_path):
    direct = render(make_pdf(tmp_path / "direct.pdf", note))

    def mutate(doc, page):
        note(doc, page)
        kind, array = doc.xref_get_key(page.xref, "Annots")
        assert kind == "array"
        xref = doc.get_new_xref()
        doc.update_object(xref, array)
        doc.xref_set_key(page.xref, "Annots", f"{xref} 0 R")

    indirect = render(make_pdf(tmp_path / "indirect.pdf", mutate))
    assert indirect["annotation_count"] == direct["annotation_count"] == 1
    assert indirect["excluded_annotation_counts"]["Popup"] == 1
    assert indirect["annotation_semantic_hash"] == direct["annotation_semantic_hash"]
    assert indirect["annotation_visual_hash"] == direct["annotation_visual_hash"]


@pytest.mark.parametrize("invalid_array", ["dictionary", "inline_dictionary", "cycle"])
def test_invalid_indirect_annotation_array_stays_partial(tmp_path, invalid_array):
    def mutate(doc, page):
        xref = doc.get_new_xref()
        values = {"dictionary": "<< /Synthetic true >>",
                  "inline_dictionary": "[ << /Type /Annot /Subtype /Text /Rect [20 30 40 50] >> ]",
                  "cycle": f"[{xref} 0 R]"}
        doc.update_object(xref, values[invalid_array])
        doc.xref_set_key(page.xref, "Annots", f"{xref} 0 R")

    result = fp.fingerprint(make_pdf(tmp_path / "invalid-indirect.pdf", mutate))
    assert result["status"] == "partial"
    assert result["warnings"]


def test_symlink_and_directory_rejected(tmp_path):
    path = make_pdf(tmp_path / "plain.pdf")
    link = tmp_path / "link.pdf"
    link.symlink_to(path)
    for source in (link, tmp_path):
        with pytest.raises(fp.FingerprintError, match="not_regular_file"):
            fp.fingerprint(source)


def test_dataless_file_rejected_before_open(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "lstat", lambda _: SimpleNamespace(st_mode=stat.S_IFREG,
                                                                st_flags=0x40000000))
    monkeypatch.setattr(fp.os, "open", lambda *a, **kw: pytest.fail("must not open dataless file"))
    with pytest.raises(fp.FingerprintError, match="dataless_file"):
        fp.fingerprint(tmp_path / "cloud.pdf")


def test_page_and_pixel_limits(tmp_path):
    path = make_pdf(tmp_path / "two-pages.pdf", pages=2)
    with pytest.raises(fp.FingerprintError, match="page_count_limit"):
        fp.fingerprint(path, max_pages=1)
    with pytest.raises(fp.FingerprintError, match="page_pixel_limit"):
        fp.fingerprint(path, mode="render", max_page_pixels=10)


def test_source_change_detected(tmp_path, monkeypatch):
    path = make_pdf(tmp_path / "changed.pdf")
    original = fp._page_annotations
    def changed(*args, **kwargs):
        result = original(*args, **kwargs)
        with path.open("ab") as stream:
            stream.write(b"\n% a synthetic concurrent change\n")
        return result
    monkeypatch.setattr(fp, "_page_annotations", changed)
    with pytest.raises(fp.FingerprintError, match="source_changed"):
        fp.fingerprint(path)


def test_cli_error_contains_no_path_or_document_content(tmp_path):
    path = tmp_path / "private-name.pdf"
    path.write_bytes(b"Private synthetic material that is not a PDF")
    process = subprocess.run([sys.executable, str(SPEC.origin), "--path", str(path)],
                             capture_output=True, text=True, timeout=15)
    assert process.returncode == 2
    result = json.loads(process.stdout)
    assert result["status"] == "error"
    assert "private-name" not in process.stdout + process.stderr
    assert "Private synthetic" not in process.stdout + process.stderr
    assert process.stderr == ""
