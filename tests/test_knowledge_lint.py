"""Read-only graph lint findings over stored knowledge drafts."""
import json
import pytest
from dsh_paper_library.core import Library
from dsh_paper_library import library_knowledge as knowledge


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    library = Library(tmp_path / "lint-fixture")
    monkeypatch.setattr(knowledge, "resource", lambda _library, entity: {"id": entity["id"], "title": "Synthetic"})
    yield library
    library.close()


ENTITY = {"kind": "dataset", "id": "synthetic-data"}


def call(library, action, **kwargs):
    return knowledge.dispatch(library, {"action": action, **kwargs})


def make_source(library):
    return call(library, "knowledge_source_put", entity=ENTITY, kind="official-excerpt",
                url="https://example.org/synthetic", text="The synthetic release contains 12 sample records.")


def test_lint_flags_unsupported_claim_isolated_node_and_unused_evidence(catalog):
    source = make_source(catalog)
    draft = call(catalog, "knowledge_draft_put", entity=ENTITY, source_ids=[source["id"]], request_id="lint-1",
                 nodes=[
                     {"id": "excerpt", "type": "evidence", "label": "Record count", "source_id": source["id"]},
                     {"id": "extra", "type": "evidence", "label": "Unreferenced excerpt", "source_id": source["id"], "quote": "12 sample records"},
                     {"id": "reported", "type": "observation", "label": "12 sample records", "source_node": "evidence:excerpt"},
                     {"id": "supported", "type": "claim", "label": "The release has 12 records."},
                     {"id": "orphan-claim", "type": "claim", "label": "Nothing supports this."},
                     {"id": "lonely", "type": "concept", "label": "Unconnected concept"},
                 ],
                 edges=[{"subject": "observation:reported", "object": "dataset:synthetic-data", "relation": "observed_on"}],
                 assertions=[{"subject": "observation:reported", "object": "claim:supported", "relation": "supports"}])
    report = call(catalog, "knowledge_draft_lint", id=draft["id"])
    assert report["id"] == draft["id"] and report["status"] == "needs-review"
    rules = {(finding["rule"], finding.get("node")) for finding in report["findings"]}
    assert ("unsupported-claim", "claim:orphan-claim") in rules
    assert ("isolated-node", "concept:lonely") in rules
    assert ("unused-evidence", "evidence:extra") in rules
    # Evidence grounding via observation.source_node counts as a connection.
    assert not any(node == "evidence:excerpt" for rule, node in rules)
    assert not any(node == "claim:supported" for rule, node in rules)
    assert report["counts"]["error"] == 0
    # Lint is read-only: the stored draft is byte-identical afterwards.
    assert call(catalog, "knowledge_draft_get", id=draft["id"]) == call(catalog, "knowledge_draft_get", id=draft["id"])


def test_lint_recognizes_observation_grounded_evidence_and_clean_graph(catalog):
    source = make_source(catalog)
    draft = call(catalog, "knowledge_draft_put", entity=ENTITY, source_ids=[source["id"]], request_id="lint-2",
                 nodes=[
                     {"id": "excerpt", "type": "evidence", "label": "Record count", "source_id": source["id"]},
                     {"id": "reported", "type": "observation", "label": "12 sample records", "source_node": "evidence:excerpt"},
                     {"id": "bounded", "type": "claim", "label": "The release has 12 records."},
                 ],
                 edges=[{"subject": "observation:reported", "object": "dataset:synthetic-data", "relation": "observed_on"}],
                 assertions=[{"subject": "observation:reported", "object": "claim:bounded", "relation": "supports"}])
    report = call(catalog, "knowledge_draft_lint", id=draft["id"])
    assert report["findings"] == []
    assert report["counts"] == {"error": 0, "warning": 0, "info": 0}


def test_lint_reports_dangling_endpoints_and_duplicates_in_legacy_payloads(catalog):
    source = make_source(catalog)
    draft = call(catalog, "knowledge_draft_put", entity=ENTITY, source_ids=[source["id"]], request_id="lint-3",
                 nodes=[{"id": "bounded", "type": "claim", "label": "A claim."}],
                 edges=[], assertions=[])
    # Simulate an older or externally produced record that write-time validation
    # would reject today; lint must still report it without attempting a repair.
    payload = draft.copy()
    payload["edges"] = [
        {"id": "kr-a", "subject": "claim:bounded", "object": "paper:missing", "relation": "extends", "status": "needs-review"},
        {"id": "kr-b", "subject": "claim:bounded", "object": "paper:missing", "relation": "extends", "status": "needs-review"},
    ]
    with catalog.lock():
        catalog.db.execute("UPDATE knowledge_drafts SET payload=? WHERE id=?", (knowledge.encoded(payload), draft["id"]))
    report = call(catalog, "knowledge_draft_lint", id=draft["id"])
    rules = [finding["rule"] for finding in report["findings"]]
    assert rules.count("dangling-endpoint") == 2  # one missing object endpoint per relation
    assert "duplicate-relation" in rules
    assert report["counts"]["error"] == 2 and report["counts"]["warning"] >= 1
