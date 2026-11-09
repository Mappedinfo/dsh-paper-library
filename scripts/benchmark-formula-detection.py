"""合成 PDF 新旧结构提取对比；每个版本独立进程，不读取私人文献。"""
import argparse
import importlib.util
import json
from pathlib import Path
import resource
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
BASELINE = '3e79a5d:src/dsh_paper_library/document_elements.py'


def worker(variant, pdf):
    import pymupdf as fitz
    if variant == 'baseline':
        source = subprocess.check_output(['git', 'show', BASELINE], cwd=ROOT, text=True)
        spec = importlib.util.spec_from_loader('dsh_paper_library._formula_baseline', loader=None)
        module = importlib.util.module_from_spec(spec)
        exec(compile(source, BASELINE, 'exec'), module.__dict__)
    else:
        from dsh_paper_library import document_elements as module
    durations, candidates = [], []
    with fitz.open(pdf) as doc:
        for _ in range(3):
            state = False
            for i, page in enumerate(doc):
                start = time.perf_counter()
                section = {}
                if variant == 'baseline':
                    values, _ = module._extract(page, 'synthetic', i + 1)
                else:
                    values, _ = module._extract(page, 'synthetic', i + 1, state, section)
                    state = section['state']
                durations.append((time.perf_counter() - start) * 1000)
                if len(durations) <= len(doc):
                    candidates.extend((i, v['title']) for v in values if v['kind'] == 'formula')
    expected = set(range(21)) | set(range(35,42))
    true = sum(i in expected and title == '公式 (1)' for i, title in candidates)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return dict(variant=variant, pages=42, passes=3, expected_formulas=len(expected),
                true_positives=true, false_positives=len(candidates)-true, false_negatives=len(expected)-true,
                median_ms_per_page=round(statistics.median(durations),3),
                p95_ms_per_page=round(sorted(durations)[int(len(durations)*.95)],3),
                extraction_total_ms=round(sum(durations),2),
                process_peak_rss_mib=round(rss/(1048576 if sys.platform=='darwin' else 1024),2))


def main():
    p=argparse.ArgumentParser();p.add_argument('--worker', choices=['baseline','current']);p.add_argument('--pdf');p.add_argument('--output');args=p.parse_args()
    if args.worker:
        print(json.dumps(worker(args.worker,args.pdf)));return
    import pymupdf as fitz
    with tempfile.TemporaryDirectory(prefix='formula-benchmark-') as root:
        pdf=Path(root)/'synthetic.pdf'
        with fitz.open() as doc:
            for i in range(42):
                page=doc.new_page()
                if i==35:page.insert_text((55,55),'Appendix A. Additional derivations')
                elif i!=20:page.insert_text((55,55),'Synthetic document')
                if i<21 or i>=35:
                    page.insert_text((150,100),'y = a*x + b (1)')
                    page.insert_text((55,140),'where x denotes input and b is the synthetic bias.')
                if i==20:page.insert_text((55,180),'References')
                if 20<=i<35:
                    page.insert_text((55,220),'Smith, J., 2021. Synthetic model x=y (12)')
                    page.insert_text((55,250),'ageNet_ICCV_2021_paper.html?ref=')
                else:page.insert_text((55,250),'https://example.org/synthetic.html?ref=')
                for n in range(12):page.insert_text((55,320+n*18),'This is synthetic prose for bounded text and layout extraction.')
            doc.save(pdf)
        rows=[]
        for variant in ['baseline','current']:
            result=subprocess.check_output([sys.executable,__file__,'--worker',variant,'--pdf',str(pdf)],text=True,cwd=ROOT)
            rows.append(json.loads(result))
    report=dict(baseline=BASELINE,source='42 generated pages; no private PDFs',platform=sys.platform,
                scope='Full per-page structure extraction; 3 warm-process passes; parsing/table checks included, worker startup/SQLite/preview rendering excluded',
                results=rows,limitations=['Synthetic regression corpus, not general scientific accuracy','Peak RSS includes interpreter and PDF engine; not an application memory cap','No OCR/model benchmark; no model installed'])
    text=json.dumps(report,indent=2,ensure_ascii=False)+'\n'
    if args.output:Path(args.output).write_text(text)
    print(text)

if __name__=='__main__':main()
