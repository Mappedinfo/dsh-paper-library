"""Check synthetic adapter output against one explicitly selected RKOS parser.

Calls pure parser/build/lint functions, never the CLI's registry/Wiki discovery.
The upstream skill is a validation input, not a packaged runtime dependency.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from dsh_paper_library.core import Library
from dsh_paper_library.datasets import dispatch as datasets
from dsh_paper_library.library_knowledge import dispatch as knowledge

parser = argparse.ArgumentParser()
parser.add_argument("--upstream-script", type=Path, required=True)
args = parser.parse_args()
path = args.upstream_script.resolve(strict=True)
if path.name != "research_graph.py" or path.stat().st_size > 1024 * 1024:
    raise ValueError("Select the bounded Research Knowledge OS parser source")
spec = importlib.util.spec_from_file_location("explicit_rkos_fixture", path)
upstream = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = upstream
spec.loader.exec_module(upstream)

with tempfile.TemporaryDirectory(prefix="rkos-subset-fixture-") as temp:
    library = Library(Path(temp) / "library")
    paper = library.create({"title": "Synthetic evidence paper", "citekey": "SyntheticEvidence", "type": "article-journal"})
    dataset = datasets(library, {"action": "dataset_put", "metadata": {"title": "Synthetic dataset", "citekey": "SyntheticDataset"}, "expected_revision": 0})
    def call(action, **kwargs):
        return knowledge(library, {"action": action, **kwargs})
    p, d = {"kind": "paper", "id": paper["id"]}, {"kind": "dataset", "id": dataset["id"]}
    source = call("knowledge_source_put", entity=p, kind="source-note", text="A synthetic test reports twelve records.", locator={"section": "Synthetic fixture"})
    draft = call("knowledge_draft_put", entity=p, source_ids=[source["id"]], nodes=[
        {"id": "records", "type": "topic", "label": "Synthetic records"},
        {"id": "count", "type": "concept", "label": "Record count", "fields": {"topic_id": "topic:records"}},
        {"id": "report", "type": "evidence", "label": "Synthetic report", "source_id": source["id"]},
        {"id": "twelve", "type": "claim", "label": "This synthetic fixture reports twelve records", "fields": {"concept_id": "concept:count"}},
    ], assertions=[{"subject": "evidence:report", "object": "claim:twelve", "relation": "supports", "surface": "A report about this fixture only", "coding_confidence": "high"}])
    call("knowledge_draft_review", id=draft["id"], expected_revision=1, decision="accepted", reviewed_by="user")
    dataset_source = call("knowledge_source_put", entity=d, kind="official-excerpt", text="Synthetic dataset documentation.", url="https://example.org/synthetic")
    candidate = call("knowledge_draft_put", entity=d, source_ids=[dataset_source["id"]], nodes=[{"id": "dataset-doc", "type": "evidence", "label": "Dataset source", "source_id": dataset_source["id"]}])
    call("knowledge_draft_review", id=candidate["id"], expected_revision=1, decision="accepted", reviewed_by="user")
    result = call("knowledge_export", entities=[p, d], format="rkos-v3")
    bibliography = upstream.parse_bib_text(result["files"]["rkos-references.bib"], "rkos-references.bib")
    entries = []
    for filename, text in result["files"].items():
        if filename.endswith(".knowledge.bib"):
            entries.extend(upstream.parse_bib_text(text, filename))
    graph = upstream.ResearchGraph.build(bibliography, entries)
    issues = upstream.lint_graph(graph)
    errors = [issue for issue in issues if issue.get("severity") == "error"]
    assert graph.nodes["evidence"] and graph.nodes["claim"] and graph.assertions, "Useful compatible records must survive"
    assert any(loss["code"] == "RKOS_DATASET_SOURCE_UNSUPPORTED" for loss in result["losses"])
    assert "@dataset{" in result["files"]["citations.bib"]
    assert "@dataset{" not in result["files"]["rkos-references.bib"]
    assert len(graph.papers) == 1, "Dataset must never become a fabricated Paper"
    report = {"verified_at": datetime.now(timezone.utc).isoformat(), "ok": not errors, "upstream_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "upstream_lint_executed": True, "private_registry_or_wiki_loaded": False, "model_calls": 0, "issues": issues, "loss_codes": sorted({item["code"] for item in result["losses"]}), "checks": ["pure upstream parser/build/lint on synthetic records", "compatible Evidence/Claim/Assertion retained", "dataset-native sources retained in JSON and explicitly reported as unsupported in v3", "bibliographic and graph datasets use separate file roles"]}
    (ROOT / "docs/validation/rkos-subset.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    library.close()
    print(json.dumps(report, ensure_ascii=False))
    if errors:
        raise SystemExit(1)
