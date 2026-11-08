"""按页、按需索引 PDF 图表、公式和算法；结果是可核对的版面候选。"""
from __future__ import annotations

import base64
from contextlib import redirect_stdout
import hashlib
import json
import math
import re
import shutil
import sys
import zlib

import pymupdf as fitz

from .pdf_analysis_identity import content_version, observed_file
from . import pdf_preprocessing

SCHEMA = 'document-elements-v1'
KINDS = {'figure', 'table', 'formula', 'algorithm'}
MAX_PAGE_ELEMENTS = 240
MAX_TEXT = 20000
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_LIBRARY_INDEX_BYTES = 128 * 1024 * 1024
MAX_PAGE_BYTES = 2 * 1024 * 1024
MIN_DISK_FREE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_PAGE_STREAM_BYTES = 8 * 1024 * 1024
MAX_PAGE_DECODED_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 64_000_000
CAPTION = re.compile(r'^\s*(Figure|Fig\.?|Table|Algorithm|图|表|算法)\s*([A-Z]?\d+(?:\.\d+)*)(?:[.：:\s]|$)', re.I)
EQUATION_NUMBER = re.compile(r'\([A-Z]?\d+(?:\.\d+)*\)\s*$')
MATH = re.compile(r'[=∑∏∫√≈≠≤≥∈∂∇⊂⊆→]|[α-ωΑ-Ω]')
CODE = re.compile(r'^\s*(?://|\d+\s+|for\b|while\b|if\b|else\b|end\b|return\b|input\b|output\b)', re.I)


class ElementBudgetError(ValueError):
    """可恢复的资源暂停，不把已有扫描页回滚或删除。"""


def _disk_free(library):
    return shutil.disk_usage(library.root).free


def _ensure_disk(library, reserve=0):
    if _disk_free(library) < MIN_DISK_FREE_BYTES + reserve:
        raise ElementBudgetError('磁盘空间不足：保留 256 MiB 安全余量后无法继续；已扫描内容保留。')


def _index_bytes(library, paper_id=None, page=None):
    clause = ' WHERE paper_id=?' if paper_id else ''
    params = [paper_id] if paper_id else []
    if page is not None:
        clause += ' AND page=?'
        params.append(page)
    # 只聚合每页计费数字，不在每次自动批次重新读全库索引正文。
    return library.db.execute('SELECT coalesce(sum(coalesce(index_bytes,?)),0) FROM document_element_pages' + clause,
                              [MAX_PAGE_BYTES, *params]).fetchone()[0]


def _initialize_usage(library, paper_id):
    # 旧schema按需迁移当前篇最多6页，其他旧页按页预算保守预留。
    rows = library.db.execute('SELECT page,version,warnings FROM document_element_pages WHERE paper_id=? AND index_bytes IS NULL LIMIT 6', (paper_id,)).fetchall()
    for row in rows:
        size = library.db.execute('''SELECT coalesce(sum(length(CAST(value AS BLOB)) +
            length(CAST(search_text AS BLOB)) + 512),0) FROM document_elements
            WHERE paper_id=? AND version=? AND page=?''', (paper_id, row['version'], row['page'])).fetchone()[0]
        size += len(row['warnings'].encode()) + 256
        library.db.execute('UPDATE document_element_pages SET index_bytes=? WHERE paper_id=? AND version=? AND page=?',
                           (size, paper_id, row['version'], row['page']))


def _usage(library, paper_id):
    return {'index_bytes': _index_bytes(library, paper_id), 'index_limit_bytes': MAX_INDEX_BYTES,
            'library_index_bytes': _index_bytes(library), 'library_index_limit_bytes': MAX_LIBRARY_INDEX_BYTES,
            'page_limit_bytes': MAX_PAGE_BYTES, 'available_disk_bytes': _disk_free(library),
            'estimated_legacy_pages': library.db.execute('SELECT count(*) FROM document_element_pages WHERE index_bytes IS NULL').fetchone()[0],
            'accounting': 'derived-payload-with-row-overhead', 'memory_hard_limit': False}


def _check_write_budget(library, paper_id, added, page_total):
    if page_total > MAX_PAGE_BYTES:
        raise ElementBudgetError('本页结构结果超过 2 MiB，已暂停；此前已扫描页保留。')
    usage = _usage(library, paper_id)
    if usage['index_bytes'] + added > MAX_INDEX_BYTES:
        raise ElementBudgetError('本篇结构索引达到 16 MiB 预算，已暂停；已有结果仍可阅读。')
    if usage['library_index_bytes'] + added > MAX_LIBRARY_INDEX_BYTES:
        raise ElementBudgetError('全库结构索引达到 128 MiB 预算，已暂停；可明确清除不再需要的派生索引。')
    _ensure_disk(library, max(0, added) * 4)


