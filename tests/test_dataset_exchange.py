"""Citation-only exchange; not a backup of files or knowledge records."""
import json

import pytest

from dsh_paper_library.core import Library
from dsh_paper_library.datasets import DatasetConflictError, dispatch


def call(library, action, **values):
    return dispatch(library, {"action": action, **values})


def test_explicit_csl_family_release_roundtrip_and_idempotent_import(tmp_path):
    library, restored = Library(tmp_path / "original"), Library(tmp_path / "restored")
    try:
        paper = library.create({"title": "Synthetic study", "citekey": "Study"})
        dataset = call(library, "dataset_put", metadata={"title": "Synthetic agency data", "citekey": "Agency", "DOI": "10.5555/agency", "author": [{"literal": "Synthetic Agency"}]}, expected_revision=0)
        release = call(library, "dataset_release_put", id=dataset["id"], metadata={"version": "2026.1", "citekey": "Agency2026", "DOI": "10.5555/agency2026", "published": "2026-03"}, expected_revision=0)
        exported = call(library, "resource_export")
        assert [v["resource_kind"] for v in exported["items"]] == ["paper", "dataset", "release"]
        assert exported["items"][2]["version"] == "2026.1" and exported["items"][2]["dataset_id"] == dataset["id"]
        assert exported["items"][0]["id"] == paper["id"]
        inputs = exported["items"][1:]
        imported = call(restored, "dataset_import", items=inputs, source="synthetic-csl-export")
        assert imported["imported"] == 2 and not imported["conflicts"]
        again = call(restored, "dataset_import", items=inputs, source="synthetic-csl-export")
        assert again["duplicates"] == 2 and again["imported"] == 0
        plain_citations = [{key: value for key, value in item.items() if key not in {"resource_kind", "dataset_id", "external_id"}} for item in inputs]
        same_library = call(library, "dataset_import", items=plain_citations, source="synthetic-biblatex-parse")
        assert same_library["duplicates"] == 2 and same_library["imported"] == 0 and not same_library["conflicts"]
        new_dataset, new_release = imported["items"]
        assert new_dataset["id"] != dataset["id"] and new_release["dataset_id"] == new_dataset["id"]
        assert new_dataset["external_ids"][-1]["id"] == dataset["id"]
        cited = call(restored, "dataset_cite", id=new_dataset["id"], release_id=new_release["id"])["item"]
        assert cited["citekey"] == "Agency2026" and cited["DOI"] == "10.5555/agency2026" and cited["author"] == dataset["author"]
        assert library.get(paper["id"])["title"] == "Synthetic study"
    finally:
        library.close(); restored.close()


def test_plain_csl_versions_dont_invent_family_bindings_and_conflicts_checkpoint(tmp_path):
    library = Library(tmp_path / "library")
    try:
        source = {"id": "External2026", "type": "dataset", "title": "Synthetic dataset release", "version": "v1", "DOI": "10.5555/plain"}
        result = call(library, "dataset_import", items=[source, {**source, "id": "Conflict2026", "version": "v2"}, {"title": "Separate data", "type": "dataset"}])
        assert (result["imported"], result["skipped"]) == (2, 1)
        assert "versions" in result["conflicts"][0]["error"]
        current = call(library, "dataset_get", id=result["items"][0]["id"])
        assert current["version"] == "v1" and current["releases"] == []
        assert current["citekey"] == "External2026"
        call(library, "dataset_put", id=current["id"], metadata={"citekey": "RenamedCitation"}, expected_revision=current["revision"])
        old_alias = {"type": "dataset", "title": current["title"], "citekey": "External2026"}
        assert call(library, "dataset_import", items=[old_alias])["duplicates"] == 1
        assert not library.db.execute("SELECT 1 FROM resource_citekeys WHERE citekey='Conflict2026'").fetchone()
        paper = library.create({"title": "Legacy CSL dataset in paper table", "type": "dataset", "citekey": "Legacy"})
        rejected = call(library, "dataset_import", items=[{"type": "dataset", "title": "Legacy CSL dataset in paper table", "citekey": "Legacy"}])
        assert rejected["skipped"] == 1 and library.get(paper["id"])["id"] == paper["id"]
    finally:
        library.close()


