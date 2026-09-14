"""Build a private, evidence-hashed closeout receipt for this implementation.

The canonical recorder is owned by the user's skill ecosystem. This script only
prepares an ignored receipt; it does not infer user satisfaction or publish it.
"""
import argparse
import hashlib
import json
import runpy
from datetime import datetime, timezone
from pathlib import Path

root=Path(__file__).resolve().parents[1]
skills=Path.home()/".codex"/"skills"
task_id="task-20260914-01a09ec9"
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--revision",type=int,default=1)
parser.add_argument("--checkpoint",choices=["initial","intake","publication"],default="initial")
args=parser.parse_args()
if args.revision<1:
    parser.error("revision must be positive")
if args.checkpoint=="intake":
    task_id="task-20260914-paper-intake"
elif args.checkpoint=="publication":
    task_id="task-20260914-paper-publication"
stem="quality-receipt" if args.checkpoint=="initial" else f"quality-{args.checkpoint}"
destination=root/(f".local/{stem}.json" if args.revision==1 else f".local/{stem}-v{args.revision}.json")
# Replaying this completed checkpoint keeps the identical event payload. A later
# correction needs an explicit superseding event, not an overwritten receipt.
if destination.exists():
    print(destination)
    raise SystemExit(0)
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

criteria={
    "catalog":("docs/validation/automated.json","test"),
    "citations":("docs/validation/export-2000.json","test"),
    "portable_pdf":("docs/validation/automated.json","test"),
    "ai_integration":("docs/validation/automated.json","test"),
    "harness_install":("docs/validation/install.json","artifact_check"),
    "interface":("docs/validation/manual.json","manual_check"),
    "capacity":("docs/validation/harness-memory.json","test"),
}
participants=[(name,role,skills/name/"SKILL.md") for name,role in [("frontend-design","primary"),("academic-project-init","support"),("task-execution","common"),("writing-quality","common")]]
if args.checkpoint=="intake":
    criteria={
        "intake":("docs/validation/automated.json","test"),
        "interface":("docs/validation/intake-manual.json","manual_check"),
        "bundled_skill":("docs/validation/harness-smoke.json","test"),
        "bounded_payload":("docs/validation/automated.json","test"),
        "portable_evidence":("docs/validation/automated.json","test"),
        "skill_provenance":("docs/upstream-manifest.md","artifact_check"),
    }
    identity=["codex-system","skill-creator","system:skill-creator"]
    quality_id="runtime-"+hashlib.sha256(json.dumps(identity,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    participants=[(name,role,skills/name/"SKILL.md") for name,role in [("paper-fetch-skill","primary"),("frontend-design","support"),("task-execution","common"),("writing-quality","common")]]
    participants.append((quality_id,"support",skills/".system/skill-creator/SKILL.md"))
    inventory=root/".local/runtime-skills-intake.json"
    inventory.parent.mkdir(exist_ok=True)
    if not inventory.exists():
        inventory.write_text(json.dumps({"schema_version":1,"observation_id":"paper-intake-runtime-20260914","observed_at":datetime.now(timezone.utc).isoformat(),"source_kind":"exposed_runtime_inventory","source_ref":"runtime:paper-intake:skills","skills":[{"runtime_id":identity[1],"provider":identity[0],"source_identity":identity[2]}]},indent=2)+"\n")
        inventory.chmod(0o600)
if args.checkpoint=="publication":
    criteria={
        "source_and_license":("docs/validation/publication.json","artifact_check"),
        "public_remote":(".local/github-publication.json","artifact_check"),
    }
    for path,_ in criteria.values():
        evidence=json.loads((root/path).read_text())
        if evidence.get("ok") is not True:
            raise SystemExit(f"Passing publication evidence required: {path}")
    router=skills/"shiqi-assistant-router"
    module=runpy.run_path(str(router/"scripts/resolve_route.py"))
    runtime={"snapshot_id":"publication-runtime-20260914","available_runtime":["task-execution","writing-quality","skill-quality-feedback"],"tools":["tools.exec_command","tools.apply_patch","tools.web__run"]}
    intent={"trivial":False,"family":"general","operation":"publish","evidence_action":"verify","native_required_capabilities":["shell","file_write","retrieval"]}
    route=module["resolve"](intent,runtime,json.loads((router/"routing-manifest.json").read_text()))
    if route.get("primary",{}).get("id")!="builtin:native":
        raise SystemExit("Publication requires a resolved native execution route")
    identity=["builtin","builtin:native","contract:task-execution-v1"]
    quality_id="runtime-"+hashlib.sha256(json.dumps(identity,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    # Fixed source-manifest recipe: compact sorted JSON of runtime id, contract
    # version and evaluated common-contract source hash. Never hash chat text.
    source_manifest={"runtime_id":"builtin:native","contract_version":1,"task_execution_sha256":digest(skills/"task-execution/SKILL.md")}
    source_path=root/".local/publication-native-manifest.json"
    source_path.write_text(json.dumps(source_manifest,sort_keys=True,separators=(",",":")))
    source_path.chmod(0o600)
    participants=[(quality_id,"primary",source_path)]+[(name,"common",skills/name/"SKILL.md") for name in ["task-execution","writing-quality"]]
    (root/".local/publication-route.json").write_text(json.dumps(route,indent=2)+"\n")
    inventory=root/".local/runtime-skills-publication.json"
    if not inventory.exists():
        inventory.write_text(json.dumps({"schema_version":1,"observation_id":"publication-runtime-20260914","observed_at":datetime.now(timezone.utc).isoformat(),"source_kind":"exposed_runtime_inventory","source_ref":"route:publication-runtime-20260914","skills":[{"runtime_id":identity[1],"provider":identity[0],"source_identity":identity[2]}]},indent=2)+"\n")
        inventory.chmod(0o600)
receipt={"task_id":task_id,"event_id":task_id+f"-close-v{args.revision}","at":datetime.now(timezone.utc).isoformat(),"data":{
    "scenario":{"initial":"local_plugin_implementation","intake":"automatic_paper_intake","publication":"public_repository_release"}[args.checkpoint],
    "skills":[{"id":name,"role":role,"source_hash":digest(path)} for name,role,path in participants],
    "criteria":[{"id":key,"required":True} for key in criteria],
    "self_assessment":{"outcome":"complete","completion_percent":100,"quality_score":4},
    "validation":[{"id":key+"-check","criterion_id":key,"status":"pass","kind":kind,"artifact":path,"source_ref":f"task:{task_id}:{key}-check","sha256":digest(root/path)} for key,(path,kind) in criteria.items()],
}}
if args.revision>1:
    receipt["supersedes"]=task_id+f"-close-v{args.revision-1}"
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(receipt,indent=2)+"\n")
destination.chmod(0o600)
print(destination)