def _encoded(value):
    text = json.dumps(value, ensure_ascii=False)
    search = '\n'.join(str(value.get(key, '')) for key in ('title', 'text', 'context', 'caption')).casefold()
    return text, search, len(text.encode()) + len(search.encode()) + 512


def _preflight_page(doc, number):
    """在解释内容流/解码图像前检查可观察资源；不宣称是进程 RSS 硬上限。"""
    page = doc[number - 1]
    if max(page.rect.width, page.rect.height) > 20000 or page.rect.get_area() > 200_000_000:
        raise ElementBudgetError(f'第 {number} 页尺寸超过安全预算，暂停自动扫描。')
    contents, forms, images = page.get_contents(), page.get_xobjects(), page.get_images(full=True)
    if len(contents) + len(forms) > 2048 or len(images) > 1000:
        raise ElementBudgetError(f'第 {number} 页对象过多，暂停自动扫描。')
    pixels = sum(max(0, image[2]) * max(0, image[3]) for image in images)
    if pixels > 2 * MAX_IMAGE_PIXELS or any(image[2] * image[3] > MAX_IMAGE_PIXELS for image in images):
        raise ElementBudgetError(f'第 {number} 页图像像素超过预算，暂停以避免大图解码占满内存。')
    compressed = decoded = 0
    for xref in set(contents + [form[0] for form in forms]):
        kind, length = doc.xref_get_key(xref, 'Length')
        if kind != 'int':
            raise ElementBudgetError(f'第 {number} 页内容流大小无法安全确认，暂停自动扫描。')
        compressed += int(length)
        if compressed > MAX_PAGE_STREAM_BYTES:
            raise ElementBudgetError(f'第 {number} 页内容流超过 8 MiB，暂停自动扫描。')
        _, filter_name = doc.xref_get_key(xref, 'Filter')
        if filter_name in ('/FlateDecode', '[/FlateDecode]'):
            raw = doc.xref_stream_raw(xref)
            try:
                inflater = zlib.decompressobj()
                value = inflater.decompress(raw, MAX_PAGE_DECODED_BYTES - decoded + 1)
            except zlib.error as exc:
                raise ElementBudgetError(f'第 {number} 页内容流无法安全预检，暂停自动扫描。') from exc
            decoded += len(value)
            if decoded > MAX_PAGE_DECODED_BYTES or not inflater.eof:
                raise ElementBudgetError(f'第 {number} 页解压内容超过 16 MiB，暂停自动扫描。')
        elif filter_name in ('null', ''):
            decoded += int(length)
        else:
            raise ElementBudgetError(f'第 {number} 页内容流压缩方式无法有界预检，暂停自动扫描。')
        if decoded > MAX_PAGE_DECODED_BYTES:
            raise ElementBudgetError(f'第 {number} 页内容流超过解压预算，暂停自动扫描。')


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f'{name} must be an integer between {low} and {high}')
    return value


def _schema(library):
    library.db.execute('''CREATE TABLE IF NOT EXISTS document_element_pages (
      paper_id TEXT NOT NULL, version TEXT NOT NULL, page INTEGER NOT NULL,
      warnings TEXT NOT NULL, index_bytes INTEGER, PRIMARY KEY(paper_id,version,page))''')
    if 'index_bytes' not in {row['name'] for row in library.db.execute('PRAGMA table_info(document_element_pages)')}:
        library.db.execute('ALTER TABLE document_element_pages ADD COLUMN index_bytes INTEGER')
    library.db.execute('''CREATE TABLE IF NOT EXISTS document_elements (
      paper_id TEXT NOT NULL, version TEXT NOT NULL, id TEXT NOT NULL,
      page INTEGER NOT NULL, kind TEXT NOT NULL, search_text TEXT NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY(paper_id,version,id))''')
    library.db.execute('CREATE INDEX IF NOT EXISTS document_elements_page ON document_elements(paper_id,version,page,kind)')


def _version(library, paper_id, path, doc):
    if doc.page_count > 2000:
        raise ValueError('Document element indexing accepts at most 2000 pages')
    observed = observed_file(path)
    # 低磁盘时仍允许读取现有索引：命中身份缓存无需临时副本。
    key = pdf_preprocessing.digest(json.dumps({'paper_id': paper_id, 'kind': 'pdf-content-v1'}, sort_keys=True))
    directory = library.root / 'derived' / 'pdf-analysis' / key
    if any(part.is_symlink() for part in (directory, directory.parent, directory.parent.parent)):
        raise ValueError('Document element cache must not use symlinks')
    cached = pdf_preprocessing.cached_json(directory / 'identity.json', 8192)
    if isinstance(cached, dict) and cached.get('observed') == observed:
        value = cached.get('version', {})
        if value.get('page_count') == doc.page_count and re.fullmatch('[a-f0-9]{64}', str(value.get('sha256', ''))):
            return SCHEMA + ':' + value['sha256']
    if observed['bytes'] > MAX_SOURCE_BYTES or doc.xref_length() > 200000:
        raise ElementBudgetError('PDF 体积或对象数超过自动结构索引预算；已扫描内容保留。')
    _ensure_disk(library, observed['bytes'] * 2 + MAX_PAGE_BYTES)
    return SCHEMA + ':' + content_version(library, paper_id, path, doc, observed)['sha256']


