#!/usr/bin/env python3
"""按指定清单检查本地 PDF 元数据覆盖，读取本地 Zotero API，不调用模型或改写资料。"""
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
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def private_json(path, value):
    with path.open('x', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')


def normalized(metadata, origin, *, filename_only=False):
    title = str(metadata.get('title') or '').strip()
    parse = metadata.get('parse') if isinstance(metadata.get('parse'), dict) else {}
    raw_provenance = parse.get('field_sources') if isinstance(parse.get('field_sources'), dict) else {}
    field_provenance = {str(key): value[:100] for key, value in raw_provenance.items()
                        if isinstance(key, str) and isinstance(value, str)}
    if 'author' in metadata:
        author = metadata.get('author')
    elif 'authors' in metadata:
        author = metadata.get('authors')
    else:
        creators = metadata.get('creators') or []
        author = []
        if isinstance(creators, list):
            for creator in creators:
                if isinstance(creator, str):
                    if creator.strip():
                        author.append(creator)
                    continue
                if not isinstance(creator, dict):
                    continue
                role = creator.get('creatorType')
                if role not in (None, '', 'author'):
                    continue
                has_name = any(isinstance(creator.get(key), str) and creator[key].strip()
                               for key in ('name', 'firstName', 'lastName', 'literal', 'family', 'given'))
                if has_name:
                    author.append(creator)
    if isinstance(author, str):
        author = [author] if author.strip() else []
    author = [x for x in author if (isinstance(x, str) and x.strip()) or
              (isinstance(x, dict) and any(isinstance(x.get(k), str) and x[k].strip()
                                            for k in ('name', 'firstName', 'lastName', 'literal', 'family', 'given')))] if isinstance(author, list) else []
    issued = metadata.get('issued') or {}
    parts = issued.get('date-parts', []) if isinstance(issued, dict) else []
    raw_year = parts[0][0] if parts and parts[0] else metadata.get('year') or metadata.get('date')
    year_match = re.search(r'\b(?:18|19|20)\d{2}\b', str(raw_year or ''))
    year = int(year_match.group()) if year_match else None
    doi = str(metadata.get('DOI') or metadata.get('doi') or '').strip()
    doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', doi, flags=re.I).lower()
    venue = str(metadata.get('container-title') or metadata.get('publicationTitle') or metadata.get('booktitle') or metadata.get('venue') or '').strip()
    url = str(metadata.get('URL') or metadata.get('url') or metadata.get('landing_page_url') or metadata.get('dblp_url') or '').strip()
    title_source = field_provenance.get('title')
    title_valid = bool(title) and title_source != 'filename-fallback'
    needs_review = title_source == 'first-page-layout-heuristic'
    fields = {'title': title_valid, 'author': bool(author), 'year': bool(year), 'venue': bool(venue), 'doi': bool(doi), 'url': bool(url)}
    return {'origin': origin, 'title': title, 'author': author, 'year': year, 'doi': doi, 'venue': venue,
            'url': url, 'fields': fields, 'field_provenance': field_provenance, 'needs_review': needs_review,
            'basic_complete': all(fields[k] for k in ('title', 'author', 'year')),
            'filename_only': filename_only}


def fetch_zotero(base, attachment_root, wanted_paths, output):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password:
        raise ValueError('Zotero must use credential-free loopback HTTP')
    opener = urllib.request.build_opener(NoRedirect)
    versions, requests, received = set(), 0, 0

    def get(path, params):
        nonlocal requests, received
        requests += 1
        if requests > 100:
            raise ValueError('local API request bound')
        url = base.rstrip('/') + path + '?' + urllib.parse.urlencode(params)
        with opener.open(url, timeout=15) as response:
            data = response.read(4 * 1024 * 1024 + 1)
            version = response.headers.get('Last-Modified-Version')
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('local API page bound')
        received += len(data)
        if received > 64 * 1024 * 1024 or not version:
            raise ValueError('local API unversioned or too large')
        versions.add(version)
        if len(versions) > 1:
            raise ValueError('local API changed during audit')
        return json.loads(data)

    matches = []
    for start in range(0, 10000, 100):
        page = get('/items', {'itemType': 'attachment', 'limit': 100, 'start': start})
        if not isinstance(page, list):
            raise ValueError('invalid local API page')
        for entry in page:
            item = entry.get('data', {})
            location = item.get('path') or ''
            if location.startswith('attachments:'):
                location = str(attachment_root / location.removeprefix('attachments:'))
            if not os.path.isabs(location):
                continue
            location = str(Path(location).resolve())
            if location in wanted_paths and item.get('parentItem'):
                matches.append({'path': location, 'parent': item['parentItem'], 'attachment': item['key']})
        if len(page) < 100:
            break
    else:
        raise ValueError('local API attachment count bound')
    parents = {}
    keys = sorted({x['parent'] for x in matches})
    for start in range(0, len(keys), 50):
        # /items also includes children of requested parents; top prevents notes/attachments
        # from consuming the page and silently hiding requested bibliography records.
        batch_keys = set(keys[start:start + 50])
        for entry in get('/items/top', {'itemKey': ','.join(sorted(batch_keys)), 'limit': 100}):
            item = entry.get('data', {})
            if item.get('key') in batch_keys:
                parents[item['key']] = normalized(item, 'zotero-live')
        if batch_keys - parents.keys():
            raise ValueError('local API omitted requested parent records')
    private_json(output/'zotero-metadata.json', {'matches': matches, 'parents': parents, 'library_versions': sorted(versions), 'requests': requests})
    return [(m['path'], parents[m['parent']]) for m in matches if m['parent'] in parents], {'matched_paths': len(matches), 'parents': len(parents), 'requests': requests, 'versions': sorted(versions)}


def probe(item):
    command = [sys.executable, '-B', str(Path(__file__).with_name('pdf_metadata_probe.py')),
               '--path', item['references'][0]['local_path']]
    try:
        p = subprocess.run(command, capture_output=True, text=True, timeout=45)
        result = json.loads(p.stdout)
        return result if isinstance(result, dict) else {'status': 'error', 'error': 'invalid-output'}
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'error': 'timeout'}
    except (OSError, ValueError):
        return {'status': 'error', 'error': 'worker-failed'}


