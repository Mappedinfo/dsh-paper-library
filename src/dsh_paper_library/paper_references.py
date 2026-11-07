"""显式提取一篇 PDF 的编号参考文献；使用现有 PyMuPDF，不联网补造题录。

提取的是可回查的参考文献段落，不宣称完成通用书目字段解析。
仅保存具有 References 标题和连续编号的条目；不推断作者、题名或 DOI。
"""
import hashlib
import json
import re
from datetime import datetime, timezone

MAX_PAGES = 40
MAX_CHARACTERS = 256000
MAX_REFERENCES = 200
MAX_REFERENCE_CHARACTERS = 4000
HEADING = re.compile(r"^(?:\d+[.\s]+)?(?:references|bibliography|参考文献)\s*$", re.I)
END_HEADING = re.compile(r"^(?:appendix|appendices|supplementary (?:material|information)|附录)(?:\s|$)", re.I)
NUMBER = re.compile(r"^\s*\[(\d{1,4})\]\s+(.+)$")
DOI = re.compile(r"\b10\.\d{4,9}/[^\s<>\"]+", re.I)
ARXIV = re.compile(r"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/|\babs/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)", re.I)


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
        row["label"] = re.sub(r"\s+", " ", raw)
        row["identifiers"] = identifiers(raw)
    return rows, list(dict.fromkeys(warnings)), ended


def extract(library, request):
    paper_id = request.get("id")
    paper = library.get(paper_id)
    if paper.get("archived") or not paper.get("pdf"):
        raise ValueError("请选择在库且已关联 PDF 的论文。")
    path = library.pdf_path(paper_id)
    version = path.stat()
    explicit = request.get("pages")
    with library._open_pdf(path) as doc:
        total = len(doc)
        if explicit is None:
            selected = list(range(max(1, total - 11), total + 1))
        elif not isinstance(explicit, list) or not explicit or len(explicit) > MAX_PAGES or any(type(p) is not int or not 1 <= p <= total for p in explicit) or sorted(set(explicit)) != explicit:
            raise ValueError("参考文献范围须为升序且不重复的 1–40 个有效 PDF 页码。")
        else:
            selected = explicit
        if any(b != a + 1 for a, b in zip(selected, selected[1:])):
            raise ValueError("参考文献提取需要连续页码，避免把缺页内容拼接成引用。")
        pages, count = [], 0
        for number in selected:
            page = doc[number - 1]
            # PyMuPDF 负责 PDF 文本提取；仅排除页脚中的该页页码。
            blocks = [b[4] for b in page.get_text('blocks', sort=True) if b[6] == 0 and not (b[1] > page.rect.height * .9 and b[4].strip() == str(number))]
            text = '\n'.join(blocks)
            count += len(text)
            if count > MAX_CHARACTERS:
                raise ValueError("参考文献扫描超过 256000 字符；本次未覆盖旧结果，请缩小范围。")
            pages.append((number, text))
        rows, warnings, ended = parse_numbered(pages)
        if selected[-1] != total and not ended:
            raise ValueError("所选页尚未覆盖参考文献末尾；请包含后续页或附录起始页，旧记录未改变。")
    after = path.stat()
    if (version.st_size, version.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("PDF 在提取期间改变，请重试；旧记录未改变。")
    fingerprint = hashlib.sha256(json.dumps(pages, ensure_ascii=False).encode()).hexdigest()
    value = {"paper_id": paper_id, "references": rows, "count": len(rows), "pages": selected, "page_count": total,
             "reference_pages": sorted({part['page'] for row in rows for part in row['parts']}),
             "source_fingerprint": fingerprint, "source_kind": "pdf-numbered-bibliography", "warnings": warnings,
             "scope": "selected-pages" if explicit is not None else "last-12-pages", "extracted_at": datetime.now(timezone.utc).isoformat(),
             "semantics": "PDF reference-list entries; no inferred bibliographic fields, no inbound citation counts"}
    schema(library)
    with library.lock():
        library.get(paper_id)
        previous = library.db.execute("SELECT value FROM paper_reference_snapshots WHERE paper_id=?", (paper_id,)).fetchone()
        if previous:
            saved = json.loads(previous['value'])
            if saved['source_fingerprint'] == fingerprint:
                return {**saved, "duplicate": True}
        library.db.execute("INSERT INTO paper_reference_snapshots(paper_id,value) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET value=excluded.value", (paper_id, json.dumps(value, ensure_ascii=False)))
    return {**value, "duplicate": False}


def saved(library, paper_id):
    if not library.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_reference_snapshots'").fetchone():
        return None
    row = library.db.execute("SELECT value FROM paper_reference_snapshots WHERE paper_id=?", (paper_id,)).fetchone()
    return json.loads(row['value']) if row else None


def project(library, item):
    snapshot = saved(library, item['id'])
    if not snapshot:
        return [], [], None
    nodes, edges = [], []
    for ref in snapshot['references'][:MAX_REFERENCES]:
        doi = ref['identifiers']['doi']
        # 精确 DOI 唯一匹配才复用库内条目。未入库的被引作品仍能展示为参考文献节点。
        matches = library.db.execute("SELECT id,title FROM papers WHERE lower(doi)=? AND NOT EXISTS(SELECT 1 FROM paper_archive WHERE paper_id=papers.id) LIMIT 2", (doi[0],)).fetchall() if len(doi) == 1 else []
        target = matches[0] if len(matches) == 1 and matches[0]['id'] != item['id'] else None
        identity = 'doi:' + doi[0] if len(doi) == 1 else 'arxiv:' + ref['identifiers']['arxiv'][0] if len(ref['identifiers']['arxiv']) == 1 else item['id'] + ':' + ref['raw']
        node_id = target['id'] if target else 'reference:' + hashlib.sha256(identity.encode()).hexdigest()[:24]
        evidence = {"page": ref['page'], "quote": ref['raw'], "note": f"PDF 参考文献 [{ref['number']}]；原始题录快照，未补造书目字段。", "source": 'PDF reference list', "annotation_id": ''}
        nodes.append({"id": node_id, "paper_id": item['id'], "type": 'paper', "label": target['title'] if target else ref['label'][:500],
                      "description": ref['raw'], "external_reference": target is None, "identifiers": ref['identifiers'], "evidence": evidence,
                      "provenance": 'pdf-reference', "editable": False})
        edge_id = 'pdf-cites:' + hashlib.sha256((item['id'] + ':' + str(ref['number']) + ':' + node_id).encode()).hexdigest()[:24]
        edges.append({"id": edge_id, "paper_id": item['id'], "source": item['id'], "target": node_id, "relation": 'cites', "evidence": evidence,
                      "provenance": 'pdf-reference', "editable": False, "reference_number": ref['number']})
    return nodes, edges, {"paper_id": item['id'], "count": snapshot['count'], "pages": snapshot['reference_pages'], "extracted_at": snapshot['extracted_at'], "warnings": snapshot['warnings']}