def _box(rect, page):
    rect = fitz.Rect(rect) * page.rotation_matrix
    rect &= page.rect
    return [round(v, 3) for v in rect]


def _union(rects):
    result = fitz.Rect(rects[0])
    for rect in rects[1:]:
        result |= fitz.Rect(rect)
    return result


def _lines(page):
    # TEXTFLAGS_DICT 默认含图像字节；这里只提文字，图像另用几何接口。
    raw = page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    lines, text_bytes = [], 0
    for block_index, block in enumerate(raw['blocks']):
        for line in block.get('lines', []):
            text = ''.join(span['text'] for span in line['spans']).strip()
            if text:
                text_bytes += len(text.encode())
                if len(lines) >= 5000 or text_bytes > MAX_PAGE_BYTES:
                    raise ElementBudgetError('单页文字超过 5000 行或 2 MiB，暂停结构扫描以限制内存和计算量。')
                lines.append({'text': text, 'rect': fitz.Rect(line['bbox']), 'block': block_index,
                              'baseline': sum(s.get('origin', (0, line['bbox'][3]))[1] for s in line['spans']) / max(1, len(line['spans'])),
                              'math_font': any(re.search('math|symbol|cmsy|cmmi', s.get('font', ''), re.I) for s in line['spans'])})
    return sorted(lines, key=lambda line: (round(line['rect'].y0 / 3), line['rect'].x0))


def _nearby(lines, rect, distance=95):
    selected, remaining = [], 4000
    for line in lines:
        if (line['rect'].y0 >= rect.y0 - 12 and line['rect'].y0 <= rect.y1 + distance
                and line['rect'].x1 > rect.x0 and line['rect'].x0 < rect.x1):
            selected.append(line['text'][:remaining])
            remaining -= len(selected[-1]) + 1
            if remaining <= 0:
                break
    return '\n'.join(selected)