def cached_probe(item, cached):
    """Only reuse a caller-supplied local snapshot while file identity is unchanged."""
    path = item['references'][0]['local_path']
    result = cached.get(path)
    if not result or not result.get('sha256') or not result.get('stat'):
        return None
    try:
        import stat
        observed = os.lstat(path)
        expected = result['stat']
        if not stat.S_ISREG(observed.st_mode) or getattr(observed, 'st_flags', 0) & getattr(stat, 'SF_DATALESS', 0x40000000):
            return None
        identity = {'size': observed.st_size, 'mtime_ns': observed.st_mtime_ns, 'ctime_ns': observed.st_ctime_ns,
                    'dev': observed.st_dev, 'ino': observed.st_ino, 'mode': stat.S_IMODE(observed.st_mode)}
        return result if identity == expected else None
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--collection-index', type=Path, action='append', default=[])
    parser.add_argument('--attachment-root', type=Path, required=True)
    parser.add_argument('--zotero-base', default='http://127.0.0.1:23119/api/users/0')
    parser.add_argument('--probe-report', type=Path, help='reuse explicitly supplied unchanged local PDF probes')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    files = inventory['files']
    if len(files) > 10000 or not args.out.is_absolute() or args.out.exists():
        parser.error('invalid output or file count')
    out = args.out.resolve()
    if any(out.is_relative_to(Path(s['root']).resolve()) for s in inventory['sources']):
        parser.error('output must be outside sources')
    out.mkdir(mode=0o700)
    known = defaultdict(list)
    wanted = {ref['local_path'] for f in files for ref in f['references']}
    catalog_counts = Counter()
    connection = sqlite3.connect((args.library/'catalog.sqlite3').resolve().as_uri()+'?mode=ro', uri=True)
    for metadata, path in connection.execute('SELECT metadata,pdf_path FROM papers'):
        metadata = json.loads(metadata)
        filename_only = (metadata.get('parse') or {}).get('status') == 'external-index'
        catalog_counts['records'] += 1
        catalog_counts['filename_only'] += filename_only
        if path:
            actual = str((args.library/path).resolve())
            if actual in wanted:
                known[actual].append(normalized(metadata, 'paper-library', filename_only=filename_only))
    connection.close()
    collection_count = 0
    for path in args.collection_index:
        entries = json.loads(path.read_text())
        if not isinstance(entries, list) or len(entries) > 10000:
            raise ValueError('invalid collection index')
        for entry in entries:
            if entry.get('local_file'):
                actual = str(Path(entry['local_file']).resolve())
                if actual in wanted:
                    known[actual].append(normalized(entry, 'collection-index'))
                    collection_count += 1
    issues = []
    try:
        zotero, zotero_status = fetch_zotero(args.zotero_base, args.attachment_root, wanted, out)
        for path, metadata in zotero:
            known[path].append(metadata)
    except Exception as exc:
        issues.append('zotero:' + type(exc).__name__)
        zotero_status = {'status': 'unavailable'}
    cached = {}
    if args.probe_report:
        previous = json.loads(args.probe_report.read_text())
        cached = {ref['local_path']: row['probe'] for row in previous['rows'] for ref in row['references']}
    rows = []
    reused_probes = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        def inspect(item):
            existing = cached_probe(item, cached)
            return (existing, True) if existing else (probe(item), False)
        jobs = {pool.submit(inspect, item): item for item in files}
        for number, job in enumerate(as_completed(jobs), 1):
            item = jobs[job]
            result, reused = job.result()
            reused_probes += reused
            sources = [m for ref in item['references'] for m in known[ref['local_path']]]
            if result.get('embedded_csl'):
                sources.append(normalized(result['embedded_csl'], 'embedded-csl'))
            row = {'physical_id': item['physical_id'], 'references': item['references'], 'probe': result,
                   'metadata_sources': sources, 'test_path': any('writer-test' in Path(ref['local_path']).parts for ref in item['references'])}
            rows.append(row)
            if number % 100 == 0 or number == len(files):
                print(json.dumps({'phase': 'metadata', 'done': number, 'total': len(files)}), flush=True)
    # 完全相同字节的文件可共享已有目录记录；不同批注的相似底稿不自动合并身份。
    by_hash = defaultdict(list)
    for row in rows:
        digest = row['probe'].get('sha256')
        if digest:
            by_hash[digest].extend(m for m in row['metadata_sources'] if not m['filename_only'])
    for row in rows:
        sources = [m for m in row['metadata_sources'] if not m['filename_only']]
        shared = by_hash.get(row['probe'].get('sha256'), [])
        if not any(m['basic_complete'] for m in sources) and shared:
            sources = sources + [{**m, 'exact_copy_reuse': True} for m in shared if m not in sources]
        row['structured_sources'] = sources
        best = max(sources, key=lambda m: (m['basic_complete'], sum(m['fields'].values())), default=None)
        row['best_metadata'] = best
        row['status'] = 'basic-complete' if best and best['basic_complete'] else 'structured-incomplete' if sources else 'no-structured-record'
        row['missing'] = [k for k in ('title', 'author', 'year', 'venue', 'doi', 'url') if not (best and best['fields'][k])]
    def summary(selected):
        return {'files': len(selected), 'status_counts': dict(Counter(r['status'] for r in selected)),
                'missing_fields': dict(Counter(k for r in selected for k in r['missing'])),
                'pdf_info_title': sum(bool((r['probe'].get('info') or {}).get('title')) for r in selected),
                'pdf_info_author': sum(bool((r['probe'].get('info') or {}).get('author')) for r in selected),
                'embedded_csl': sum(bool(r['probe'].get('embedded_csl')) for r in selected),
                'first_page_doi_candidates': sum(bool(r['probe'].get('doi_candidates')) for r in selected),
                'probe_incomplete': sum(r['probe'].get('status') != 'ok' or bool(r['probe'].get('warnings')) for r in selected)}
    regular = [r for r in rows if not r['test_path']]
    gaps = [r for r in regular if r['status'] != 'basic-complete']
    queue = {}
    for row in gaps:
        identifiers = sorted(set(row['probe'].get('doi_candidates', []) + ([row['best_metadata']['doi']] if row['best_metadata'] and row['best_metadata']['doi'] else [])))
        digest = row['probe'].get('sha256')
        key = digest or row['physical_id']
        entry = queue.setdefault(key, {'sha256': digest, 'references': [], 'doi_candidates': [], 'missing_fields': []})
        entry['references'].extend(row['references'])
        entry['doi_candidates'] = sorted(set(entry['doi_candidates'] + identifiers))
        entry['missing_fields'] = sorted(set(entry['missing_fields'] + row['missing']))
        entry['next_step'] = 'verify-identifier' if entry['doi_candidates'] else 'extract-bounded-metadata'
        entry['state'] = 'not-started'
    summary_regular = summary(regular)
    report = {'generated_at': datetime.now(timezone.utc).isoformat(), 'status': 'partial' if issues else 'complete-with-probe-limitations' if summary_regular['probe_incomplete'] else 'complete',
              'criteria': {'basic': ['title', 'author', 'publication_year'], 'filename_only_is_structured': False,
                           'pdf_creation_date_is_publication_year': False, 'doi_required_for_every_document': False},
              'catalog': dict(catalog_counts), 'collection_matches': collection_count, 'zotero': zotero_status,
              'reused_probes': reused_probes,
              'summary_all': summary(rows), 'summary_non_test': summary_regular, 'test_files': len(rows)-len(regular),
              'enrichment': {'files_with_gaps': len(gaps), 'unique_byte_versions': len(queue),
                             'unique_versions_with_identifier': sum(bool(q['doi_candidates']) for q in queue.values()),
                             'files_with_identifier': sum(bool(r['probe'].get('doi_candidates')) or bool(r['best_metadata'] and r['best_metadata']['doi']) for r in gaps)},
              'by_source': {s['source_id']: summary([r for r in regular if any(x['source_id']==s['source_id'] for x in r['references'])]) for s in inventory['sources']},
              'issues': issues, 'rows': rows}
    private_json(out/'report.json', report)
    private_json(out/'enrichment-queue.json', {'status': 'draft-only', 'model_calls': 0, 'metadata_writes': 0,
                                           'items': sorted(queue.values(), key=lambda q: q['sha256'] or '')})
    buf = io.StringIO(); writer = csv.writer(buf)
    writer.writerow(['source_id', 'path', 'test_path', 'status', 'missing_fields', 'metadata_origin', 'doi_candidates', 'probe_status'])
    for row in rows:
        for ref in row['references']:
            writer.writerow([ref['source_id'], ref['local_path'], row['test_path'], row['status'], ','.join(row['missing']),
                             ','.join(sorted({m['origin'] for m in row['structured_sources']})), ','.join(row['probe'].get('doi_candidates', [])), row['probe'].get('status')])
    with (out/'metadata-gaps.csv').open('x', encoding='utf-8') as handle:
        os.chmod(out/'metadata-gaps.csv', 0o600); handle.write(buf.getvalue())
    counts = summary_regular['status_counts']
    text = f"""# 本地 PDF 元数据覆盖检查

检查时间：{report['generated_at']}。范围为输入清单中的 {len(rows)} 份 PDF，排除路径含 `writer-test` 的 {report['test_files']} 份后，以下统计分母为 {len(regular)} 份文件（含重复副本，不等于独立论文数）。

| 当前匹配结果 | 文件数 |
| --- | ---: |
| 标题、作者、发表年份齐全 | {counts.get('basic-complete', 0)} |
| 已有结构化记录，但基础字段不齐 | {counts.get('structured-incomplete', 0)} |
| 在本次对账的来源中未匹配到结构化记录 | {counts.get('no-structured-record', 0)} |

待补全 {len(gaps)} 份文件，对应 {len(queue)} 个不同字节版本；其中 {report['enrichment']['files_with_identifier']} 份已有 DOI 或首页 DOI 线索，可优先核验身份并检索。队列仅为草稿，尚未联网查询标识符、调用模型或修改资料。

## 判定范围

- 来源为当前 Paper Library 目录、明确指定的采集索引、本地 Zotero 附件与父条目、PDF 内嵌 CSL，以及字节完全相同副本上的上述记录。
- 缺少记录只表示本次未匹配到，不证明以前从未获取；外部数据库、不同字节副本及未知 sidecar 不会被推断为不存在。
- 基础齐全只检查字段与来源，不证明出版信息全部正确。编辑与译者不充当作者，文件名占位标题与 PDF 创建日期不满足标题／发表年份要求。
- DOI、期刊／会议、URL 单独计数，缺少 DOI 不一定是错误；预印本、书籍等需按文献类型补齐。
- PDF Info 的标题／作者与首页 DOI 仅作线索，不自动转为已核验字段。首页只提取文字，不做 OCR，也不保存正文。
- {summary_regular['probe_incomplete']} 份探针含警告或未完成项；详情见 JSON，不能据此认定文件损坏或没有元数据。
- Zotero 状态：{json.dumps(zotero_status, ensure_ascii=False)}。额外问题：{json.dumps(issues, ensure_ascii=False)}。

明细见 `metadata-gaps.csv`，按完全相同文件合并的待处理草稿见 `enrichment-queue.json`，完整证据见 `report.json`。报告含私人路径和文献信息，保留在本地私有目录。
"""
    with (out/'summary.md').open('x', encoding='utf-8') as handle:
        os.chmod(out/'summary.md', 0o600); handle.write(text)
    print(json.dumps({k:report[k] for k in ('catalog','collection_matches','zotero','summary_all','summary_non_test','test_files','issues')}, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
