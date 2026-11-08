"""有界提取 PDF 编号／作者年份参考文献，不联网、不使用模型补造题录。

提取的是可回查的参考文献段落，不宣称完成通用书目字段解析。
只按明确的标题、编号或作者年份语法分段；不推断缺失题录。
"""
import hashlib
import json
import re
from datetime import datetime, timezone

import pymupdf

from .pdf_analysis_identity import content_version, observed_file

MAX_PAGES = 40
MAX_CHARACTERS = 256000
MAX_REFERENCES = 200
MAX_REFERENCE_CHARACTERS = 4000
PARSER_VERSION = 2
HEADING = re.compile(r"^(?:\d+[.\s]+)?(?:references|bibliography|参考文献)\s*$", re.I)
END_HEADING = re.compile(r"^(?:appendix|appendices|supplementary (?:material|information)|附录)(?:\s|$)", re.I)
NUMBER = re.compile(r"^\s*\[(\d{1,4})\]\s+(.+)$")
DOI = re.compile(r"\b10\.\d{4,9}/[^\s<>\"]+", re.I)
ARXIV = re.compile(r"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/|\babs/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)", re.I)
# 仅承认“姓, 首字母.”语法，避免把正文中的年份或出版地误当作新条目。
AUTHOR = r"(?:(?:van|von|de|der|den|del|da|di|la)\s+){0,3}[A-ZÀ-ÖØ-Þ][\wÀ-ž’'\-]*(?:\s+[A-ZÀ-ÖØ-Þ][\wÀ-ž’'\-]*){0,3},\s*(?:[A-ZÀ-ÖØ-Þ]\.\s*){1,5}"
AUTHOR_START = re.compile(r"^" + AUTHOR)
AUTHOR_CANDIDATE = re.compile(r"^[A-Za-zÀ-ž][\wÀ-ž’'\- ]{0,65},\s*(?:[A-ZÀ-ÖØ-Þ][.,]|$)")
AUTHOR_YEAR = re.compile(r"^(?P<authors>" + AUTHOR + r"(?:(?:,?\s*(?:and\s+|&\s+)?)" + AUTHOR + r")*(?:,?\s+et\s+al\.)?),?\s*(?:\((?P<parenthesized>(?:18|19|20)\d{2}[a-z]?)\)|(?P<year>(?:18|19|20)\d{2}[a-z]?))\.\s+(?P<body>.+)$")