def _extract(page, version, page_number=None):
    """所有检测使用未旋转坐标；输出统一转换到阅读器显示坐标。"""
    lines = _lines(page)
    page_number = page_number or page.number + 1
    warnings, elements, result_bytes = [], [], 0
    if len(lines) > 12000:
        warnings.append('本页文字超过 12000 行预算，结构候选不完整。')
        lines = lines[:12000]
    if not lines:
        warnings.append('本页没有可提取文字；扫描页公式、图题与定义需要 OCR，本次未识别。')
    bounds = page.rect * page.derotation_matrix

    def add(kind, rect, title, text='', caption='', context='', method='layout', confidence='candidate', extra=None):
        nonlocal result_bytes
        rect = fitz.Rect(rect) & bounds
        if rect.is_empty or rect.width < 2 or rect.height < 2:
            return
        if len(elements) >= MAX_PAGE_ELEMENTS:
            if '本页候选达到 240 项预算，仍有未展示内容。' not in warnings:
                warnings.append('本页候选达到 240 项预算，仍有未展示内容。')
            return
        if any(e['kind'] == kind and fitz.Rect(e['rect']).intersect(fitz.Rect(_box(rect, page))).get_area() > .85 * min(fitz.Rect(e['rect']).get_area(), rect.get_area()) for e in elements):
            return
        value = {'kind': kind, 'page': page_number, 'rect': _box(rect, page),
                 'title': title[:300], 'text': text[:MAX_TEXT], 'caption': caption[:2000],
                 'context': context[:4000], 'method': method, 'confidence': confidence,
                 'warnings': [], **(extra or {})}
        if kind == 'figure' and re.search(r'flow\s*chart|workflow|roadmap|流程|路线图', caption, re.I):
            value['subtype'] = 'flowchart'
            value['subtype_method'] = 'caption-keywords'
        if len(text) > MAX_TEXT:
            value['warnings'].append('原文超过单项 20000 字符，已截断。')
            value['truncated'] = True
        token = json.dumps([version, kind, value['page'], value['rect'], title], ensure_ascii=False)
        value['id'] = hashlib.sha256(token.encode()).hexdigest()[:32]
        result_bytes += _encoded(value)[2]
        if result_bytes > MAX_PAGE_BYTES:
            raise ElementBudgetError('单页结构结果超过 2 MiB，已暂停；此前已扫描页保留。')
        elements.append(value)

    # 图片直接从 PDF 图像放置几何提取，不解码整页图片。
    images = []
    image_info = page.get_image_info()
    if len(image_info) > 1000:
        raise ElementBudgetError('本页图片超过 1000 项预算，暂停自动扫描。')
    for image in image_info[:1000]:
        rect = fitz.Rect(image['bbox']) & bounds
        if rect.width >= 24 and rect.height >= 24:
            images.append(rect)
    # 图题也可以定位矢量绘制的流程图。先合并相邻矢量路径，保持单页预算。
    drawings = page.get_drawings()
    if len(drawings) > 6000:
        raise ElementBudgetError('本页矢量路径超过 6000，暂停自动扫描。')
    clusters = []
    for drawing in drawings[:6000]:
        rect = fitz.Rect(drawing['rect']) & bounds
        if rect.width < 1 or rect.height < 1:
            continue
        hits = [i for i, old in enumerate(clusters) if (old + (-8, -8, 8, 8)).intersects(rect)]
        for hit in reversed(hits):
            rect |= clusters.pop(hit)
        if len(clusters) < 500:
            clusters.append(rect)
        elif '矢量图分组超过 500，图形候选可能不完整。' not in warnings:
            warnings.append('矢量图分组超过 500，图形候选可能不完整。')
    graphics = images + [rect for rect in clusters if rect.width > 30 and rect.height > 24]
    caption_ranges = []
    algorithm_ranges = []
    for index, line in enumerate(lines):
        match = CAPTION.match(line['text'])
        if not match:
            continue
        prefix = match.group(1).lower()
        kind = 'algorithm' if prefix in {'algorithm', '算法'} else 'table' if prefix in {'table', '表'} else 'figure'
        caption_lines = [line]
        # 同一个文字块内连续折行保留原图题，不跨入下一段。
        for following in lines[index + 1:index + 8]:
            if (following['block'] != line['block'] or CAPTION.match(following['text'])
                    or (kind == 'algorithm' and CODE.match(following['text']))):
                break
            caption_lines.append(following)
        caption = '\n'.join(item['text'] for item in caption_lines)[:2000]
        cap_rect = _union([item['rect'] for item in caption_lines])
        caption_ranges.append(cap_rect)
        if kind == 'algorithm':
            body, last = [], cap_rect
            for following in lines[index + 1:]:
                if following in caption_lines:
                    continue
                if CAPTION.match(following['text']):
                    break
                if following['rect'].y0 < cap_rect.y1 - 2:
                    continue
                if body and following['rect'].y0 - last.y1 > 22 and not CODE.match(following['text']):
                    break
                if body and not CODE.match(following['text']) and re.match(r'^(?:\d+\.\d+\.?\s|[A-Z][a-z]+\s)', following['text']) and following['rect'].y0 - last.y1 > 9:
                    break
                body.append(following)
                last = following['rect']
                if len(body) >= 160:
                    break
            rect = _union([cap_rect] + [item['rect'] for item in body])
            text = '\n'.join([caption] + [item['text'] for item in body])
            algorithm_ranges.append(rect)
            extra = {'source_segments': [{'page': page_number, 'rect': _box(rect, page), 'text': text[:MAX_TEXT]}],
                     'warnings': ['算法边界按版面检测；若跨页，请核对相邻页。']}
            add(kind, rect, line['text'], text, caption, method='algorithm-caption-and-lines', extra=extra)
            continue
        # 图题上方最近的图形；表题通常位于上方，同时考察下方。
        candidates = [g for g in graphics if g.x1 > cap_rect.x0 - 30 and g.x0 < cap_rect.x1 + 30
                      and ((g.y1 <= cap_rect.y0 + 5 and cap_rect.y0 - g.y1 < 90)
                           or (kind == 'table' and g.y0 >= cap_rect.y1 - 5 and g.y0 - cap_rect.y1 < 60))]
        if candidates:
            best = min(candidates, key=lambda g: min(abs(g.y1 - cap_rect.y0), abs(g.y0 - cap_rect.y1)))
            related = [g for g in candidates if (best + (-12, -12, 12, 12)).intersects(g)]
            rect = _union([cap_rect] + related)
            method = 'caption-and-graphic-geometry'
        else:
            # 无可识别图形时只标图题，不猜测整页大矩形。
            rect, method = cap_rect, 'caption-only'
        add(kind, rect, line['text'], _nearby(lines, rect, 0), caption,
            _nearby(lines, cap_rect), method=method,
            extra={'warnings': ['仅定位图题，图表区域尚未可靠识别。'] if method == 'caption-only' else []})
    for index, rect in enumerate(images):
        add('figure', rect, f'图片 · 第 {page_number} 页 · {index + 1}',
            context=_nearby(lines, rect, 40), method='embedded-image', confidence='geometry')
    # 成熟表格检测器识别无图题线框表格，失败不阻断其他结构。
    if len(drawings) <= 1500:
        try:
            # MuPDF 首次调用提示不能污染 worker 的 stdout JSON 协议。
            with redirect_stdout(sys.stderr):
                finder = page.find_tables()
            for table in finder.tables[:30]:
                rows = table.extract()[:150]
                text = '\n'.join('\t'.join(str(cell or '')[:300] for cell in row[:30]) for row in rows)
                table_rect = fitz.Rect(table.bbox)
                title, caption = f'表格 · 第 {page_number} 页', ''
                # 检测器的几何和结构化行优先，不因先扫描到图题而丢弃。
                for old in list(elements):
                    if old['kind'] != 'table':
                        continue
                    old_rect = fitz.Rect(old['rect']) * page.derotation_matrix
                    if (old_rect.intersects(table_rect) or
                            (old['caption'] and 0 <= table_rect.y0 - old_rect.y1 < 55
                             and old_rect.x1 > table_rect.x0 and old_rect.x0 < table_rect.x1)):
                        title, caption = old['title'], old['caption']
                        table_rect |= old_rect
                        elements.remove(old)
                add('table', table_rect, title, text, caption,
                    context=_nearby(lines, fitz.Rect(table.bbox), 40), method='pymupdf-table', confidence='geometry',
                    extra={'rows': [[str(cell or '')[:300] for cell in row[:30]] for row in rows[:50]],
                           'rows_truncated': len(table.rows) > 50})
        except ElementBudgetError:
            raise
        except Exception as exc:
            warnings.append(f'本页表格检测未完成：{type(exc).__name__}')
    else:
        warnings.append('本页路径较多，跳过线框表格检测；仍保留表题候选。')
    formula_used = set()
    baselines = {}
    for index, item in enumerate(lines):
        baselines.setdefault(round(item['baseline'] / 3), []).append((index, item))
    for index, line in enumerate(lines):
        if index in formula_used:
            continue
        text, rect = line['text'], line['rect']
        if any(r.intersects(rect) for r in caption_ranges + algorithm_ranges):
            continue
        if not (MATH.search(text) or line['math_font'] or EQUATION_NUMBER.fullmatch(text)):
            continue
        # 排版引擎可能把公式主体、上下标和编号输出成多个文字块。
        # 仅合并同一基线的短片段，避免把跨栏正文拼成伪公式。
        key = round(line['baseline'] / 3)
        same_line = [pair for nearby in (key - 1, key, key + 1) for pair in baselines.get(nearby, [])]
        fragments = [(j, item) for j, item in same_line
                     if abs(item['baseline'] - line['baseline']) < 3
                     and len(item['text']) < 200
                     and not any(r.intersects(item['rect']) for r in caption_ranges + algorithm_ranges)]
        if fragments:
            fragments.sort(key=lambda pair: pair[1]['rect'].x0)
            text = ' '.join(item['text'] for _, item in fragments)
            rect = _union([item['rect'] for _, item in fragments])
        math_font = any(item['math_font'] for _, item in fragments)
        # 带编号数学行，或含数学字体/算符的短独立行；正文长句不作为公式。
        if (len(text) < 350 and MATH.search(text)
                and (EQUATION_NUMBER.search(text) or math_font or (len(text) < 100 and '=' in text))):
            number = EQUATION_NUMBER.search(text)
            label = '公式 ' + number.group(0) if number else f'公式候选 · 第 {page_number} 页'
            add('formula', rect + (-3, -3, 3, 3), label, text, context=_nearby(lines, rect),
                method='equation-text-and-font', extra={'definition': _nearby(lines, rect),
                    'warnings': ['定义为相邻原文上下文，符号含义未自动推断。']})
            formula_used.update(j for j, _ in fragments)
    warnings.append('版面规则提取候选；无编号公式、复杂跨栏图表与跨页算法可能遗漏，请核对原页。')
    return elements, warnings


