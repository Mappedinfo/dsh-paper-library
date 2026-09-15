"""Synthetic source ownership, review, crash recovery and dataset provenance."""
import json
import os
import pytest
from dsh_paper_library.core import Library
from dsh_paper_library import library_knowledge as knowledge


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    library = Library(tmp_path / "knowledge-fixture")
    records = {
        "synthetic-data": {"id": "synthetic-data", "title": "Synthetic Dataset", "citekey": "SyntheticDataset", "type": "dataset", "DOI": "10.0000/synthetic", "version": "2.0", "author": [{"literal": "Synthetic Consortium"}], "issued": {"date-parts": [[2025]]}},
        "synthetic-paper": {"id": "synthetic-paper", "title": "Synthetic Paper", "citekey": "SyntheticPaper", "type": "article-journal"},
    }
    def lookup(_, entity):
        if entity["id"] not in records:
            raise ValueError("resource missing")
        return records[entity["id"]]
    monkeypatch.setattr(knowledge, "resource", lookup)
    yield library
    library.close()


ENTITY = {"kind": "dataset", "id": "synthetic-data"}
PAPER = {"kind": "paper", "id": "synthetic-paper"}


def call(library, action, **kwargs):
    return knowledge.dispatch(library, {"action": action, **kwargs})


def source(library, **kwargs):
    return call(library, "knowledge_source_put", **{"entity": ENTITY, "kind": "official-excerpt", "url": "https://example.org/synthetic", "text": "The synthetic release contains 12 sample records.", **kwargs})


def draft(library, source, **kwargs):
    return call(library, "knowledge_draft_put", **{"entity": source["entity"], "source_ids": [source["id"]], "request_id": "graph-1", "nodes": [
        {"id": "excerpt", "type": "evidence", "label": "Record count", "source_id": source["id"]},
        {"id": "reported", "type": "observation", "label": "12 sample records", "source_node": "evidence:excerpt"},
        {"id": "bounded", "type": "claim", "label": "This release has 12 sample records."},
    ], "edges": [{"subject": "observation:reported", "object": f"{source['entity']['kind']}:{source['entity']['id']}", "relation": "observed_on"}] if source["entity"]["kind"] == "dataset" else [],
    "assertions": [{"subject": "observation:reported", "object": "claim:bounded", "relation": "supports", "surface": "Only this release"}], **kwargs})


def accept(library, value):
    return call(library, "knowledge_draft_review", id=value["id"], expected_revision=value["revision"], decision="accepted", reviewed_by="user")


def test_dataset_native_snapshot_deduplicates_without_a_paper(catalog, monkeypatch):
    monkeypatch.setattr(catalog, "annotation_context_exact", lambda *a, **k: pytest.fail("must not parse PDF"))
    first, again = source(catalog), source(catalog)
    assert first == again
    assert first["entity"] == ENTITY
    assert first["verification"] == "unverified"
    assert first["locator"]["page"] is None
    assert first["content_hash"] == knowledge.digest(first["text"])
    changed = source(catalog, text="A later source version")
    assert first["id"] != changed["id"]
    assert call(catalog, "knowledge_source_get", id=first["id"])["text"] == first["text"]


@pytest.mark.parametrize("kind,verification", [("metadata", "metadata-only"), ("source-note", "source-note"), ("user-text", "source-note")])
def test_source_level_never_promoted_by_client(catalog, kind, verification):
    value = source(catalog, kind=kind, verification="full-text")
    assert value["verification"] == verification


def test_annotation_requires_exact_saved_version_and_preserves_comment(catalog, monkeypatch):
    seen = []
    def exact(id, refs, **kwargs):
        seen.append((id, refs, kwargs))
        return {"annotations": [{"id": "note-1", "version": "a" * 64, "text": "Saved quote", "comment": "Reader inference", "page": 3}]}
    monkeypatch.setattr(catalog, "annotation_context_exact", exact)
    value = source(catalog, entity=PAPER, kind="annotation", annotation_ref={"id": "note-1", "version": "a" * 64}, text="Forged quote", locator={"page": 1})
    assert value["text"] == "Saved quote"
    assert value["comment"] == "Reader inference"
    assert value["locator"]["page"] == 3
    assert seen[0][1] == [{"id": "note-1", "version": "a" * 64}]
    with pytest.raises(ValueError, match="annotation source"):
        source(catalog, kind="annotation", annotation_ref={"id": "note-1", "version": "a" * 64})


