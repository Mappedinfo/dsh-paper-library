#!/usr/bin/env python3
"""从显式元数据审计及现有文献库选择首批真实论文，保存私有运行清单。

只选有 DOI 和完整来源元数据、6–24 页、已在本机驻留的 PDF；不检索、下载或写回。
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import stat


def prepare(library, audit, out, configs, count=12):
    library, audit, out = library.resolve(), audit.resolve(), out.resolve()
    repository = Path(__file__).resolve().parents[1]
    if not 2 <= count <= 100 or not configs or len(configs) > min(4, count):
        raise ValueError('invalid selection bounds')
    if any(not config.is_file() for config in configs):
        raise ValueError('explicit model config is missing')
    if out.exists() or out.is_relative_to(repository) or out.is_relative_to(library):
        raise ValueError('output must be a new private directory outside the library and source repository')
    if audit.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('audit exceeds 64 MiB')
    report = json.loads(audit.read_text())
    rows = report['rows']
    if len(rows) > 10000:
        raise ValueError('audit exceeds 10000 files')
    known = {str(Path(ref['local_path']).resolve()): row for row in rows for ref in row['references']}
    connection = sqlite3.connect((library/'catalog.sqlite3').as_uri()+'?mode=ro', uri=True)
    selected, seen = [], set()
    try:
        for paper_id, raw, pdf_path in connection.execute('SELECT id,metadata,pdf_path FROM papers WHERE pdf_path IS NOT NULL ORDER BY created,id'):
            path = (library/pdf_path).resolve()
            row = known.get(str(path))
            item = json.loads(raw)
            if not row or row.get('test_path') or item.get('archived'):
                continue
            probe, metadata = row['probe'], row.get('best_metadata') or {}
            pages = probe.get('page_count') or 0
            if not 6 <= pages <= 24 or not metadata.get('doi') or not metadata.get('basic_complete'):
                continue
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 512 * 1024 * 1024 or getattr(info, 'st_flags', 0) & 0x40000000:
                continue
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            after = path.stat()
            identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            if identity(info) != identity(after) or digest != probe.get('sha256') or digest in seen:
                continue
            seen.add(digest)
            selected.append({'id': paper_id, 'title': metadata['title'], 'doi': metadata['doi'],
                             'pages': pages, 'source': metadata['origin'], 'path': str(path),
                             'sha256': digest, 'size': info.st_size, 'mtime_ns': str(info.st_mtime_ns),
                             'metadata_reference': metadata})
            if len(selected) == count:
                break
    finally:
        connection.close()
    if len(selected) != count:
        raise ValueError('not enough unchanged, resident, published-paper candidates in explicit inputs')
    out.mkdir(mode=0o700, parents=True)
    def save(name, data):
        with (out/name).open('x') as stream:
            (out/name).chmod(0o600)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    routes = [{'name': f'route-{index+1}', 'config': str(config.resolve()),
               'ids': [paper['id'] for paper in selected[index::len(configs)]]}
              for index, config in enumerate(configs)]
    run_id = 'real-reading-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    save('selection.json', {'created_at': datetime.now(timezone.utc).isoformat(), 'audit': str(audit),
                           'selection_rule': 'existing catalog, known DOI and basic metadata, 6–24 pages, unchanged resident bytes, deduplicated SHA-256',
                           'papers': selected})
    save('plan.json', {'library': str(library), 'request_id': run_id, 'mode': 'full',
                       'notes': True, 'review': False, 'routes': routes})
    print(json.dumps({'papers': len(selected), 'pages': sum(p['pages'] for p in selected),
                      'routes': [{'name': r['name'], 'papers': len(r['ids'])} for r in routes],
                      'plan': str(out/'plan.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--model-config', type=Path, action='append', required=True)
    parser.add_argument('--count', type=int, default=12)
    args = parser.parse_args()
    prepare(args.library, args.audit, args.out, args.model_config, args.count)