def _coverage(library, paper_id, version, count):
    rows = library.db.execute('SELECT page FROM document_element_pages WHERE paper_id=? AND version=? ORDER BY page', (paper_id, version)).fetchall()
    pages = [row['page'] for row in rows]
    scanned = set(pages)
    return {'page_count': count, 'scanned_pages': pages, 'complete': len(pages) == count,
            'next_page': next((n for n in range(1, count + 1) if n not in scanned), None)}


def _continue_algorithm(doc, value, inspected):
    """只在页末/未闭合控制块出现连续印刷行号时，补取下一页原文。"""
    from .algorithm_flow import parse_algorithm
    page = doc[value['page'] - 1]
    native = fitz.Rect(value['rect']) * page.derotation_matrix
    bounds = page.rect * page.derotation_matrix
    parsed = parse_algorithm(value['text'])
    if (native.y1 < bounds.y1 - 100 and parsed['complete']) or value['page'] >= doc.page_count:
        return []
    number = value['page'] + 1
    if number not in inspected and len(inspected) >= 6:
        value['warnings'].append('本次页面预算已用完，算法可能跨页；请核对下一页。')
        value['extraction_incomplete'] = True
        return []
    inspected.add(number)
    _preflight_page(doc, number)
    printed = [int(m.group(1)) for text in value['text'].splitlines()
               if (m := re.match(r'^\s*(\d+)\s+', text))]
    next_page = doc[number - 1]
    with fitz.open() as base:
        base.insert_pdf(doc, from_page=number - 1, to_page=number - 1,
                        links=False, annots=False, widgets=False)
        following = _lines(base[0])[:12000]
    start = None
    for index, line in enumerate(following[:100]):
        if line['rect'].y0 > (next_page.rect * next_page.derotation_matrix).height * .35:
            break
        match = re.match(r'^\s*(\d+)\s+', line['text'])
        continued = CAPTION.match(line['text']) and re.search('continued|续', line['text'], re.I)
        if continued or (match and printed and int(match.group(1)) == printed[-1] + 1):
            start = index
            break
    if start is None:
        value['warnings'].append('已核对相邻页，未找到可可靠拼接的算法续行。')
        return [number]
    body = []
    for line in following[start:]:
        if body and CAPTION.match(line['text']):
            break
        if body and not CODE.match(line['text']) and line['rect'].y0 - body[-1]['rect'].y1 > 12:
            break
        body.append(line)
        if len(body) >= 160:
            value['extraction_incomplete'] = True
            break
    text = '\n'.join(line['text'] for line in body)
    rect = _union([line['rect'] for line in body])
    value['source_segments'].append({'page': number, 'rect': _box(rect, next_page), 'text': text[:MAX_TEXT]})
    combined = value['text'] + '\n' + text
    value['text'] = combined[:MAX_TEXT]
    if len(combined) > MAX_TEXT:
        value['truncated'] = True
        value['warnings'].append('跨页算法原文超过 20000 字符，已截断。')
    value['warnings'].append('已依据连续行号/续页标记拼接下一页，保留两页原始位置。')
    return [number]


