"""On-demand anchors from a citing PDF to entries in its own bibliography."""
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict

import pymupdf as fitz

from . import paper_references as refs
from .document_elements import ElementBudgetError, _preflight_page
from .paper_retrieval import integer
from .pdf_analysis_identity import content_version, observed_file
from .pdf_preprocessing import markdown_page

SCHEMA = 'citation-context-v1'
MAX_CANDIDATES = 400
MAX_WINDOW = 1800
MAX_TARGETS = 24
HEADING_PREFIX = re.compile(r'^(?:(?:\d+(?:\.\d+)*[.、]?|[IVX]+[.、]?)\s+|第[一二三四五六七八九十\d]+章\s*)')
SECTION = re.compile(r'^(?:introduction(?: and (?:background|related work))?|background(?: and (?:related work|motivation))?|related (?:work|works|literature|research)(?: and background)?|literature (?:review|survey)|prior work|research background|引言|导论|绪论|背景|研究背景|相关(?:工作|研究|文献)|国内外研究现状|文献综述)(?=\s*[:：.]|$)', re.I)
OTHER_SECTION = re.compile(r'^(?:abstract|acknowledg\w+|contributions?|conclusions?|discussion|methods?|methodology|model (?:design|architecture)|experiments?|results?|approach|preliminaries|appendi(?:x|ces)|references|bibliography|摘要|方法|研究方法|实验|结果|讨论|结论|参考文献|附录)(?:$|\s|[:：.])', re.I)
NUMBERED = re.compile(r'\[\s*\d{1,4}(?:\s*[-–—,，;；]\s*\d{1,4})*\s*\]')
YEAR_LIST = rf'{refs.YEAR}(?:\s*[,，]\s*[a-z](?=\s*[,，;；)]|$))*'
NAME = r"[^\W\d_][^\W\d_’'\-]*(?:[’'\-][^\W\d_]+)*"
SURNAME = rf'(?:(?:van|von|de|der|den|del|da|di|la)\s+){{0,3}}{NAME}'
AUTHOR_GROUP = rf'{SURNAME}(?:\s+et\s+al\.?|\s*[,，]?\s+(?:and|&|与|和)\s+{SURNAME}|\s*等)?'
AUTHOR_PAREN = re.compile(rf'(?P<names>{AUTHOR_GROUP})\s*[,，]\s*(?P<years>{YEAR_LIST})', re.I)
NARRATIVE = re.compile(rf'(?<![\w’\-])(?P<names>{AUTHOR_GROUP})\s*[(（]\s*(?P<years>{YEAR_LIST})\s*[)）]', re.I)
PARENS = re.compile(r'[(（]([^()（）\n]{1,500})[)）]')
SENTENCE_END = re.compile(r'[.!?。！？](?:[”’\"\']?)(?=\s|$|[\u3400-\u9fff])')
ABBREVIATION = re.compile(r'(?:\bet\s+al|\b(?:e\.g|i\.e|cf|vs|fig|eq|sec|no|vol|pp)|\b[A-Z])\.$', re.I)
CUE = re.compile(r'\b(?:propos\w+|us(?:e|es|ed|ing)|show\w*|outperform\w*|requir\w+|limit\w*|compar\w+|however|although|respectively|while|unlike|such as|first|second|extends?)\b|提出|采用|使用|表明|优于|局限|然而|相比|分别|例如', re.I)
PAGE_NUMBER = re.compile(r'^\d{1,6}$')
CAPTION = re.compile(r'^(?:fig(?:ure)?\.?|table|algorithm|图|表|算法)\s*\d+\s*[:.：]', re.I)
FURNITURE = re.compile(r'^(?:[∗*†‡]\s*Equal contribution|Proceedings of the .+pages \d|(?:https?://)\S+$|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d+.*Association for Computational Linguistics)', re.I)


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def normalize(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def plain(line):
    # Remove the extraction layer's styling, preserving PDF punctuation and words.
    line = re.sub(r'^\s{0,3}#{1,6}\s+', '', line)
    return re.sub(r'(?<!\w)(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)', r'\2', line).strip()


def heading(line):
    title = HEADING_PREFIX.sub('', plain(line)).strip()
    return title, SECTION.match(title)


def body_pages(doc, selected, bibliography):
    """Freeze column-ordered page text with offsets into its plain representation."""
    sections, skipped, extracted, blocks = [], [], [], []
    current = None
    warnings, truncated, total = [], False, 0
    explicit = selected['explicit']
    references_page = min(bibliography.get('reference_pages', []), default=doc.page_count + 1)
    for page in selected['pages']:
        if page > references_page:
            break
        try:
            _preflight_page(doc, page)
            text = markdown_page(doc, page)
        except (ElementBudgetError, RuntimeError) as error:
            warnings.append(f'PDF 第 {page} 页提取失败：{error}')
            skipped.append(page)
            current = None
            continue
        if total + len(text) > 100000:
            warnings.append('正文达到 100000 字符预算。')
            truncated = True
            break
        total += len(text)
        if not text.strip():
            skipped.append(page)
            current = None
            continue
        extracted.append(page)
        offset = 0
        blank_lines = 0
        footnote = False
        for raw in text.splitlines():
            line = plain(raw)
            start, offset = offset, offset + len(line) + 1
            title, match = heading(raw)
            if refs.HEADING.fullmatch(title) or refs.END_HEADING.match(title):
                return blocks, sections, extracted, skipped, warnings, truncated
            if not line:
                blank_lines += 1
                continue
            if blank_lines >= 2:
                footnote = False
            blank_lines = 0
            if re.match(r'^\d{1,2}(?=[A-Z][a-z])', line):
                footnote = True
            if footnote or FURNITURE.match(line):
                continue
            if match and len(line) <= 120:
                current = (title[:match.end()], page, start)
                sections.append({'section': current[0], 'page': page, 'start': start})
                remainder = title[match.end():].lstrip(' .:：')
                if not remainder:
                    continue
                start += line.rfind(remainder)
                line = remainder
            elif len(line) <= 110 and (raw.lstrip().startswith('#') or
                                       (title != line and raw.lstrip().startswith('**') and len(title.split()) <= 9) or
                                       (OTHER_SECTION.match(title) and len(title.split()) <= 5 and not title.endswith(('.', ',')))):
                current = None
                continue
            if line and not PAGE_NUMBER.fullmatch(line) and not CAPTION.match(line) and (current or explicit):
                if not any(char.isalnum() for char in line):
                    continue
                blocks.append((page, start, line, current))
    return blocks, sections, extracted, skipped, warnings, truncated


def join_blocks(blocks):
    segments, chunks, offset, previous = [], [], 0, None
    for page, start, line, section in blocks:
        if previous is None or previous[3] != section or page > previous[0] + 1:
            if chunks:
                yield ''.join(chunks), segments, previous[3]
            segments, chunks, offset = [], [], 0
        if chunks:
            chunks.append(' ')
            offset += 1
        segments.append((offset, offset + len(line), page, start))
        chunks.append(line)
        offset += len(line)
        previous = (page, start, line, section)
    if chunks:
        yield ''.join(chunks), segments, previous[3]


def positions(text, segments, start, end):
    """Map a window or marker back to exact normalized page text fragments."""
    parts = []
    for lower, upper, page, page_start in segments:
        if upper <= start:
            continue
        if lower >= end:
            break
        left, right = max(start, lower), min(end, upper)
        if right <= left:
            continue
        local = page_start + left - lower
        gap = local - parts[-1]['end'] if parts and parts[-1]['page'] == page else 0
        if 1 <= gap <= 4:
            parts[-1]['text'] += '\n' * gap + text[left:right]
            parts[-1]['end'] = local + right - left
        else:
            parts.append({'page': page, 'start': local, 'end': local + right - left, 'text': text[left:right]})
    return parts


def number_values(surface):
    result = []
    for item in re.split(r'[,，;；]', surface.strip('[]')):
        numbers = [int(value) for value in re.split(r'[-–—]', item)]
        if len(numbers) == 2 and not 0 < numbers[1] - numbers[0] < MAX_TARGETS:
            return []
        result.extend(range(numbers[0], numbers[-1] + 1))
        if len(result) > MAX_TARGETS:
            return []
    return list(dict.fromkeys(result))


def author_names(raw, style):
    if style == 'family-initials':
        return [normalize(match.group().split(',')[0]) for match in re.finditer(refs.AUTHOR, raw)]
    names = re.split(r',\s*|\s+(?:and|&)\s+', raw)
    pattern = re.compile(rf'{SURNAME}$', re.I)
    return [normalize(match.group()) for name in names if (match := pattern.search(name.strip()))]


def author_keys(names, years):
    names = re.sub(r'\s+(?:et\s+al\.?|等)$|等$', '', names, flags=re.I).strip()
    names = [normalize(name) for name in re.split(r'\s*[,，]?\s+(?:and|&|与|和)\s+', names, flags=re.I)]
    base = years[:4]
    return names, [year.strip() if len(year.strip()) >= 4 else base + year.strip().lower() for year in re.split(r'[,，]', years)]


def mentions(text):
    for match in NUMBERED.finditer(text):
        yield match.start(), match.end(), match.group(), number_values(match.group()), None
    # Groups are split at semicolons; an additional comma-delimited author/year
    # match is allowed when a style omits the semicolon.
    for paren in PARENS.finditer(text):
        for match in AUTHOR_PAREN.finditer(paren[1]):
            start, end = paren.start(1) + match.start(), paren.start(1) + match.end()
            yield start, end, text[start:end], None, author_keys(match['names'], match['years'])
    for match in NARRATIVE.finditer(text):
        yield match.start(), match.end(), match.group(), None, author_keys(match['names'], match['years'])


def sentence_ranges(text):
    start = 0
    for match in SENTENCE_END.finditer(text):
        end = match.end()
        if match.group()[0] == '.' and ABBREVIATION.search(text[max(start, end - 12):end]):
            continue
        yield start, end
        start = end
    if start < len(text):
        yield start, len(text)


def arxiv_fields(metadata):
    values = []
    for field in ('archive_location', 'archiveID', 'URL'):
        value = metadata.get(field)
        if isinstance(value, str):
            if field == 'archive_location' and normalize(str(metadata.get('archive', ''))) == 'arxiv':
                value = 'arxiv:' + value
            values.extend(refs.arxiv_versions(value))
    return sorted(set(values))


def arxiv_base(identifier):
    return re.sub(r'v\d+$', '', identifier)


def consistent_arxiv(keys):
    if len({arxiv_base(key) for key in keys}) != 1:
        return None
    explicit = [key for key in keys if arxiv_base(key) != key]
    if len(explicit) <= 1:
        return explicit[0] if explicit else keys[0]
    return None


def title_key(title):
    return normalize(title).strip(' .“”"') if isinstance(title, str) else ''


def metadata_key(metadata):
    authors, issued = metadata.get('author'), metadata.get('issued')
    dates = issued.get('date-parts') if isinstance(issued, dict) else None
    if (isinstance(authors, list) and authors and isinstance(authors[0], dict) and authors[0].get('family')
            and isinstance(dates, list) and dates and isinstance(dates[0], list) and dates[0] and metadata.get('title')):
        particle = authors[0].get('non-dropping-particle', '')
        family = normalize(f"{particle} {authors[0]['family']}")
        return (title_key(metadata['title']), family, str(dates[0][0]))
    return None


def bibliography_key(row):
    # Only delimited titles are eligible. A plain title ending at its first
    # period is accepted when a publication clause follows it unambiguously.
    body, family, year = '', None, None
    label = row['label']
    matched = refs.match_author_year(label)
    if matched:
        family = author_names(row['authors_raw'], row['author_style'])[0:1]
        year, body = row['year'][:4], matched['body']
    else:
        numbered = refs.NUMBER.match(label)
        if numbered:
            value = numbered[2]
            named = re.match(rf'^(?P<authors>{refs.FULL_AUTHORS})\.\s+(?P<body>.+)$', value)
            if named:
                family = author_names(named['authors'], 'full-name')[0:1]
                years = set(re.findall(r'(?<![\w./])(?:18|19|20)\d{2}(?![\w./])', named['body']))
                if len(years) == 1:
                    year, body = years.pop(), named['body']
            else:
                named = re.match(r'^(?:[A-Z]\.\s*){1,5}(?P<family>[^,.]{2,70})(?:,|\s+and\s+)', value)
                quoted = re.search(r'[“"](.{8,500}?)[”"](?=[, .]|$)', value)
                years = set(re.findall(r'(?<![\w./])(?:18|19|20)\d{2}(?![\w./])', value))
                if named and quoted and len(years) == 1:
                    return title_key(quoted[1]), normalize(named['family']), years.pop()
    title = re.match(r'^[“\"](.{8,500}?)[”\"](?:[, .]|$)|^(.{8,500}?)\.\s+(?:In\b|[A-Z][^.!?]{3,}\b(?:Journal|Transactions|Proceedings|Press|Conference|Review|Letters)\b|[_*]*(?:Journal|Transactions|Proceedings|arXiv|CoRR)\b|doi\s*:)', body)
    if title and family and year:
        return title_key(title[1] or title[2]), family[0], year
    return None


class Bibliography:
    def __init__(self, library, paper_id, snapshot):
        self.library = library
        self.paper_id = paper_id
        self.snapshot = snapshot
        self.rows = {row['number']: row for row in snapshot.get('references', [])}
        self.author_index = defaultdict(list)
        for row in self.rows.values():
            if row.get('graph_eligible', True) and row.get('authors_raw'):
                names = author_names(row['authors_raw'], row.get('author_style', 'family-initials'))
                if names:
                    self.author_index[names[0]].append((names, row['year'], row['number']))
        self.targets = {}
        self.library.db.create_function('citation_title_key', 1, title_key, deterministic=True)

    def target(self, number):
        if number in self.targets:
            return self.targets[number]
        row = self.rows[number]
        doi = row['identifiers']['doi']
        arxiv = refs.arxiv_versions(row['label'])
        ref_id = 'bib:' + digest(self.paper_id, self.snapshot['source_fingerprint'], number)[:32]
        # Reuse the ordinary citation graph's external work identity where it
        # has an exact identifier. Explicit arXiv versions remain distinguishable.
        identity = ('doi:' + doi[0]) if len(doi) == 1 else ('arxiv:' + arxiv[0]) if len(arxiv) == 1 else self.paper_id + ':' + row['raw']
        external = 'reference:' + hashlib.sha256(identity.encode()).hexdigest()[:24]
        target = {'id': ref_id, 'number': number, 'node_id': external, 'reference_id': external,
                  'label': row['label'][:500], 'paper_id': None, 'binding': 'bibliography-only',
                  'identifiers': {'doi': doi, 'arxiv': arxiv}, 'bibliography': row}
        if len(doi) > 1 or len(arxiv) > 1:
            target['binding'] = 'conflicting-identifiers'
        else:
            found, basis = self.catalog_match(doi, arxiv, row)
            target['binding'] = basis
            if found:
                target.update(paper_id=found['id'], node_id=found['id'], label=found['title'])
        if target['binding'] in ('conflicting-identifiers', 'version-conflict', 'ambiguous-catalog'):
            target['reference_id'] = target['node_id'] = 'reference:' + digest(ref_id)[:32]
        self.targets[number] = target
        return target

    def catalog_match(self, dois, arxiv, row):
        db = self.library.db
        available = 'id != ? AND id NOT IN (SELECT paper_id FROM paper_archive)'
        doi_rows, arxiv_rows, version_mismatch = [], [], False
        if dois:
            doi_rows = db.execute(f'SELECT id,title,doi,metadata FROM papers WHERE {available} AND doi=? LIMIT 2', (self.paper_id, dois[0])).fetchall()
        if arxiv:
            base = arxiv_base(arxiv[0])
            matches = db.execute(f'''SELECT id,title,doi,metadata FROM papers WHERE {available} AND
                (instr(lower(coalesce(json_extract(metadata,'$.archive_location'),'')),?) OR
                 instr(lower(coalesce(json_extract(metadata,'$.archiveID'),'')),?) OR
                 instr(lower(coalesce(json_extract(metadata,'$.URL'),'')),?)) LIMIT 101''',
                                 (self.paper_id, base, base, base)).fetchall()
            if len(matches) > 100:
                return None, 'ambiguous-catalog'
            for match in matches:
                keys = arxiv_fields(json.loads(match['metadata']))
                identity = consistent_arxiv(keys)
                relevant = any(arxiv_base(key) == base for key in keys)
                if relevant and (not identity or (arxiv[0] != base and identity != arxiv[0])):
                    version_mismatch = True
                elif relevant:
                    arxiv_rows.append(match)
            for match in doi_rows:
                keys = arxiv_fields(json.loads(match['metadata']))
                if keys and match['id'] not in {candidate['id'] for candidate in arxiv_rows}:
                    version_mismatch = True
            if dois and any(match['doi'] and match['doi'] != dois[0] for match in arxiv_rows):
                return None, 'conflicting-identifiers'
        matches = {match['id']: match for match in [*doi_rows, *arxiv_rows]}
        if len(matches) > 1:
            return None, 'ambiguous-catalog'
        if version_mismatch:
            return None, 'version-conflict'
        if matches:
            return next(iter(matches.values())), 'doi' if doi_rows else 'arxiv'
        if not (dois or arxiv) and (key := bibliography_key(row)):
            same_title = db.execute(f'SELECT id,title,metadata FROM papers WHERE {available} AND citation_title_key(title)=? LIMIT 101', (self.paper_id, key[0])).fetchall()
            if len(same_title) > 100:
                return None, 'ambiguous-catalog'
            matches = [match for match in same_title if metadata_key(json.loads(match['metadata'])) == key]
            if len(matches) == 1:
                return matches[0], 'title-author-year'
            if matches:
                return None, 'ambiguous-catalog'
        return None, 'bibliography-only'

    def lookup(self, number_list, author):
        if number_list is not None:
            if self.snapshot.get('source_kind') != 'pdf-numbered-bibliography':
                return [([], 'no-bibliography-match')]
            return [([number], 'number') if number in self.rows else ([], 'no-bibliography-match') for number in number_list] or [([], 'range-out-of-bounds')]
        names, years = author
        result = []
        for year in years:
            matches = [number for candidates, actual, number in self.author_index.get(names[0], [])
                       if (len(names) == 1 or candidates == names) and (actual == year or (len(year) == 4 and actual[:4] == year))]
            basis = 'author-year' if len(matches) == 1 else 'ambiguous-bibliography' if matches else 'no-bibliography-match'
            result.append((matches, basis))
        return result


def native_links(doc, page, surface, bibliography, lookup):
    """Use only links on the exact marker whose destination locates one entry."""
    source = doc[page - 1]
    if page not in lookup:
        lookup[page] = [link for link, _ in zip(source.links(), range(1001))]
    links = lookup[page]
    if not links or len(links) > 1000:
        return []
    boxes = source.search_for(surface, flags=fitz.TEXTFLAGS_SEARCH & ~fitz.TEXT_DEHYPHENATE)
    if len(boxes) != 1:
        return []
    result = set()
    for link in links:
        number = link.get('page', -1) + 1
        if link.get('kind') != fitz.LINK_GOTO or not boxes[0].intersects(link['from']) or not 1 <= number <= len(doc):
            continue
        point = link.get('to')
        if not isinstance(point, fitz.Point):
            continue
        if number not in bibliography.snapshot.get('reference_pages', []):
            continue
        dest = doc[number - 1]
        for row in bibliography.rows.values():
            if not row.get('graph_eligible', True) or row['page'] != number:
                continue
            first = row['parts'][0]['text'].splitlines()[0].strip()
            anchors = dest.search_for(first)
            if len(anchors) == 1 and abs(anchors[0].y0 - point.y) <= 12 and anchors[0].x0 - 65 <= point.x <= anchors[0].x1 + 10:
                result.add(row['number'])
    return sorted(result)


def bounded_mentions(entries, anchor):
    """Keep the anchors closest to the citing sentence when a list is very dense."""
    ranked = sorted(entries, key=lambda entry: abs(entry[0] - anchor))
    chosen, count = [], 0
    for left, _, mention in ranked:
        if count + len(mention['bindings']) > MAX_TARGETS:
            continue
        chosen.append((left, mention))
        count += len(mention['bindings'])
    return [mention for _, mention in sorted(chosen, key=lambda entry: entry[0])], len(chosen) < len(entries)


def candidate_windows(doc, blocks, bibliography, warnings):
    candidates, total, links = [], 0, {}
    for text, segments, section in join_blocks(blocks):
        anchors = sorted(mentions(text), key=lambda item: item[:2])
        if not anchors:
            continue
        located = []
        for start, end, surface, numbers, author in anchors[:1000]:
            parts = positions(text, segments, start, end)
            if not parts:
                continue
            bindings = bibliography.lookup(numbers, author)
            # PDF links are optional. Use them only on an ambiguous or missing
            # individual marker, and only to narrow that marker's candidates.
            if (len(bindings) == 1 and len(parts) == 1 and bibliography.rows
                    and bindings[0][1] in ('ambiguous-bibliography', 'no-bibliography-match') and len(located) < 60):
                choices, _ = bindings[0]
                linked = native_links(doc, parts[0]['page'], surface, bibliography, links)
                if len(linked) == 1 and (linked[0] in choices or not choices):
                    bindings = [(linked, 'pdf-link')]
            targets = []
            for choices, reason in bindings:
                usable = [value for value in choices if bibliography.rows[value].get('graph_eligible', True)]
                matched = reason in ('number', 'author-year', 'pdf-link') and len(usable) == 1
                entry = {'id': 'mention:' + digest(parts, surface, choices, len(targets))[:24],
                         'target_id': bibliography.target(usable[0])['id'] if matched else None,
                         'binding': reason if usable or not choices else 'unverified-bibliography',
                         'choices': choices[:6] if not matched else [], 'choice_count': len(choices) if not matched else 0}
                targets.append(entry)
            located.append((start, end, {'surface': surface, 'parts': parts, 'bindings': targets}))
        sentences = list(sentence_ranges(text))
        index = 0
        for sentence_index, (start, end) in enumerate(sentences):
            while index < len(located) and located[index][1] <= start:
                index += 1
            if index >= len(located) or located[index][0] >= end:
                continue
            total += 1
            if len(candidates) >= MAX_CANDIDATES:
                continue
            lower = sentences[max(0, sentence_index - 1)][0]
            upper = sentences[min(len(sentences) - 1, sentence_index + 4)][1]
            if upper - lower > MAX_WINDOW:
                lower = max(lower, located[index][0] - 650)
                upper = min(upper, lower + MAX_WINDOW)
                warnings.add('候选段落有窗口截断。')
            in_window, mentions_limited = bounded_mentions([entry for entry in located if lower <= entry[0] and entry[1] <= upper], located[index][0])
            if mentions_limited:
                warnings.add('部分候选的引文过多，候选保留供人工检查。')
            parts = positions(text, segments, lower, upper)
            candidates.append({'id': 'context:' + digest(parts)[:32], 'parts': parts, 'mentions': in_window,
                               'section': section[0] if section else None, 'anchor': positions(text, segments, max(lower, start), min(end, upper)),
                               'score': min(8, len(CUE.findall(text[max(lower, start):min(end, upper)])))})
        if len(anchors) > 1000:
            warnings.add('引文位置超过逐段扫描上限。')
    by_id = {}
    for candidate in candidates:
        prior = by_id.get(candidate['id'])
        if not prior or prior['score'] < candidate['score']:
            by_id[candidate['id']] = candidate
    ordered = sorted(by_id.values(), key=lambda row: (-row['score'], row['parts'][0]['page'], row['parts'][0]['start']))
    return ordered, total > MAX_CANDIDATES


def prepare(library, request):
    paper_id = request.get('id')
    paper = library.get(paper_id)
    path = library.pdf_path(paper_id)
    observed = observed_file(path)
    supplied_pages = request.get('pages')
    reference_pages = request.get('reference_pages')
    with library._open_pdf(path) as doc:
        if len(doc) > 2000:
            raise ValueError('引用描述仅支持至多 2000 页的 PDF。')
        version = content_version(library, paper_id, path, doc, observed)
        if supplied_pages is not None and (not isinstance(supplied_pages, list) or not 1 <= len(supplied_pages) <= 20
                                           or any(type(page) is not int or not 1 <= page <= len(doc) for page in supplied_pages)
                                           or any(b != a + 1 for a, b in zip(supplied_pages, supplied_pages[1:]))):
            raise ValueError('正文范围须为 1–20 个连续物理页码。')
        selected = supplied_pages or list(range(1, min(12, len(doc)) + 1))
        if reference_pages is not None and (not isinstance(reference_pages, list) or not 1 <= len(reference_pages) <= refs.MAX_PAGES
                                            or any(type(page) is not int or not 1 <= page <= len(doc) for page in reference_pages)
                                            or any(b != a + 1 for a, b in zip(reference_pages, reference_pages[1:]))):
            raise ValueError('参考文献范围须为 1–40 个连续物理页码。')
        reference_warnings = []
        snapshot = refs.saved(library, paper_id, check_source=False)
        if (not snapshot or snapshot.get('source_version') != version or snapshot.get('parser_version') != refs.PARSER_VERSION
                or (reference_pages is not None and snapshot.get('pages') != reference_pages)):
            try:
                snapshot = refs.read_snapshot(library, {'id': paper_id, 'pages': reference_pages})
            except (ValueError, RuntimeError) as error:
                snapshot = {'references': [], 'source_version': version, 'reference_pages': [], 'source_fingerprint': None}
                reference_warnings.append(f'无法解析书目：{error}')
        if snapshot['source_version'] != version:
            raise ValueError('正文在读取期间改变，请重试。')
        bibliography = Bibliography(library, paper_id, snapshot)
        blocks, sections, scanned, skipped, warnings, truncated = body_pages(doc, {'pages': selected, 'explicit': supplied_pages is not None}, snapshot)
        warnings = set(warnings + reference_warnings + snapshot.get('warnings', []))
        candidates, limited = candidate_windows(doc, blocks, bibliography, warnings)
        if not sections:
            warnings.add('未识别引言、背景或相关工作标题。可指定正文页补查。')
        if skipped:
            warnings.add('部分正文页无法提取文字。')
    if observed_file(path) != observed:
        raise ValueError('PDF 在读取期间改变，请重试。')
    unique_bindings = {binding['id']: binding for item in candidates for mention in item['mentions'] for binding in mention['bindings']}
    unresolved_numbers = {number for binding in unique_bindings.values() for number in binding['choices']}
    for number in sorted(unresolved_numbers):
        bibliography.target(number)
    coverage = {'pages_requested': selected, 'pages_scanned': scanned, 'pages_skipped': skipped, 'page_count': version['page_count'],
                'sections': sections, 'reference_pages': snapshot.get('reference_pages', []), 'reference_count': len(bibliography.rows),
                'candidate_count': len(candidates), 'truncated': truncated or limited or any('截断' in warning or '上限' in warning or '引文过多' in warning for warning in warnings),
                'scope': 'explicit-pages' if supplied_pages is not None else 'section-headings', 'ocr': False}
    used = Counter(binding['binding'] for binding in unique_bindings.values())
    coverage['binding_counts'] = dict(used)
    scope = digest(SCHEMA, supplied_pages, reference_pages)
    fingerprint = digest(SCHEMA, scope, version, snapshot['source_fingerprint'], candidates, list(bibliography.targets.values()))
    return {'paper': {'id': paper_id, 'title': paper['title']}, 'scope': scope, 'fingerprint': fingerprint,
            'source_version': version, 'source_observed': observed, 'bibliography_fingerprint': snapshot['source_fingerprint'],
            'coverage': coverage, 'warnings': sorted(warnings)[:30], 'candidates': candidates,
            'targets': list(bibliography.targets.values())}


def public_candidates(library, request):
    offset = integer(request, 'offset', 0, 0, MAX_CANDIDATES)
    limit = integer(request, 'limit', 12, 1, 16)
    result = prepare(library, request)
    if request.get('expected_fingerprint') not in (None, result['fingerprint']):
        raise ValueError('候选快照已变化，请从第一页重查。')
    items = result.pop('candidates')
    page = items[offset:offset + limit]
    # Keep the public response bounded even when every candidate cites a new
    # bibliography entry. The following offset reflects the rows returned.
    target_by_id = {target['id']: target for target in result['targets']}
    target_by_number = {target['number']: target for target in result['targets']}
    visible, targets, size = [], {}, 0
    for item in page:
        additions = {}
        for mention in item['mentions']:
            for binding in mention['bindings']:
                resolved = target_by_id.get(binding['target_id'])
                for target in ([resolved] if resolved else [target_by_number[number] for number in binding['choices']]):
                    if not resolved:
                        target = {key: value for key, value in target.items() if key != 'bibliography'}
                    if target['id'] not in targets or resolved and 'bibliography' not in targets[target['id']]:
                        if target['id'] not in additions or resolved:
                            additions[target['id']] = target
        current = len(json.dumps([item, additions], ensure_ascii=False).encode())
        if visible and size + current > 256 * 1024:
            break
        visible.append(item)
        targets.update(additions)
        size += current
    return {**result, 'items': visible, 'targets': list(targets.values()),
            'offset': offset, 'next_offset': offset + len(visible) if visible and offset + len(visible) < len(items) else None}