def test_exchange_batches_and_catalog_change_detection(tmp_path):
    library = Library(tmp_path / "library")
    try:
        source = [{"type": "dataset", "title": f"Synthetic data {i}", "citekey": f"D{i:03}"} for i in range(101)]
        first = call(library, "dataset_import", items=source)
        assert first["imported"] == 100 and first["next_offset"] == 100 and not first["done"]
        second = call(library, "dataset_import", items=source, offset=100)
        assert second["imported"] == 1 and second["done"]
        page = call(library, "resource_export", kind="dataset", limit=40)
        assert page["total"] == 101 and len(page["items"]) == 40 and page["next_offset"] == 40
        next_page = call(library, "resource_export", kind="dataset", offset=40, limit=40, expected_catalog_revision=page["catalog_revision"])
        assert len(next_page["items"]) == 40
        call(library, "dataset_archive", id=first["items"][0]["id"], expected_revision=1)
        with pytest.raises(DatasetConflictError):
            call(library, "resource_export", offset=80, expected_catalog_revision=page["catalog_revision"])
    finally:
        library.close()


def test_exchange_byte_budget_returns_a_continuation_not_truncated_fields(tmp_path):
    library = Library(tmp_path / "library")
    try:
        description = "x" * 180000
        values = [{"type": "dataset", "title": f"Synthetic large record {i}", "description": description} for i in range(25)]
        assert call(library, "dataset_import", items=values)["imported"] == 25
        result = call(library, "resource_export", kind="dataset")
        assert 0 < len(result["items"]) < 25 and result["next_offset"] == len(result["items"])
        assert all(v["description"] == description for v in result["items"])
        assert len(json.dumps(result, ensure_ascii=False).encode()) <= 4 * 1024 * 1024
    finally:
        library.close()


def test_existing_mixed_import_path_routes_datasets_and_retains_pagination(tmp_path, monkeypatch):
    library = Library(tmp_path / "library")
    try:
        monkeypatch.setattr(library, "_open_pdf", lambda *args: pytest.fail("Dataset import opened an attachment"))
        raw = [{"title": "Synthetic paper", "type": "article-journal", "citekey": "Paper"},
               {"title": "Synthetic data", "type": "dataset", "citekey": "Data", "version": "v2"},
               {"title": "Zotero data", "itemType": "dataset", "key": "SYNTH001", "citationKey": "ZoteroData", "version": 300, "versionNumber": "v3", "attachments": [{"path": str(tmp_path / "must-not-open.pdf")}]}]
        source = tmp_path / "mixed.json"
        source.write_text(json.dumps(raw))
        initial = source.read_bytes()
        first = library.import_items(path=str(source), limit=2)
        assert first["imported"] == 2 and first["next_offset"] == 2 and not first["done"]
        second = library.import_items(path=str(source), offset=2)
        assert second["imported"] == 1 and second["done"] and second["items"][0]["version"] == "v3"
        assert {"source": "zotero-json", "id": "SYNTH001"} in second["items"][0]["external_ids"]
        assert any("not opened" in message for message in second["warnings"])
        assert library.list()["total"] == 1 and call(library, "resource_list", kind="dataset")["total"] == 2
        assert source.read_bytes() == initial
        ris = tmp_path / "synthetic.ris"
        ris.write_text("TY  - DATA\nTI  - Synthetic RIS dataset\nID  - RisData\nER  -\n")
        assert library.import_items(path=str(ris))["items"][0]["resource_kind"] == "dataset"
        assert library.import_items(items=raw)["duplicates"] == 3
        # An explicit legacy paper resource stays in the paper catalogue even
        # when its pre-upgrade bibliographic type happens to be dataset.
        legacy = library.create({"title": "Legacy paper dataset", "type": "dataset", "citekey": "LegacyData"})
        exported = call(library, "resource_export")
        replay = library.import_items(items=exported["items"])
        assert replay["duplicates"] == 5 and replay["imported"] == 0 and replay["skipped"] == 0
        assert library.get(legacy["id"])["id"] == legacy["id"]
        assert library.list()["total"] == 2
    finally:
        library.close()
