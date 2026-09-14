"""Reproducible capacity check: 2,000 records and 1,000 synthetic attached PDFs.

This measures native workers, NOT the Harness host or browser. Tiny fixture PDFs
are not a surrogate for scanned/high-resolution real papers. See README limits.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time


def rss_mb():
    raw=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw / (1024 * 1024 if sys.platform == "darwin" else 1024)


def worker():
    from dsh_paper_library.core import dispatch
    job=json.load(sys.stdin)
    begin=time.perf_counter()
    result=None
    for request in job["requests"]:
        result=dispatch(request)
    print(json.dumps({"peak_rss_mib":round(rss_mb(),2),"elapsed_ms":round((time.perf_counter()-begin)*1000,2),
                      "operations":len(job["requests"]),"final_count":result.get("count",result.get("total")) if isinstance(result,dict) else None}))


def benchmark(output, count=2000, pdf_count=1000):
    from dsh_paper_library.core import Library
    import pymupdf
    output.mkdir(parents=True,exist_ok=True)
    root=(output/"library").resolve()
    if (root/"catalog.sqlite3").exists():
        raise ValueError("Benchmark library already exists; choose a new output directory to avoid changing prior evidence")
    library=Library(root)
    source=output/"synthetic.pdf"
    with pymupdf.open() as doc:
        for p in range(4):
            page=doc.new_page()
            page.insert_text((60,80),f"Synthetic capacity document / page {p+1}",fontsize=20)
            for line in range(20):
                page.insert_text((60,130+line*22),"Evidence, measurement and comparison. A synthetic test paragraph.",fontsize=11)
        doc.save(source)
    fixture_start=time.perf_counter()
    ids=[]
    try:
        for start in range(0,count,100):
            data=[{"citekey":f"Capacity{i:04d}","title":f"Urban evidence and spatial comparison {i:04d}",
                "author":[{"family":f"Researcher{i%50}","given":"Sample"}],"type":"article-journal",
                "issued":{"date-parts":[[2000+i%26]]},"tags":["synthetic",f"group{i%20}"]} for i in range(start,min(count,start+100))]
            ids.extend(i["id"] for i in library.import_items(items=data)["items"])
        for id in ids[:pdf_count]:
            library.attach(id,source)
        count_actual=library.db.execute("SELECT count(*) FROM papers").fetchone()[0]
        pdfs_actual=library.db.execute("SELECT count(*) FROM papers WHERE pdf_path IS NOT NULL").fetchone()[0]
    finally:
        library.close()
    cases={
        "idle_catalog_status":[{"action":"status"}],
        "literal_search_100":[{"action":"list","query":f"Capacity{i:04d}","limit":40} for i in range(100)],
        "broad_search_100":[{"action":"list","query":"urban","limit":40,"offset":(i%20)*40} for i in range(100)],
        "render_current_page":[{"action":"page","id":ids[0],"page":1,"scale":1.25}],
        "switch_documents_30":[{"action":"page","id":ids[i%pdf_count],"page":i%4+1,"scale":1.25} for i in range(30)],
    }
    results={}
    for name,requests in cases.items():
        run=subprocess.run([sys.executable,__file__,"--worker"],input=json.dumps({"requests":[{**r,"library":str(root)} for r in requests]}),text=True,capture_output=True,check=True)
        results[name]=json.loads(run.stdout)
    report={"generated_at":time.strftime("%Y-%m-%dT%H:%M:%S%z"),"platform":sys.platform,"python":sys.version.split()[0],
            "records":count_actual,"pdfs":pdfs_actual,"pages_per_pdf":4,"fixture_pdf_bytes":source.stat().st_size,
            "fixture_seconds":round(time.perf_counter()-fixture_start,2),"catalog_bytes":(root/"catalog.sqlite3").stat().st_size,
            "results":results,"limits":["Synthetic small text PDFs; not real-library validation","Workers only; excludes Node host, Harness and browser","No resident worker or embedding model between requests","ru_maxrss is process high-water resident memory; not retained-memory proof"]}
    (output/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report,indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--worker",action="store_true")
    parser.add_argument("--output",type=Path,default=Path("artifacts/capacity"))
    parser.add_argument("--records",type=int,default=2000)
    parser.add_argument("--pdfs",type=int,default=1000)
    args=parser.parse_args()
    if args.worker: worker()
    else:
        if not 1<=args.pdfs<=args.records<=10000: parser.error("Require 1 <= pdfs <= records <= 10000")
        benchmark(args.output,args.records,args.pdfs)
