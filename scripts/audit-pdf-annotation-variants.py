#!/usr/bin/env python3
"""对明确给定的本地清单做只读 PDF 批注版本检查，不扫描目录或访问网络。"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys


def write_private(path, text):
    with path.open('x', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        handle.write(text)


def inspect_one(item, args, mode):
    path = item['references'][0]['local_path']
    command = [sys.executable, '-B', str(Path(__file__).with_name('pdf_variant_fingerprint.py')),
               '--path', path, '--mode', mode, '--dpi', str(args.dpi),
               '--max-pages', str(args.max_pages), '--max-page-pixels', str(args.max_page_pixels)]
    try:
        run = subprocess.run(command, capture_output=True, text=True, timeout=args.timeout)
        value = json.loads(run.stdout)
        if run.returncode or value.get('status') not in ('complete', 'partial'):
            return {'status': 'error', 'error': value.get('error', 'worker-failed')}
        return value
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'error': 'timeout'}
    except (OSError, ValueError):
        return {'status': 'error', 'error': 'worker-output-or-start'}


def batch(items, args, mode, results, output):
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(inspect_one, item, args, mode): item for item in items}
        for number, future in enumerate(as_completed(jobs), 1):
            item = jobs[future]
            value = future.result()
            key = item['physical_id']
            previous = results.get(key)
            if mode == 'render' and value.get('sha256') and previous.get('sha256') != value['sha256']:
                value = {'status': 'error', 'error': 'changed-between-phases'}
            results[key] = {**(previous or {}), **value, 'physical_id': key, 'references': item['references']}
            # 只写散列、批注类型/位置和私有路径，不导出正文或评论原文。
            with output.open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(results[key], ensure_ascii=False) + '\n')
            if number % 50 == 0 or number == len(items):
                print(json.dumps({'phase': mode, 'done': number, 'total': len(items)}), flush=True)


def annotation_counter(record):
    return Counter(a['semantic_hash'] for a in record.get('annotations', []))


def classify(records):
    """底稿渲染必须相同；语义和外观分别比较，不依赖批注总数。"""
    groups = defaultdict(list)
    for record in records:
        if record.get('status') == 'complete' and record.get('base_render_hash'):
            groups[(record['geometry_hash'], record['base_render_hash'])].append(record)
    variants, equal = [], []
    for (geometry, base), files in groups.items():
        if len({f['sha256'] for f in files}) < 2:
            continue
        signatures = {(f['annotation_semantic_hash'], f['annotation_visual_hash']) for f in files}
        group = {'base_render_hash': base, 'geometry_hash': geometry,
                 'files': files, 'pairs': [], 'has_widgets': any(f.get('excluded_annotation_counts', {}).get('Widget', 0) for f in files)}
        if len(signatures) == 1:
            equal.append(group)
            continue
        # 每个不同字节版本留代表作成对比较，其所有实际文件仍在 files 中。
        unique = list({f['sha256']: f for f in files}.values())
        for i, left in enumerate(unique):
            for right in unique[i + 1:]:
                semantic = left['annotation_semantic_hash'] != right['annotation_semantic_hash']
                visual = left['annotation_visual_hash'] != right['annotation_visual_hash']
                if not semantic and not visual:
                    continue
                a, b = annotation_counter(left), annotation_counter(right)
                removed, added = a - b, b - a
                changed_hashes = set(removed) | set(added)
                pages = sorted({a['page'] for f in (left, right) for a in f.get('annotations', []) if a['semantic_hash'] in changed_hashes})
                group['pairs'].append({'left': left['physical_id'], 'right': right['physical_id'],
                    'semantic_different': semantic, 'visual_different': visual,
                    'left_only_annotations': sum(removed.values()), 'right_only_annotations': sum(added.values()),
                    'semantic_difference_pages': pages,
                    'semantic_relation': 'equal' if a == b else 'left-subset' if a <= b else 'right-subset' if b <= a else 'different',
                    'classification': 'semantic-and-visual' if semantic and visual else 'semantic-only' if semantic else 'appearance-only-review'})
        variants.append(group)
    for index, group in enumerate(variants, 1):
        group['group_id'] = f'A{index:04d}'
    return variants, equal


def render_report(report):
    s = report['summary']
    lines = ['# 同页面、不同 PDF 批注的本地检查', '',
        f"完成时间：{report['finished_at']}；状态：{report['status']}。", '',
        f"清单 {s['input_files']} 份；完整检查 {s['inspected_files']} 份；检出标准批注 {s['annotated_files']} 份。",
        f"发现 {s['variant_groups']} 组去批注页面渲染一致、批注存在差异的文件，涉及 {s['variant_files']} 份。", '',
        f"正文提取/页数/几何用于候选筛选；候选全部页面按预乘 RGBA {report['dpi']} dpi 渲染，关闭批注后逐页比较。另比较批注语义、回复关系、手写附件，以及开启批注后的页面。",
        '这证明的是该分辨率下的页面显示一致，不证明 PDF 内部结构或所有隐藏内容相同。不据此合并或删除。', '',
        '只读取清单中的本地文件；未联网、未下载、未修改源文件。正文和评论原文不导出。', '',
        '| 组 | 文件数 | 页数 | 各版本批注数 | 差异页（语义） |', '| --- | ---: | ---: | --- | --- |']
    for g in report['variant_groups']:
        pages = sorted({p for pair in g['pairs'] for p in pair['semantic_difference_pages']})
        lines.append(f"| {g['group_id']} | {len(g['files'])} | {g['files'][0]['page_count']} | {', '.join(str(f['annotation_count']) for f in g['files'])} | {', '.join(map(str, pages)) or '仅外观，见 JSON'} |")
    for g in report['variant_groups']:
        lines.extend(['', f"## {g['group_id']}", ''])
        if g['has_widgets']:
            lines.append('此组含表单控件；外观差异需要复核，不能全部归为阅读批注。')
        for f in g['files'][:8]:
            types = ', '.join(f'{k}: {v}' for k, v in f.get('annotation_counts', {}).items()) or '无标准批注'
            for ref in f['references']:
                path = ref['local_path'].replace('>', '%3E').replace('<', '%3C')
                lines.append(f"- [{ref['source_id']} · {f['annotation_count']} 条](<{path}>)：{types}；批注页 {f.get('annotation_pages', [])}。")
        if len(g['files']) > 8:
            lines.append(f"- 另有 {len(g['files']) - 8} 份，完整路径见 variants.csv。")
        for pair in g['pairs'][:6]:
            lines.append(f"- 比较 {pair['left']} ↔ {pair['right']}：{pair['classification']}；左独有 {pair['left_only_annotations']} 条、右独有 {pair['right_only_annotations']} 条；关系 {pair['semantic_relation']}。")
        if len(g['pairs']) > 6:
            lines.append(f"- 另有 {len(g['pairs']) - 6} 对差异，完整记录见 report.json。")
    lines.extend(['', '## 覆盖与限制', '',
        f"完整候选组 {s['candidate_groups']}；计划渲染 {s['render_files']} 份；跳过渲染 {s['render_skipped']} 份；错误或不完整 {s['incomplete_files']} 份。",
        '1. 相同页数、几何和折叠空白后的文本才进入同组；提取顺序、OCR 层或裁切不同可能漏掉同一论文。',
        '2. 已压平进正文的笔迹属于页面内容，不能可靠地剥离；Zotero 等应用数据库或 sidecar 中尚未写入 PDF 的笔记不在范围。',
        '3. Link、Widget、Popup 单独计数，不作为标准阅读批注；自定义字段、隐藏图层、脚本和文档级附件不作完整等价保证。',
        '4. 批注数量相同不代表内容相同；文件较新或批注更多也不保证覆盖另一版本的全部笔记。',
        '5. 时间、内部对象 ID 和已知保存事务字段不作为阅读批注的差异。',
        '', '[完整结构化报告](report.json) · [分组文件清单](variants.csv) · [全部扫描记录](inspections.jsonl)', ''])
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=90)
    parser.add_argument('--dpi', type=int, default=120)
    parser.add_argument('--max-pages', type=int, default=2000)
    parser.add_argument('--max-page-pixels', type=int, default=16000000)
    parser.add_argument('--max-render-pages', type=int, default=50000)
    parser.add_argument('--max-files', type=int, default=10000)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8 or not all(v > 0 for v in (args.timeout, args.dpi, args.max_pages, args.max_page_pixels, args.max_render_pages, args.max_files)):
        parser.error('invalid bounds')
    inventory = json.loads(args.inventory.read_text())
    items = inventory['files']
    if len(items) > args.max_files:
        parser.error('inventory exceeds max-files')
    target = args.out.resolve()
    if not args.out.is_absolute() or target.exists():
        parser.error('out must be a new absolute private directory')
    for source in inventory['sources']:
        if target.is_relative_to(Path(source['root']).resolve()):
            parser.error('out must be outside every source')
    target.mkdir(mode=0o700)
    output = target/'inspections.jsonl'
    write_private(output, '')
    results = {}
    batch(items, args, 'inspect', results, output)
    candidates = defaultdict(list)
    for item in items:
        f = results[item['physical_id']]
        if f['status'] == 'complete':
            candidates[(f['page_count'], f['geometry_hash'], f['text_normalized_hash'])].append(item)
    candidates = [g for g in candidates.values() if len({results[f['physical_id']]['sha256'] for f in g}) > 1
                  and any(results[f['physical_id']]['annotation_count'] for f in g)]
    render, skipped, budget = [], [], 0
    for group in candidates:
        pages = sum(results[f['physical_id']]['page_count'] for f in group)
        if budget + pages > args.max_render_pages:
            skipped.extend(f['physical_id'] for f in group)
        else:
            render.extend(group)
            budget += pages
    print(json.dumps({'phase': 'candidates', 'groups': len(candidates), 'files': len(render), 'pages': budget, 'skipped': len(skipped)}), flush=True)
    batch(render, args, 'render', results, output)
    for f in results.values():
        if f.get('status') not in ('complete', 'partial'):
            continue
        try:
            for ref in f['references']:
                st = Path(ref['local_path']).lstat()
                if any(getattr(st, 'st_'+key) != f['stat'][key] for key in ('dev', 'ino', 'size', 'mtime_ns', 'ctime_ns')):
                    raise ValueError('changed')
        except (OSError, ValueError):
            f.update(status='error', error='changed-after-inspection')
    variants, equal = classify(results.values())
    incomplete = [f for f in results.values() if f['status'] != 'complete']
    report = {'version': 1, 'finished_at': datetime.now(timezone.utc).isoformat(),
        'status': 'partial' if incomplete or skipped or inventory.get('status') != 'complete' else 'complete',
        'dpi': args.dpi, 'inventory_status': inventory.get('status'),
        'summary': {'input_files': len(items), 'inspected_files': sum(f['status'] == 'complete' for f in results.values()),
            'annotated_files': sum(f.get('annotation_count', 0) > 0 for f in results.values()),
            'candidate_groups': len(candidates), 'render_files': len(render), 'render_skipped': len(skipped),
            'render_pages_planned': budget, 'incomplete_files': len(incomplete),
            'variant_groups': len(variants), 'variant_files': sum(len(g['files']) for g in variants),
            'same_base_and_annotations_groups': len(equal)},
        'variant_groups': variants, 'same_base_and_annotations_groups': equal,
        'render_skipped_ids': skipped, 'incomplete_files': incomplete,
        'files': list(results.values())}
    write_private(target/'report.json', json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    write_private(target/'summary.md', render_report(report))
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(['group_id','physical_id','source_id','local_path','sha256','pages','annotations','annotation_pages','types'])
    for group in variants:
        for f in group['files']:
            for ref in f['references']:
                writer.writerow([group['group_id'],f['physical_id'],ref['source_id'],ref['local_path'],f['sha256'],f['page_count'],f['annotation_count'],json.dumps(f['annotation_pages']),json.dumps(f['annotation_counts'])])
    write_private(target/'variants.csv', buffer.getvalue())
    print(json.dumps({'status': report['status'], **report['summary']}), flush=True)
    return 0 if report['status'] == 'complete' else 2


if __name__ == '__main__':
    sys.exit(main())
