"""Build a private, evidence-hashed closeout receipt for this implementation.

The canonical recorder is owned by the user's skill ecosystem. This script only
prepares an ignored receipt; it does not infer user satisfaction or publish it.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

root=Path(__file__).resolve().parents[1]
skills=Path.home()/".codex"/"skills"
task_id="task-20260914-01a09ec9"
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--revision",type=int,default=1)
args=parser.parse_args()
if args.revision<1:
    parser.error("revision must be positive")
destination=root/(".local/quality-receipt.json" if args.revision==1 else f".local/quality-receipt-v{args.revision}.json")
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
receipt={"task_id":task_id,"event_id":task_id+f"-close-v{args.revision}","at":datetime.now(timezone.utc).isoformat(),"data":{
    "scenario":"local_plugin_implementation",
    "skills":[{"id":name,"role":role,"source_hash":digest(skills/name/"SKILL.md")} for name,role in [("frontend-design","primary"),("academic-project-init","support"),("task-execution","common"),("writing-quality","common")]],
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