def readable_text(raw):
    """显示与标识识别使用去断行文本；parts/raw 始终保留原始出处。"""
    text = re.sub(r"\u00ad\s*\n\s*", "", raw).replace("\u00ad", "")
    text = re.sub(r"(?<=[a-z])-\s*\n\s*(?=[a-z])", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _append_line(row, page, line):
    if row['parts'] and row['parts'][-1]['page'] == page:
        row['parts'][-1]['text'] += '\n' + line
    else:
        row['parts'].append({'page': page, 'text': line})


def parse_author_year(pages):
    """保守解析无编号作者年份目录；不能确认的段落隔离，避免粘到上一条。"""
    lines, started, ended = [], False, False
    for page, text in pages:
        for line in text.splitlines():
            line = line.strip()
            if not started:
                started = bool(HEADING.fullmatch(line))
                continue
            if END_HEADING.match(line):
                ended = True
                break
            if line:
                lines.append((page, line))
        if ended:
            break
    if not started:
        raise ValueError('所读页中没有参考文献标题；旧记录未改变。')
    rows, warnings, current = [], [], None
    for index, (page, line) in enumerate(lines):
        if NUMBER.match(line):
            raise ValueError('参考文献混用编号和作者年份格式；无法可靠确认分段，旧记录未改变。')
        if AUTHOR_CANDIDATE.match(line):
            # 作者名单可能跨行／跨页。最多前瞻六行，遇到下一位新作者不提前停止。
            lookahead = []
            match = None
            for _, part in lines[index:index + 6]:
                lookahead.append(part)
                candidate = readable_text('\n'.join(lookahead))
                if len(candidate) > 1200:
                    break
                match = AUTHOR_YEAR.match(candidate)
                if match:
                    break
            if match:
                # 紧接在未写完的作者名单之后，是同一条目的延续而非新条目。
                unfinished = current and current['citation_style'] == 'author-year' and not re.search(r'\b(?:18|19|20)\d{2}', '\n'.join(p['text'] for p in current['parts']))
                if not unfinished:
                    if current:
                        rows.append(current)
                    current = {'number': len(rows) + 1, 'page': page, 'parts': [], 'citation_style': 'author-year'}
            elif not current or AUTHOR_YEAR.match(readable_text('\n'.join(p['text'] for p in current['parts']))):
                if current:
                    rows.append(current)
                current = {'number': len(rows) + 1, 'page': page, 'parts': [], 'citation_style': 'unrecognized', 'graph_eligible': False}
                warnings.append(f'第 {page} 页存在无法确认作者年份边界的题录，保留原文待核对，不生成引用关系。')
        if current:
            _append_line(current, page, line)
        else:
            warnings.append(f'第 {page} 页参考文献标题后有未识别文字，未生成引用关系。')
    if current:
        rows.append(current)
    if not rows or not any(row['citation_style'] == 'author-year' for row in rows):
        raise ValueError('没有可靠识别的作者年份参考文献；支持“姓, 首字母., 年份. 正文”格式，旧记录未改变。')
    if len(rows) > MAX_REFERENCES:
        raise ValueError('参考文献超过 200 条；旧记录未改变。')
    for row in rows:
        raw = '\n'.join(p['text'] for p in row['parts'])
        if len(raw) > MAX_REFERENCE_CHARACTERS:
            raise ValueError('参考文献条目过长；旧记录未改变。')
        label = readable_text(raw)
        match = AUTHOR_YEAR.match(label)
        ids = identifiers(label)
        row.update(raw=raw, label=label, identifiers=ids)
        row.setdefault('graph_eligible', True)
        if not match or len(match['body']) < 12 or not (label.endswith(('.', ')')) or ids['doi'] or ids['arxiv']):
            row['graph_eligible'] = False
            row['quality'] = 'needs-review'
            warnings.append(f'参考文献第 {row["number"]} 条可能截断或缺少正文，保留原文待核对，不生成引用关系。')
        else:
            row['year'] = match['year'] or match['parenthesized']
            row['authors_raw'] = match['authors']
            row['quality'] = 'parsed' if row['graph_eligible'] else 'needs-review'
        if len(ids['doi']) > 1 or len(ids['arxiv']) > 1:
            warnings.append(f'参考文献第 {row["number"]} 条包含多个标识符，不自动合并到库内文献。')
    return rows, list(dict.fromkeys(warnings)), ended


def parse_references(pages):
    after_heading = False
    for _, text in pages:
        for line in text.splitlines():
            if HEADING.fullmatch(line.strip()):
                after_heading = True
            elif after_heading and NUMBER.match(line):
                return (*parse_numbered(pages), 'numbered')
            elif after_heading and AUTHOR_CANDIDATE.match(line.strip()):
                return (*parse_author_year(pages), 'author-year')
    raise ValueError('没有可靠识别的参考文献目录；旧记录未改变。')


def schema(library):
    with library.lock():
        library.db.execute("CREATE TABLE IF NOT EXISTS paper_reference_snapshots(paper_id TEXT PRIMARY KEY, value TEXT NOT NULL)")


def identifiers(text):
    """只承认段落中实际出现的标识符；多于一个时不自动合并目标。"""
    dois = sorted({match.group(0).rstrip('.,;:)').lower() for match in DOI.finditer(text)})
    arxiv = sorted({re.sub(r'v\d+$', '', match.group(1), flags=re.I).lower() for match in ARXIV.finditer(text)})
    return {"doi": dois, "arxiv": arxiv}


def parse_numbered(pages):
    rows, current, started, ended = [], None, False, False
    warnings = []
    for page, text in pages:
        for line in text.splitlines():
            line = line.rstrip()
            if not started:
                if HEADING.fullmatch(line.strip()):
                    started = True
                continue
            if END_HEADING.match(line.strip()):
                ended = True
                break
            match = NUMBER.match(line)
            if match:
                if current:
                    rows.append(current)
                current = {"number": int(match.group(1)), "page": page, "parts": [{"page": page, "text": line.strip()}]}
                if len(rows) >= MAX_REFERENCES:
                    raise ValueError("参考文献超过 200 条；本次未覆盖旧结果，请缩小范围。")
            elif current and line.strip():
                if current["parts"][-1]["page"] == page:
                    current["parts"][-1]["text"] += "\n" + line.strip()
                else:
                    current["parts"].append({"page": page, "text": line.strip()})
            elif line.strip():
                warnings.append("参考文献标题后有未识别文字，未将其生成引用关系。")
        if ended:
            break
    if current:
        rows.append(current)
    if not started or not rows:
        raise ValueError("所读页中没有可可靠识别的编号参考文献；当前支持 References／Bibliography／参考文献标题下的 [1] 连续编号，旧记录未改变。")
    if [row["number"] for row in rows] != list(range(1, len(rows) + 1)):
        raise ValueError("参考文献编号缺失、重复或顺序异常；无法确认完整分段，旧记录未改变。")
    for row in rows:
        raw = "\n".join(part["text"] for part in row["parts"])
        if len(raw) > MAX_REFERENCE_CHARACTERS or len(raw) < 12:
            raise ValueError("参考文献条目过长或缺少正文；旧记录未改变。")
        row["raw"] = raw
        row["label"] = readable_text(raw)
        row["identifiers"] = identifiers(row['label'])
    return rows, list(dict.fromkeys(warnings)), ended


def extract(library, request):
    paper_id = request.get("id")
    paper = library.get(paper_id)
    if paper.get("archived") or not paper.get("pdf"):
        raise ValueError("请选择在库且已关联 PDF 的论文。")
    path = library.pdf_path(paper_id)
    observed = observed_file(path)
    explicit = request.get("pages")
    with library._open_pdf(path) as doc:
        total = len(doc)
        if total > 2000:
            raise ValueError('参考文献扫描最多接受 2000 页的 PDF；旧记录未改变。')
        source_version = content_version(library, paper_id, path, doc, observed)
        if explicit is None:
            selected = list(range(max(1, total - MAX_PAGES + 1), total + 1))
        elif not isinstance(explicit, list) or not explicit or len(explicit) > MAX_PAGES or any(type(p) is not int or not 1 <= p <= total for p in explicit) or sorted(set(explicit)) != explicit:
            raise ValueError("参考文献范围须为升序且不重复的 1–40 个有效 PDF 页码。")
        else:
            selected = explicit
        if any(b != a + 1 for a, b in zip(selected, selected[1:])):
            raise ValueError("参考文献提取需要连续页码，避免把缺页内容拼接成引用。")
        pages, count, page_blocks = [], 0, []
        margins = {}
        for number in selected:
            page = doc[number - 1]
            blocks = []
            # FreeText 批注也可能被 Page.get_text 收进正文；显示列表显式排除批注。
            textpage = pymupdf.TextPage(page.get_displaylist(annots=False).get_textpage())
            for block in sorted(textpage.extractBLOCKS(), key=lambda block: (block[3], block[0])):
                if block[6] != 0:
                    continue
                text = block[4].strip()
                count += len(text)
                if count > MAX_CHARACTERS:
                    raise ValueError("参考文献扫描超过 256000 字符；本次未覆盖旧结果，请缩小范围。")
                marginal = block[3] < page.rect.height * .1 or block[1] > page.rect.height * .9
                key = re.sub(r'\d+', '#', readable_text(text))
                # 只忽略边缘的独立页码，或至少两页重复的短页眉；正文与 References 标题不能被过滤。
                candidate = marginal and len(text) < 240 and not HEADING.fullmatch(text) and not AUTHOR_START.match(text) and not NUMBER.match(text)
                if candidate:
                    margins.setdefault(key, set()).add(number)
                blocks.append((text, candidate, key))
            page_blocks.append((number, blocks))
        for number, blocks in page_blocks:
            blocks = [text for text, candidate, key in blocks if not (candidate and (text.isdigit() or len(margins[key]) >= 2))]
            text = '\n'.join(blocks)
            pages.append((number, text))
        try:
            rows, warnings, ended, style = parse_references(pages)
        except ValueError as error:
            if explicit is None:
                raise ValueError(f'{error} 本次仅回看 PDF 最后 {len(selected)} 页（{selected[0]}–{selected[-1]}）；可指定包含参考文献标题及末尾的连续页码，最多 40 页。') from error
            raise
        if selected[-1] != total and not ended:
            raise ValueError("所选页尚未覆盖参考文献末尾；请包含后续页或附录起始页，旧记录未改变。")
    if observed_file(path) != observed and _current_version(library, paper_id) != source_version:
        raise ValueError("PDF 正文在提取期间改变，请重试；旧记录未改变。")
    fingerprint = hashlib.sha256(json.dumps([PARSER_VERSION, pages], ensure_ascii=False).encode()).hexdigest()
    value = {"paper_id": paper_id, "references": rows, "count": len(rows), "pages": selected, "page_count": total,
             "reference_pages": sorted({part['page'] for row in rows for part in row['parts']}),
             "source_fingerprint": fingerprint, "source_kind": f"pdf-{style}-bibliography", "warnings": warnings,
             "source_version": source_version,
             "parser_version": PARSER_VERSION, "graph_count": sum(row.get('graph_eligible', True) for row in rows),
             "scope": "selected-pages" if explicit is not None else "last-40-pages", "extracted_at": datetime.now(timezone.utc).isoformat(),
             "semantics": "PDF reference-list entries; no inferred bibliographic fields, no inbound citation counts"}
    schema(library)
    with library.lock():
        library.get(paper_id)
        previous = library.db.execute("SELECT value FROM paper_reference_snapshots WHERE paper_id=?", (paper_id,)).fetchone()
        if previous:
            saved = json.loads(previous['value'])
            if saved['source_fingerprint'] == fingerprint and saved.get('source_version') == source_version:
                return {**saved, "duplicate": True, "stale": False}
        library.db.execute("INSERT INTO paper_reference_snapshots(paper_id,value) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET value=excluded.value", (paper_id, json.dumps(value, ensure_ascii=False)))
    return {**value, "duplicate": False, "stale": False}


def _current_version(library, paper_id):
    path = library.pdf_path(paper_id)
    # 文件原子替换时重开；绝不把旧文档的底稿摘要缓存到新的文件观察值。
    for _ in range(3):
        observed = observed_file(path)
        with library._open_pdf(path) as doc:
            if len(doc) > 2000:
                raise ValueError('参考文献底稿检查最多接受 2000 页的 PDF。')
            version = content_version(library, paper_id, path, doc, observed)
        if observed_file(path) == observed:
            return version
    return None


def saved(library, paper_id, *, check_source=True):
    if not library.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_reference_snapshots'").fetchone():
        return None
    row = library.db.execute("SELECT value FROM paper_reference_snapshots WHERE paper_id=?", (paper_id,)).fetchone()
    if not row:
        return None
    value = json.loads(row['value'])
    if not check_source:
        return value
    try:
        stale = value.get('parser_version') != PARSER_VERSION or not value.get('source_version') or value['source_version'] != _current_version(library, paper_id)
    except (ValueError, OSError, RuntimeError):
        stale = True
    return {**value, 'stale': stale}


def project(library, item):
    # 全库绘图不逐篇打开 PDF；来源核验仅由显式 get／extract 执行。
    snapshot = saved(library, item['id'], check_source=False)
    if not snapshot:
        return [], [], None
    nodes, edges, warnings = [], [], list(snapshot['warnings'])
    for ref in snapshot['references'][:MAX_REFERENCES]:
        if not ref.get('graph_eligible', True):
            continue
        doi = ref['identifiers']['doi']
        # 精确 DOI 唯一匹配才复用库内条目。未入库的被引作品仍能展示为参考文献节点。
        unambiguous = len(doi) <= 1 and len(ref['identifiers']['arxiv']) <= 1
        matches = library.db.execute("SELECT id,title FROM papers WHERE lower(doi)=? AND NOT EXISTS(SELECT 1 FROM paper_archive WHERE paper_id=papers.id) LIMIT 2", (doi[0],)).fetchall() if len(doi) == 1 and unambiguous else []
        if len(matches) > 1:
            warnings.append(f'参考文献第 {ref["number"]} 条的 DOI 对应多个库内条目；保留外部引用节点，未自动合并。')
        target = matches[0] if len(matches) == 1 and matches[0]['id'] != item['id'] else None
        identity = 'doi:' + doi[0] if len(doi) == 1 and unambiguous else 'arxiv:' + ref['identifiers']['arxiv'][0] if len(ref['identifiers']['arxiv']) == 1 and unambiguous else item['id'] + ':' + ref['raw']
        node_id = target['id'] if target else 'reference:' + hashlib.sha256(identity.encode()).hexdigest()[:24]
        locator = f"目录第 {ref['number']} 条" if ref.get('citation_style') == 'author-year' else f"[{ref['number']}]"
        evidence = {"page": ref['page'], "quote": ref['raw'], "parts": ref['parts'], "note": f"PDF 参考文献 {locator}；原始题录快照，未补造书目字段。", "source": 'PDF reference list', "annotation_id": ''}
        nodes.append({"id": node_id, "paper_id": item['id'], "type": 'paper', "label": target['title'] if target else ref['label'][:500],
                      "description": ref['raw'], "external_reference": target is None, "identifiers": ref['identifiers'], "evidence": evidence,
                      "provenance": 'pdf-reference', "editable": False})
        edge_id = 'pdf-cites:' + hashlib.sha256((item['id'] + ':' + str(ref['number']) + ':' + node_id).encode()).hexdigest()[:24]
        edges.append({"id": edge_id, "paper_id": item['id'], "source": item['id'], "target": node_id, "relation": 'cites', "evidence": evidence,
                      "provenance": 'pdf-reference', "editable": False, "reference_number": ref['number']})
    return nodes, edges, {"paper_id": item['id'], "count": snapshot['count'], "graph_count": len(edges), "pages": snapshot['reference_pages'], "extracted_at": snapshot['extracted_at'], "warnings": list(dict.fromkeys(warnings))}
