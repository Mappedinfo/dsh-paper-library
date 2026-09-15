"""Synthetic bounded source reads; every source remains unchanged."""
import hashlib
import json
from pathlib import Path

import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.datasets import dispatch
from dsh_paper_library.dataset_preview import LIMITS


def call(library, action, **args):
    return dispatch(library, {"action": action, **args})


@pytest.fixture
def setup(tmp_path):
    library = Library(tmp_path / "library")
    data = call(library, "dataset_put", metadata={"title": "Synthetic preview data"}, expected_revision=0)
    yield library, data, tmp_path
    library.close()


def register(setup, text, filename="sample.csv", binary=False):
    library, data, path = setup
    source = path / filename
    source.write_bytes(text if binary else text.encode())
    asset = call(library, "dataset_asset_put", id=data["id"], path=str(source), expected_revision=0)
    return source, asset


def preview(setup, asset):
    library, data, _ = setup
    return call(library, "dataset_asset_preview", id=data["id"], asset_id=asset["id"])


def test_large_csv_only_samples_rows_and_preserves_source(setup):
    source, asset = register(setup, "a,b\n" + "1,synthetic\n" * 150000)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    result = preview(setup, asset)
    assert result["columns"] == ["a", "b"] and len(result["rows"]) == 100
    assert result["truncated"] and result["sample_only"] and result["total_rows"] is None
    assert result["bytes_read"] < 5000 and result["source"]["sample_sha256"]
    assert result["file_sha256"] is None and result["source"]["file_changed"] is False
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    library, data, _ = setup
    assert call(library, "dataset_asset_list", id=data["id"])["items"][0]["storage"] == "linked"
    assert not list((library.root / "pdfs").iterdir())


def test_quoted_multiline_csv_utf8_tsv_and_jsonl_columns(setup):
    _, asset = register(setup, '\ufeffname,note\n"甲","line one\nline two"\n')
    result = preview(setup, asset)
    assert result["columns"] == ["name", "note"] and result["rows"] == [["甲", "line one\nline two"]]
    _, asset = register(setup, "x\ty\n1\t2\n", "sample.tsv")
    assert preview(setup, asset)["rows"] == [["1", "2"]]
    _, asset = register(setup, '{"x":1}\n{"x":2,"y":"later"}\n', "sample.jsonl")
    assert preview(setup, asset)["rows"] == [[1, None], [2, "later"]]


@pytest.mark.parametrize("text,name,warning", [
    (b"name\n" + b"x" * 1000000, "long.csv", "64 KiB"),
    (b"name\n" + b"x" * 9000 + b"\n", "field.csv", "field"),
    (b"name\n\xff\xfe\n", "bad.csv", "decode"),
    (b'{"a":NaN}\n', "bad.jsonl", "Non-finite"),
    (b'{"a":}\n', "malformed.jsonl", "Expecting"),
])
def test_hostile_rows_are_bounded_and_reported(setup, text, name, warning):
    _, asset = register(setup, text, name, True)
    result = preview(setup, asset)
    assert result["status"] == "error" and result["truncated"]
    assert warning.lower() in " ".join(result["warnings"]).lower()
    assert result["bytes_read"] <= LIMITS["line_bytes"] + 100
    assert len(json.dumps(result).encode()) <= LIMITS["output_bytes"]


def test_output_columns_and_total_byte_limits(setup):
    text = ",".join(f"c{i}" for i in range(80)) + "\n" + ",".join("value" for _ in range(80)) + "\n"
    _, asset = register(setup, text)
    result = preview(setup, asset)
    assert len(result["columns"]) == len(result["rows"][0]) == 50 and result["truncated"]
    text = "a\n" + ("中" * 8000 + "\n") * 100
    _, asset = register(setup, text, "output.csv")
    result = preview(setup, asset)
    assert result["truncated"] and 1 <= len(result["rows"]) < 100
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= LIMITS["output_bytes"]


def test_missing_replaced_and_unsupported_files(setup):
    source, asset = register(setup, "opaque", "sample.zip")
    assert preview(setup, asset)["status"] == "unsupported"
    source.unlink()
    assert preview(setup, asset)["status"] == "missing"
    replacement = source.with_suffix(".new")
    replacement.write_text("different")
    replacement.rename(source)
    with pytest.raises(ValueError, match="identity changed"):
        preview(setup, asset)
    library, data, _ = setup
    external = call(library, "dataset_asset_put", id=data["id"], url="https://example.test/large.zip", expected_revision=0)
    assert preview(setup, external)["status"] == "unsupported"
    with pytest.raises(ValueError, match="regular"):
        call(library, "dataset_asset_put", id=data["id"], path=str(source.parent), expected_revision=0)


def test_preview_checks_time_and_input_budget(setup, monkeypatch):
    import dsh_paper_library.dataset_preview as module
    _, asset = register(setup, "a\n" + "\n" * 10000)
    monkeypatch.setitem(module.LIMITS, "input_bytes", 100)
    result = preview(setup, asset)
    assert result["bytes_read"] <= 100 and result["truncated"]
    monkeypatch.setitem(module.LIMITS, "seconds", -1)
    result = preview(setup, asset)
    assert result["bytes_read"] == 0 and "time budget" in " ".join(result["warnings"])


def test_multiline_unicode_column_names_cannot_exceed_response_budget(setup):
    # Every field and physical line is valid individually; their combined
    # header must still fit the response budget before being published.
    column = "中" * 4000 + "\n" + "文" * 3999
    _, asset = register(setup, ",".join(f'"{column}"' for _ in range(50)) + "\n")
    result = preview(setup, asset)
    assert result["status"] == "error" and result["columns"] == [] and result["rows"] == []
    assert "Column names" in " ".join(result["warnings"])
    assert result["bytes_read"] <= LIMITS["input_bytes"]
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= LIMITS["output_bytes"]