def test_ai_high_confidence_and_omitted_status_are_reviewable_not_accepted(catalog):
    value = draft(catalog, source(catalog), status="accepted", coding_confidence="high", origin="llm")
    assert value["status"] == "needs-review"
    assert all(node["status"] == "needs-review" and node["origin"] == "llm" for node in value["nodes"])
    assert value["assertions"][0]["status"] == "needs-review"
    assert not call(catalog, "knowledge_export", entity=ENTITY)["drafts"]
    with pytest.raises(ValueError, match="explicit user"):
        call(catalog, "knowledge_draft_review", id=value["id"], expected_revision=1, decision="accepted", reviewed_by="llm")
    accepted = accept(catalog, value)
    assert accepted["status"] == "accepted" and accepted["origin"] == "llm"
    assert call(catalog, "knowledge_source_get", id=value["source_ids"][0])["verification"] == "unverified"
    assert call(catalog, "knowledge_export", entity=ENTITY)["drafts"][0]["id"] == accepted["id"]
    with pytest.raises(ValueError, match="STATE_CONFLICT"):
        accept(catalog, value)


def test_explicit_annotation_change_check_never_rewrites_snapshot(catalog, monkeypatch):
    monkeypatch.setattr(catalog, "annotation_context_exact", lambda *a, **k: {"annotations": [{"id": "note-1", "version": "a" * 64, "text": "Saved quote", "page": 3}]})
    frozen = source(catalog, entity=PAPER, kind="annotation", annotation_ref={"id": "note-1", "version": "a" * 64})
    assert call(catalog, "knowledge_source_check", id=frozen["id"])["status"] == "unchanged"
    for code, expected in (("ANNOTATION_STALE", "changed"), ("ANNOTATION_MISSING", "missing")):
        def fail(*args, **kwargs):
            raise ValueError(code + ": synthetic source changed")
        monkeypatch.setattr(catalog, "annotation_context_exact", fail)
        assert call(catalog, "knowledge_source_check", id=frozen["id"])["status"] == expected
        assert call(catalog, "knowledge_source_get", id=frozen["id"]) == frozen
    external = source(catalog)
    assert call(catalog, "knowledge_source_check", id=external["id"])["status"] == "snapshot-only"


def test_draft_generation_idempotency_and_content_conflict(catalog):
    snapshot = source(catalog)
    first = draft(catalog, snapshot)
    assert draft(catalog, snapshot)["id"] == first["id"]
    with pytest.raises(ValueError, match="REQUEST_CONFLICT"):
        draft(catalog, snapshot, title="Changed input on same request")
    assert call(catalog, "knowledge_draft_list", entity=ENTITY)["total"] == 1


@pytest.mark.parametrize("mutation,error", [
    ({"assertions": [{"subject": "dataset:synthetic-data", "object": "claim:bounded", "relation": "supports"}]}, "Assertion"),
    ({"edges": [{"subject": "observation:reported", "object": "dataset:missing", "relation": "observed_on"}]}, "endpoint"),
    ({"nodes": [{"id": "fake", "type": "evidence", "label": "Fake", "source_id": "missing"}]}, "selected source"),
    ({"nodes": [{"id": "fake", "type": "causal-truth", "label": "Fake"}]}, "node type"),
])
def test_graph_rejects_wrong_types_and_unselected_provenance(catalog, mutation, error):
    with pytest.raises(ValueError, match=error):
        draft(catalog, source(catalog), **mutation)


def test_fabricated_quote_and_duplicate_atomic_relation_rejected(catalog):
    snapshot = source(catalog)
    with pytest.raises(ValueError, match="exact source"):
        draft(catalog, snapshot, nodes=[{"id": "fake", "type": "evidence", "label": "Fake", "source_id": snapshot["id"], "quote": "Not in source"}])
    edge = {"subject": "observation:reported", "object": "dataset:synthetic-data", "relation": "observed_on"}
    with pytest.raises(ValueError, match="duplicate atomic"):
        draft(catalog, snapshot, edges=[edge, edge])


def test_selected_source_and_utf8_note_budgets(catalog):
    one, two = source(catalog, text="a" * 13000), source(catalog, text="b" * 13000)
    with pytest.raises(ValueError, match="SOURCE_BUDGET"):
        draft(catalog, one, source_ids=[one["id"], two["id"]])
    with pytest.raises(ValueError, match="64000 bytes"):
        call(catalog, "knowledge_note_put", entity=ENTITY, source_ids=[one["id"]], body="字" * 22000, title="Too large", expected_revision=0)