def _status(library, paper_id, version, count):
    coverage = _coverage(library, paper_id, version, count)
    previous = library.db.execute('SELECT 1 FROM document_element_pages WHERE paper_id=? AND version<>? LIMIT 1', (paper_id, version)).fetchone()
    return {'source_version': version, 'coverage': coverage, 'stale': bool(previous), 'usage': _usage(library, paper_id),
            'warnings': ([] if coverage['complete'] else ['全文尚未扫描完；检索仅覆盖已扫描页。']) +
                        (['PDF 正文已变化，旧索引不可用于定位；请重新扫描。'] if previous else [])}


def _scan(library, paper_id, doc, version, request):
    count = doc.page_count
    limit = _integer(request.get('limit', 1), 'limit', 1, 6)
    start = request.get('start_page')
    if start is None:
        start = _coverage(library, paper_id, version, count)['next_page']
    if start is None:
        return {**_status(library, paper_id, version, count), 'elements': [], 'scanned_batch': [], 'cached_pages': [], 'paused': False}
    start = _integer(start, 'start_page', 1, count)
    # 只清过期的派生结构记录；不触及论文、批注或其他私有内容。
    library.db.execute('DELETE FROM document_elements WHERE paper_id=? AND version<>?', (paper_id, version))
    library.db.execute('DELETE FROM document_element_pages WHERE paper_id=? AND version<>?', (paper_id, version))
    output, scanned, cached, lookahead = [], [], [], []
    planned = list(range(start, min(start + limit, count + 1)))
    inspected, budget_reason = set(planned), None
    for number in planned:
        try:
            exists = library.db.execute('SELECT 1 FROM document_element_pages WHERE paper_id=? AND version=? AND page=?', (paper_id, version, number)).fetchone()
            if exists:
                cached.append(number)
                continue
            _ensure_disk(library, MAX_PAGE_BYTES)
            _preflight_page(doc, number)
            pending, batch_lookahead = [], []
            previous = library.db.execute("SELECT value FROM document_elements WHERE paper_id=? AND version=? AND page=? AND kind='algorithm'", (paper_id, version, number - 1)).fetchall()
            for row in previous:
                candidate = json.loads(row['value'])
                if (candidate.get('extraction_incomplete') and len(candidate.get('source_segments', [])) == 1
                        and any('本次页面预算' in warning for warning in candidate['warnings'])):
                    before = _encoded(candidate)[2]
                    candidate.pop('extraction_incomplete', None)
                    candidate['warnings'] = [warning for warning in candidate['warnings'] if '本次页面预算' not in warning]
                    batch_lookahead.extend(_continue_algorithm(doc, candidate, inspected))
                    text, search, size = _encoded(candidate)
                    pending.append((candidate, text, search, size - before))
            with fitz.open() as base:
                base.insert_pdf(doc, from_page=number - 1, to_page=number - 1, links=False, annots=False, widgets=False)
                values, warnings = _extract(base[0], version, number)
            rows, added = [], 0
            for value in values:
                if value['kind'] == 'algorithm':
                    batch_lookahead.extend(_continue_algorithm(doc, value, inspected))
                text, search, size = _encoded(value)
                rows.append((paper_id, version, value['id'], number, value['kind'], search, text))
                added += size
            warning_text = json.dumps(warnings, ensure_ascii=False)
            added += len(warning_text.encode()) + 256
            # 在写 SQLite / WAL 前核对本页、本篇、全库和磁盘预算。
            _check_write_budget(library, paper_id, added + sum(item[3] for item in pending), added)
            for candidate, _, _, delta in pending:
                if _index_bytes(library, paper_id, candidate['page']) + delta > MAX_PAGE_BYTES:
                    raise ElementBudgetError('跨页算法使前页索引超过结果预算，已暂停；旧候选保留。')
            for candidate, text, search, _ in pending:
                library.db.execute('UPDATE document_elements SET value=?,search_text=? WHERE paper_id=? AND version=? AND id=?', (text, search, paper_id, version, candidate['id']))
            for candidate, _, _, delta in pending:
                library.db.execute('UPDATE document_element_pages SET index_bytes=index_bytes+? WHERE paper_id=? AND version=? AND page=?',
                                   (delta, paper_id, version, candidate['page']))
            library.db.executemany('INSERT OR REPLACE INTO document_elements VALUES(?,?,?,?,?,?,?)', rows)
            library.db.execute('INSERT INTO document_element_pages(paper_id,version,page,warnings,index_bytes) VALUES(?,?,?,?,?)', (paper_id, version, number, warning_text, added))
            scanned.append(number)
            lookahead.extend(batch_lookahead)
            output.extend([item[0] for item in pending] + values)
        except ElementBudgetError as exc:
            budget_reason = str(exc)
            break
        finally:
            fitz.TOOLS.store_shrink(100)
    status = _status(library, paper_id, version, count)
    status['warnings'].append('版面候选需核对原页；扫描完毕不代表所有结构均已识别。')
    if budget_reason:
        status['warnings'].append(budget_reason)
    return {**status, 'elements': output[:40], 'batch_element_count': len(output), 'scanned_batch': scanned,
            'cached_pages': cached, 'lookahead_pages': sorted(set(lookahead)),
            'paused': bool(budget_reason), 'budget_reason': budget_reason}


