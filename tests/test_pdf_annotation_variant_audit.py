"""Synthetic driver tests: no private PDFs, network, or source writes."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/audit-pdf-annotation-variants.py"
SPEC = importlib.util.spec_from_file_location("pdf_annotation_variant_audit", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def record(identity, *, byte_hash=None, semantic="same", visual="same", base="base", annotations=None, **extra):
    rows = annotations if annotations is not None else [{"semantic_hash": semantic, "page": 1}]
    return {
        "physical_id": identity, "sha256": byte_hash or identity,
        "status": "complete", "geometry_hash": "geometry", "base_render_hash": base,
        "annotation_semantic_hash": semantic, "annotation_visual_hash": visual,
        "annotations": rows, "annotation_count": len(rows), "page_count": 2,
        **extra,
    }


def test_same_semantics_and_visuals_are_equal_despite_byte_or_metadata_changes():
    first = record("one", mod_date="old", annotation_ids=["xref12"])
    second = record("two", mod_date="new", annotation_ids=["xref52"])
    variants, equal = audit.classify([first, second])
    assert variants == []
    assert len(equal) == 1
    assert len(equal[0]["files"]) == 2


def test_same_count_different_comment_semantics_is_not_equal():
    first = record("one", semantic="comment-one")
    second = record("two", semantic="comment-two")
    variants, equal = audit.classify([first, second])
    assert equal == []
    pair = variants[0]["pairs"][0]
    assert pair["classification"] == "semantic-only"
    assert pair["semantic_relation"] == "different"
    assert pair["left_only_annotations"] == pair["right_only_annotations"] == 1
    assert pair["semantic_difference_pages"] == [1]


def test_different_base_render_is_never_reported_as_annotation_variant():
    first = record("one", semantic="a", base="figure-one")
    second = record("two", semantic="b", base="figure-two")
    assert audit.classify([first, second]) == ([], [])


def test_subset_uses_semantic_multiset_and_preserves_repeated_annotations():
    first = record("one", semantic="one-note", annotations=[{"semantic_hash": "a", "page": 1}])
    second = record("two", semantic="two-notes", annotations=[
        {"semantic_hash": "a", "page": 1}, {"semantic_hash": "a", "page": 1},
    ])
    variants, _ = audit.classify([first, second])
    pair = variants[0]["pairs"][0]
    assert pair["semantic_relation"] == "left-subset"
    assert pair["left_only_annotations"] == 0
    assert pair["right_only_annotations"] == 1


def test_visual_only_difference_is_review_category():
    first = record("one", visual="stamp-one")
    second = record("two", visual="stamp-two")
    variants, equal = audit.classify([first, second])
    assert equal == []
    pair = variants[0]["pairs"][0]
    assert pair["classification"] == "appearance-only-review"
    assert pair["semantic_relation"] == "equal"
    assert pair["semantic_difference_pages"] == []


def test_partial_records_and_exact_byte_duplicates_do_not_create_groups():
    assert audit.classify([record("a", byte_hash="same"), record("b", byte_hash="same")]) == ([], [])
    assert audit.classify([record("a"), record("b", semantic="changed", status="partial")]) == ([], [])


def test_alias_byte_copies_preserved_but_pairs_compare_version_representatives():
    one = record("one", byte_hash="version-one", semantic="old")
    copy = record("copy", byte_hash="version-one", semantic="old")
    changed = record("changed", byte_hash="version-two", semantic="new", visual="changed")
    variants, equal = audit.classify([one, copy, changed])
    assert equal == []
    assert len(variants[0]["files"]) == 3
    assert len(variants[0]["pairs"]) == 1
    assert variants[0]["pairs"][0]["classification"] == "semantic-and-visual"


def test_worker_timeout_is_reported_without_exposing_worker_output(monkeypatch):
    calls = []

    def timeout(command, **kwargs):
        calls.append((command, kwargs))
        raise subprocess.TimeoutExpired(command, kwargs["timeout"], output="private text")

    monkeypatch.setattr(audit.subprocess, "run", timeout)
    args = SimpleNamespace(dpi=120, max_pages=2000, max_page_pixels=16000000, timeout=3)
    result = audit.inspect_one({"references": [{"local_path": "/synthetic/example.pdf"}]}, args, "inspect")
    assert result == {"status": "error", "error": "timeout"}
    assert calls[0][1]["timeout"] == 3
    assert "-B" in calls[0][0]


def test_private_report_permissions_and_no_overwrite(tmp_path):
    target = tmp_path / "report.json"
    audit.write_private(target, "first")
    assert target.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        audit.write_private(target, "replacement")
    assert target.read_text() == "first"


def test_output_cannot_be_nested_in_source_even_through_symlink(tmp_path, monkeypatch):
    source = tmp_path / "managed"
    source.mkdir()
    link = tmp_path / "source-link"
    link.symlink_to(source, target_is_directory=True)
    inventory = tmp_path / "inventory.json"
    inventory.write_text(json.dumps({"files": [], "sources": [{"root": str(source)}]}))
    monkeypatch.setattr(audit.sys, "argv", [str(SCRIPT), "--inventory", str(inventory), "--out", str(link / "report")])
    with pytest.raises(SystemExit) as error:
        audit.main()
    assert error.value.code == 2
    assert not (source / "report").exists()