def test_markdown_body_is_file_authority_and_cas_preserves_old_revision(catalog):
    snapshot = source(catalog)
    args = {"entity": ENTITY, "title": "Synthetic note", "body": "# Dataset\n\nA scoped explanation.", "source_ids": [snapshot["id"]], "expected_revision": 0}
    first = call(catalog, "knowledge_note_put", **args)
    stored = catalog.db.execute("SELECT payload FROM knowledge_notes WHERE id=?", (first["id"],)).fetchone()[0]
    assert '"body":' not in stored
    assert (catalog.root / first["body_path"]).read_text() == args["body"]
    second = call(catalog, "knowledge_note_put", **{**args, "id": first["id"], "expected_revision": 1, "body": "New explanation"})
    assert second["revision"] == 2
    assert (catalog.root / first["body_path"]).read_text() == args["body"]
    with pytest.raises(ValueError, match="STATE_CONFLICT"):
        call(catalog, "knowledge_note_put", **{**args, "id": first["id"], "expected_revision": 1, "body": "stale"})
    assert call(catalog, "knowledge_note_get", id=first["id"])["body"] == "New explanation"
    assert os.stat(catalog.root / second["body_path"]).st_mode & 0o777 == 0o600


def test_note_crash_after_body_publication_recovers_durable_intent(catalog, monkeypatch):
    snapshot = source(catalog)
    original = knowledge.finish_note
    def interrupted(library, intent):
        stage = library.root / intent["stage"]
        final = library.root / intent["value"]["body_path"]
        os.replace(stage, final)
        raise OSError("synthetic crash after rename")
    monkeypatch.setattr(knowledge, "finish_note", interrupted)
    with pytest.raises(OSError, match="synthetic crash"):
        call(catalog, "knowledge_note_put", id="kn-recovery", entity=ENTITY, title="Recoverable", body="Saved intent body", source_ids=[snapshot["id"]], expected_revision=0)
    assert catalog.db.execute("SELECT count(*) FROM knowledge_note_pending").fetchone()[0] == 1
    monkeypatch.setattr(knowledge, "finish_note", original)
    recovered = call(catalog, "knowledge_note_get", id="kn-recovery")
    assert recovered["body"] == "Saved intent body"
    assert catalog.db.execute("SELECT count(*) FROM knowledge_note_pending").fetchone()[0] == 0


def test_external_markdown_conflict_detected_without_overwriting(catalog):
    snapshot = source(catalog)
    note = call(catalog, "knowledge_note_put", entity=ENTITY, title="N", body="Original", source_ids=[snapshot["id"]], expected_revision=0)
    path = catalog.root / note["body_path"]
    path.write_text("External edit")
    with pytest.raises(ValueError, match="BODY_CHANGED"):
        call(catalog, "knowledge_note_get", id=note["id"])
    assert path.read_text() == "External edit"


def test_lists_are_entity_scoped_bounded_previews(catalog):
    source(catalog, text="x" * 1000)
    source(catalog, entity=PAPER)
    page = call(catalog, "knowledge_source_list", entity=ENTITY, limit=1)
    assert page["total"] == 1
    assert len(page["items"][0]["text"]) == 240 and page["items"][0]["preview"]
    with pytest.raises(ValueError, match="pagination"):
        call(catalog, "knowledge_source_list", entity=ENTITY, limit=101)


def test_export_preserves_dataset_citation_and_reports_rkos_native_source_loss(catalog):
    snapshot = source(catalog)
    accepted = accept(catalog, draft(catalog, snapshot))
    bundle = call(catalog, "knowledge_export", entity=ENTITY, format="library-json")
    assert bundle["scope"] == "selected-knowledge-records"
    assert bundle["sources"][0]["entity"] == ENTITY
    assert bundle["drafts"][0]["assertions"][0]["object"] == "claim:bounded"
    adapted = call(catalog, "knowledge_export", entity=ENTITY, format="rkos-v3")
    assert "@dataset{SyntheticDataset" in adapted["files"]["citations.bib"]
    assert "version = {2.0}" in adapted["files"]["citations.bib"]
    assert "@graph{" in adapted["files"]["library.literature.knowledge.bib"]
    assert "SyntheticDataset" not in adapted["files"]["library.literature.knowledge.bib"]
    assert any(item["code"] == "RKOS_DATASET_SOURCE_UNSUPPORTED" for item in adapted["losses"])
    assert adapted["complete"] is False
    assert adapted["drafts"][0]["id"] == accepted["id"]


def test_invalid_paths_and_source_credentials_fail_closed(catalog):
    with pytest.raises(ValueError, match="credentials"):
        source(catalog, url="https://name:password@example.org/data")
    with pytest.raises(ValueError, match="identifier"):
        call(catalog, "knowledge_source_get", id="../catalog.sqlite3")