def _element(library, paper_id, version, element_id):
    if not isinstance(element_id, str) or not re.fullmatch('[a-f0-9]{32}', element_id):
        raise ValueError('Invalid document element_id')
    row = library.db.execute('SELECT value FROM document_elements WHERE paper_id=? AND version=? AND id=?', (paper_id, version, element_id)).fetchone()
    if not row:
        raise ValueError('Document element missing or stale; scan the PDF again')
    return json.loads(row['value'])


def _dispatch(library, request):
    action, paper_id = request['action'], request['id']
    with library.lock():
        _schema(library)
        if action == 'document_elements_clear':
            library.get(paper_id)
            library.db.execute('DELETE FROM document_elements WHERE paper_id=?', (paper_id,))
            library.db.execute('DELETE FROM document_element_pages WHERE paper_id=?', (paper_id,))
            return {'cleared': True, 'id': paper_id, 'usage': _usage(library, paper_id),
                    'warnings': ['已清除此篇派生索引；SQLite 空闲页可复用，不保证文件立即缩小。']}
        _initialize_usage(library, paper_id)
        path = library.pdf_path(paper_id)
        with library._open_pdf(path) as doc:
            count = doc.page_count
            try:
                version = _version(library, paper_id, path, doc)
            except ElementBudgetError as exc:
                previous = library.db.execute('SELECT version FROM document_element_pages WHERE paper_id=? ORDER BY rowid DESC LIMIT 1', (paper_id,)).fetchone()
                version = previous['version'] if previous else ''
                return {**_status(library, paper_id, version, count), 'paused': True, 'budget_reason': str(exc),
                        'source_verified': False, 'stale': True, 'elements': [], 'scanned_batch': [],
                        'cached_pages': [], 'total': 0}
            if action == 'document_elements_scan':
                return _scan(library, paper_id, doc, version, request)
            if action == 'document_elements_list':
                limit = _integer(request.get('limit', 40), 'limit', 1, 40)
                offset = _integer(request.get('offset', 0), 'offset', 0, 500000)
                kind, query = request.get('kind'), request.get('query', '')
                subtype = request.get('subtype')
                warning_offset = _integer(request.get('warning_offset', 0), 'warning_offset', 0, 2000)
                if kind and kind not in KINDS:
                    raise ValueError('Unsupported document element kind')
                if not isinstance(query, str) or len(query) > 500:
                    raise ValueError('query must be text up to 500 characters')
                clause, params = 'paper_id=? AND version=?', [paper_id, version]
                if kind:
                    clause += ' AND kind=?'
                    params.append(kind)
                if subtype is not None:
                    if subtype != 'flowchart':
                        raise ValueError('Unsupported document element subtype')
                    clause += " AND json_extract(value,'$.subtype')=?"
                    params.append(subtype)
                if query:
                    clause += " AND search_text LIKE ? ESCAPE '\\'"
                    params.append('%' + query.casefold().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%')
                total = library.db.execute('SELECT COUNT(*) FROM document_elements WHERE ' + clause, params).fetchone()[0]
                rows = library.db.execute("SELECT value FROM document_elements WHERE " + clause + " ORDER BY page,json_extract(value,'$.rect[1]'),id LIMIT ? OFFSET ?", [*params, limit, offset]).fetchall()
                notices = library.db.execute('SELECT page,warnings FROM document_element_pages WHERE paper_id=? AND version=? ORDER BY page LIMIT 40 OFFSET ?', (paper_id, version, warning_offset)).fetchall()
                return {**_status(library, paper_id, version, count), 'elements': [json.loads(row['value']) for row in rows], 'total': total, 'offset': offset,
                        'page_warnings': [{'page': row['page'], 'warnings': json.loads(row['warnings'])} for row in notices]}
            value = _element(library, paper_id, version, request.get('element_id'))
            if action == 'document_element_flow':
                if value['kind'] != 'algorithm':
                    raise ValueError('Only algorithm candidates can build a flowchart')
                from .algorithm_flow import parse_algorithm
                flow = parse_algorithm(value['text'])
                flow['warnings'] = list(flow.get('warnings', [])) + value['warnings']
                if value.get('truncated') or value.get('extraction_incomplete'):
                    flow.update(complete=False, status='partial')
                return {'flow': flow, 'element': value, 'source_version': version}
            if action == 'document_element_preview':
                width = _integer(request.get('render_width', 480), 'render_width', 64, 640)
                rect = fitz.Rect(value['rect'])
                page = doc[value['page'] - 1]
                _preflight_page(doc, value['page'])
                scale = min(width / rect.width, 4, 640 / max(rect.width, rect.height), math.sqrt(300000 / rect.get_area()))
                image = None
                for _ in range(4):
                    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, colorspace=fitz.csRGB, alpha=False, annots=False)
                    image = pix.tobytes('png')
                    if len(image) <= 1024 * 1024:
                        break
                    scale *= .65
                if len(image) > 1024 * 1024:
                    raise ValueError('Document element preview exceeds image budget')
                return {'element_id': value['id'], 'page': value['page'], 'rect': value['rect'], 'mime_type': 'image/png', 'image': base64.b64encode(image).decode(), 'width': pix.width, 'height': pix.height, 'source_version': version}
            if action == 'document_element_annotate':
                page = doc[value['page'] - 1]
                for annot in page.annots() or []:
                    metadata = library._annotation_metadata(annot)
                    if metadata.get('document_element_id') == value['id']:
                        return {'annotation': library._with_annotation_version(library._annotation(page, annot), True), 'reused': True, 'element_id': value['id']}
            else:
                raise ValueError('Unknown document element action')
        result = library._write_pdf(paper_id, lambda target: library._add_annotation(
            target, value['page'], type='square', rects=[value['rect']], text=value['caption'] or value['text'][:20000],
            comment=value['caption'] or value['title'], author='Reader', color='#467bb5',
            extra={'source_kind': 'document-element', 'document_element_id': value['id'],
                   'document_element_kind': value['kind'], 'source_version': version, 'extraction_method': value['method']}))
        return {**result, 'reused': False, 'element_id': value['id']}


def dispatch(library, request):
    try:
        return _dispatch(library, request)
    finally:
        # 官方 API 仅能收缩缓存，没有可用硬上限 setter；不常驻保留字体/图像。
        fitz.TOOLS.store_shrink(100)
