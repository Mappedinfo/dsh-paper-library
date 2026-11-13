"""Persist and query source-attributed descriptions of cited work."""
import json
import re
from datetime import datetime, timezone

from . import citation_contexts as contexts
from .paper_references import _current_version
from .paper_retrieval import integer
from .pdf_analysis_identity import observed_file

RELATIONS = {'studies', 'proposes', 'uses', 'reports', 'strength', 'limitation', 'compares', 'adopts'}
ROLES = {'subject', 'dataset', 'method-source', 'baseline'}
MAX_CLAIMS = 192
MAX_CLAIM_BYTES = 384 * 1024
SCHEMA_SQL = (
    '''CREATE TABLE IF NOT EXISTS citation_claim_runs (
        paper_id TEXT NOT NULL, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, revision TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(paper_id,scope))''',
    '''CREATE TABLE IF NOT EXISTS citation_claim_rows (
        paper_id TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, page INTEGER NOT NULL, start INTEGER NOT NULL,
        relation TEXT NOT NULL, search TEXT NOT NULL, methods TEXT NOT NULL, tasks TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(paper_id,scope,id))''',
    '''CREATE TABLE IF NOT EXISTS citation_claim_targets (
        paper_id TEXT NOT NULL, scope TEXT NOT NULL, claim_id TEXT NOT NULL, identity TEXT NOT NULL,
        PRIMARY KEY(identity,paper_id,scope,claim_id))''',
    'CREATE INDEX IF NOT EXISTS citation_claim_target_owner ON citation_claim_targets(paper_id,scope,claim_id)',
)


def initialized(library):
    return library.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='citation_claim_runs'").fetchone() is not None


def load_run(library, paper_id, scope):
    if not initialized(library):
        return None
    row = library.db.execute('SELECT value FROM citation_claim_runs WHERE paper_id=? AND scope=?', (paper_id, scope)).fetchone()
    return json.loads(row[0]) if row else None


def prepare(library, request):
    if type(request.get('force', False)) is not bool:
        raise ValueError('force 必须是布尔值。')
    frozen = contexts.prepare(library, request)
    previous = load_run(library, frozen['paper']['id'], frozen['scope'])
    if previous and previous['fingerprint'] == frozen['fingerprint'] and not request.get('force'):
        return {'reused': True, **previous}
    return {**frozen, 'expected_revision': previous['revision'] if previous else None}


def field(value, name, maximum, minimum=0):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum or '\0' in value:
        raise ValueError(f'引用描述字段 {name} 无效。')
    return value.strip()


def words(value, name, maximum=12):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f'引用描述字段 {name} 超过条目限制。')
    return list(dict.fromkeys(field(word, name, 150, 1) for word in value))


def checked_evidence(item, candidate):
    if not isinstance(item, dict) or type(item.get('part')) is not int or not 0 <= item['part'] < len(candidate['parts']):
        raise ValueError('模型引用了本次未提供的原文片段。')
    part = candidate['parts'][item['part']]
    quote = field(item.get('quote'), 'quote', 1200, 5)
    offset = part['text'].find(quote)
    if offset < 0 or part['text'].find(quote, offset + 1) >= 0:
        raise ValueError('模型摘录必须精确且唯一地出现在所选原文片段中。')
    return {'page': part['page'], 'start': part['start'] + offset, 'end': part['start'] + offset + len(quote), 'text': quote}


def checked_claim(item, paper_id, source_version, candidates, targets):
    if not isinstance(item, dict):
        raise ValueError('模型陈述必须是对象。')
    candidate = candidates.get(field(item.get('context_id'), 'context_id', 80, 1))
    relation = field(item.get('relation'), 'relation', 30, 1)
    scope = field(item.get('scope'), 'scope', 20, 1)
    if candidate is None or relation not in RELATIONS or scope not in ('individual', 'shared', 'group'):
        raise ValueError('模型陈述缺少有效的候选段落、关系或适用范围。')
    raw_targets, raw_evidence = item.get('targets'), item.get('evidence')
    if not isinstance(raw_targets, list) or not 1 <= len(raw_targets) <= contexts.MAX_TARGETS or not isinstance(raw_evidence, list) or not 1 <= len(raw_evidence) <= 6:
        raise ValueError('陈述需要有界的引文目标及原文片段。')
    bindings = {binding['id']: (mention, binding) for mention in candidate['mentions'] for binding in mention['bindings'] if binding['target_id']}
    selected, seen = [], set()
    for row in raw_targets:
        if not isinstance(row, dict):
            raise ValueError('模型引文目标格式无效。')
        mention_id = field(row.get('mention_id'), 'mention_id', 80, 1)
        role = field(row.get('role'), 'role', 30, 1)
        if mention_id not in bindings or role not in ROLES:
            raise ValueError('模型选择了该候选中未绑定的引文位置或无效角色。')
        mention, binding = bindings[mention_id]
        target = targets[binding['target_id']]
        identity = target['id'], role
        anchor = {'id': mention_id, 'surface': mention['surface'], 'parts': mention['parts'], 'binding': binding['binding']}
        if identity in seen:
            next(value for value in selected if (value['id'], value['role']) == identity)['mentions'].append(anchor)
            continue
        seen.add(identity)
        selected.append({**target, 'role': role, 'mentions': [anchor]})
    primary = [target for target in selected if target['role'] in ('subject', 'baseline')]
    subjects = {target['id'] for target in selected if target['role'] == 'subject'}
    if not primary or (scope == 'individual' and len(subjects) > 1) or (scope in ('shared', 'group') and len(subjects) < 2):
        raise ValueError('模型陈述的适用范围与被描述论文数量不符。')
    if not subjects and relation != 'compares':
        raise ValueError('此类陈述须有明确的被描述论文。')
    evidence = sorted({(ref['page'], ref['start'], ref['end'], ref['text']): ref
                       for ref in (checked_evidence(value, candidate) for value in raw_evidence)}.values(),
                      key=lambda value: (value['page'], value['start']))
    statement = field(item.get('statement'), 'statement', 900, 8)
    conditions = words(item.get('conditions', []), 'conditions', 8)
    methods, tasks = words(item.get('methods', []), 'methods'), words(item.get('tasks', []), 'tasks')
    negated, hedged = item.get('negated'), item.get('hedged')
    if type(negated) is not bool or type(hedged) is not bool:
        raise ValueError('模型必须显式标记否定和不确定性。')
    claim_id = 'citation-claim:' + contexts.digest(paper_id, source_version, relation, scope, contexts.normalize(statement),
                                                  sorted((target['reference_id'], target['role']) for target in selected), evidence)[:32]
    return {'id': claim_id, 'source_version': source_version, 'section': candidate['section'], 'relation': relation, 'scope': scope,
            'statement': statement, 'methods': methods, 'tasks': tasks, 'conditions': conditions, 'negated': negated, 'hedged': hedged,
            'targets': selected, 'evidence': evidence, 'generation': 'model', 'review_status': 'needs-review'}


def unresolved(frozen):
    values = {}
    labels = {target['number']: target['label'] for target in frozen['targets']}
    for candidate in frozen['candidates']:
        for mention in candidate['mentions']:
            for binding in mention['bindings']:
                if not binding['target_id']:
                    values[binding['id']] = {'surface': mention['surface'], 'parts': mention['parts'],
                                              'section': candidate['section'], 'reason': binding['binding'],
                                              'choices': binding['choices'], 'choice_count': binding['choice_count'],
                                              'alternatives': [labels[number] for number in binding['choices'] if number in labels]}
    return len(values), sorted(values.values(), key=lambda item: (item['parts'][0]['page'], item['parts'][0]['start']))[:60]


def target_identities(target):
    identities = {target['node_id'], target['reference_id'], target['id']}
    # Conflicting metadata stays bound to the local bibliography entry only.
    if target['binding'] not in ('conflicting-identifiers', 'version-conflict', 'ambiguous-catalog'):
        identities.update('doi:' + doi for doi in target['identifiers']['doi'])
        for arxiv in target['identifiers']['arxiv']:
            identities.add('arxiv:' + arxiv)
            identities.add('arxiv:' + contexts.arxiv_base(arxiv))
    return sorted(identities)


def commit(library, request):
    frozen = request['frozen']
    paper_id, scope, version = frozen['paper']['id'], frozen['scope'], frozen['source_version']
    outputs = request['outputs']
    if not isinstance(outputs, list) or len(outputs) > MAX_CLAIMS:
        raise ValueError('模型陈述超过本次保存预算。')
    candidates = {item['id']: item for item in frozen['candidates']}
    targets = {item['id']: item for item in frozen['targets']}
    claims = {}
    for item in outputs:
        claim = checked_claim(item, paper_id, version, candidates, targets)
        claims.setdefault(claim['id'], claim)
    unresolved_count, unresolved_examples = unresolved(frozen)
    now = datetime.now(timezone.utc).isoformat()
    result = {'paper_id': paper_id, 'scope': scope, 'fingerprint': frozen['fingerprint'], 'revision': contexts.digest(now, frozen['fingerprint']),
              'source_version': version, 'source_observed': frozen['source_observed'], 'bibliography_fingerprint': frozen['bibliography_fingerprint'],
              'coverage': {**frozen['coverage'], 'model_candidate_count': request['model_candidate_count'], 'unresolved_count': unresolved_count,
                           'truncated': frozen['coverage']['truncated'] or request['model_truncated']},
              'warnings': frozen['warnings'] + request['warnings'], 'unresolved': unresolved_examples, 'count': len(claims),
              'model': request['model'], 'saved_at': now, 'review_status': 'needs-review'}
    # Check the current body while holding the same lock as PDF/catalog writers.
    # The source may have gained a native annotation while the model was running.
    with library.lock():
        path = library.pdf_path(paper_id)
        current_observed = observed_file(path)
        if current_observed != frozen['source_observed'] and _current_version(library, paper_id) != version:
            raise ValueError('PDF 正文已变化，本次结果未保存。')
        result['source_observed'] = observed_file(path)
        if result['source_observed'] != current_observed:
            raise ValueError('PDF 在保存前变化，请重试。')
        previous = load_run(library, paper_id, scope)
        if (previous['revision'] if previous else None) != frozen['expected_revision']:
            if previous and previous['fingerprint'] == frozen['fingerprint'] and not request['force']:
                return {'reused': True, **previous}
            raise ValueError('其他请求已更新该范围，请重新读取。')
        if previous and previous['count'] and (not frozen['bibliography_fingerprint'] or
                                               (not claims and (result['coverage']['truncated'] or frozen['coverage']['pages_skipped']))):
            return {**result, 'saved': False, 'previous_retained': True}
        for sql in SCHEMA_SQL:
            library.db.execute(sql)
        if not previous and library.db.execute('SELECT count(*) FROM citation_claim_runs WHERE paper_id=?', (paper_id,)).fetchone()[0] >= 40:
            raise ValueError('单篇最多保存 40 个抽取范围，请使用已有范围。')
        library.db.execute('DELETE FROM citation_claim_targets WHERE paper_id=? AND scope=?', (paper_id, scope))
        library.db.execute('DELETE FROM citation_claim_rows WHERE paper_id=? AND scope=?', (paper_id, scope))
        for claim in claims.values():
            first = claim['evidence'][0]
            search = '\n'.join([claim['statement'], *claim['conditions'], *claim['methods'], *claim['tasks']])
            encoded = json.dumps(claim, ensure_ascii=False)
            if len(encoded.encode()) > MAX_CLAIM_BYTES:
                raise ValueError('单条引用描述超过保存预算，请缩小其引文范围。')
            library.db.execute('INSERT INTO citation_claim_rows VALUES(?,?,?,?,?,?,?,?,?,?)',
                               (paper_id, scope, claim['id'], first['page'], first['start'], claim['relation'], contexts.normalize(search),
                                '\n'.join(map(contexts.normalize, claim['methods'])), '\n'.join(map(contexts.normalize, claim['tasks'])),
                                encoded))
            keys = {key for target in claim['targets'] if target['role'] in ('subject', 'baseline') for key in target_identities(target)}
            library.db.executemany('INSERT INTO citation_claim_targets VALUES(?,?,?,?)', ((paper_id, scope, claim['id'], key) for key in keys))
        library.db.execute('INSERT INTO citation_claim_runs VALUES(?,?,?,?,?) ON CONFLICT(paper_id,scope) DO UPDATE SET fingerprint=excluded.fingerprint, revision=excluded.revision, value=excluded.value',
                           (paper_id, scope, frozen['fingerprint'], result['revision'], json.dumps(result, ensure_ascii=False)))
    return {**result, 'saved': True, 'reused': False}


def paper_status(library, paper_id, run):
    try:
        path = library.pdf_path(paper_id)
        if observed_file(path) == run['source_observed']:
            return 'current'
        return 'needs-source-check'
    except (ValueError, OSError, RuntimeError):
        return 'unavailable'


def status(library, request):
    paper_id = field(request.get('id'), 'id', 160, 1)
    library.get(paper_id)
    if not initialized(library):
        return {'paper_id': paper_id, 'runs': [], 'total': 0}
    rows = library.db.execute('SELECT value FROM citation_claim_runs WHERE paper_id=? ORDER BY json_extract(value,\'$.saved_at\') DESC LIMIT 8', (paper_id,)).fetchall()
    total = library.db.execute('SELECT count(*) FROM citation_claim_runs WHERE paper_id=?', (paper_id,)).fetchone()[0]
    runs = sorted((json.loads(row[0]) for row in rows), key=lambda row: row['saved_at'], reverse=True)
    # Scope summaries share the same attached file. Compute its identity once.
    current_version = None
    try:
        current_observed = observed_file(library.pdf_path(paper_id))
        current_version = next((run['source_version'] for run in runs if run['source_observed'] == current_observed), None)
        if runs and current_version is None:
            current_version = _current_version(library, paper_id)
    except (ValueError, OSError, RuntimeError):
        pass
    for run in runs:
        run['source_status'] = ('current' if run['source_version'] == current_version else 'stale') if current_version else 'unavailable'
    return {'paper_id': paper_id, 'runs': runs, 'total': total}


def verify_source(library, request):
    paper_id = field(request.get('id'), 'id', 160, 1)
    sha256 = field(request.get('sha256'), 'sha256', 64, 64)
    if not re.fullmatch(r'[a-f0-9]{64}', sha256):
        raise ValueError('来源版本无效。')
    if not initialized(library):
        return {'source_status': 'unavailable'}
    row = library.db.execute("SELECT value FROM citation_claim_runs WHERE paper_id=? AND json_extract(value,'$.source_version.sha256')=? LIMIT 1",
                             (paper_id, sha256)).fetchone()
    if not row:
        return {'source_status': 'unavailable'}
    run = json.loads(row[0])
    state = paper_status(library, paper_id, run)
    if state == 'needs-source-check':
        try:
            state = 'current' if _current_version(library, paper_id) == run['source_version'] else 'stale'
        except (ValueError, OSError, RuntimeError):
            state = 'unavailable'
    return {'source_status': state}


def search(library, request):
    limit = integer(request, 'limit', 12, 1, 24)
    offset = integer(request, 'offset', 0, 0, 1_000_000)
    clauses = ['p.id NOT IN (SELECT paper_id FROM paper_archive)']
    params = []
    for name, column, maximum in [('source_id', 'c.paper_id', 160), ('relation', 'c.relation', 30)]:
        if name in request:
            value = field(request[name], name, maximum, 1)
            if name == 'relation' and value not in RELATIONS:
                raise ValueError('引用描述关系无效。')
            clauses.append(f'{column}=?')
            params.append(value)
    for name, column in [('query', 'c.search'), ('method', 'c.methods'), ('task', 'c.tasks')]:
        if name in request:
            clauses.append(f'instr({column},?)>0')
            params.append(contexts.normalize(field(request[name], name, 200, 1)))
    if 'target_id' in request:
        target = field(request['target_id'], 'target_id', 330, 1)
        if target.lower().startswith(('doi:', 'arxiv:')):
            target = target.lower()
        identities = [target]
        # A DOI-only external entry can be found from a later-imported library
        # paper without rewriting the historical target binding in the claim.
        if not target.startswith(('doi:', 'arxiv:', 'reference:', 'bib:')):
            paper = library.get(target)
            doi = paper.get('DOI')
            if isinstance(doi, str) and doi:
                identities.append('doi:' + doi.lower())
            arxiv = contexts.consistent_arxiv(contexts.arxiv_fields(paper))
            if arxiv:
                identities.append('arxiv:' + arxiv)
        placeholders = ','.join('?' for _ in identities)
        clauses.append(f'EXISTS(SELECT 1 FROM citation_claim_targets t WHERE t.identity IN ({placeholders}) AND t.paper_id=c.paper_id AND t.scope=c.scope AND t.claim_id=c.id)')
        params.extend(identities)
    if request.get('individual_only', False) is True:
        clauses.append("json_extract(c.value,'$.scope')!='group'")
    empty = {'items': [], 'offset': offset, 'total': 0, 'next_offset': None}
    if not initialized(library):
        return empty
    where = ' AND '.join(clauses)
    with_query = f'''WITH matched AS (
        SELECT c.paper_id,c.scope,c.id,c.page,c.start,p.title,
        ROW_NUMBER() OVER(PARTITION BY c.id ORDER BY json_extract(r.value,'$.saved_at') DESC,c.scope) AS rank
        FROM citation_claim_rows c JOIN papers p ON p.id=c.paper_id
        JOIN citation_claim_runs r ON r.paper_id=c.paper_id AND r.scope=c.scope WHERE {where})'''
    # Both statements read one consistent index generation.
    library.db.execute('BEGIN')
    try:
        total = library.db.execute(with_query + ' SELECT count(*) FROM matched WHERE rank=1', params).fetchone()[0]
        rows = library.db.execute(with_query + ''' , selected AS (
            SELECT * FROM matched WHERE rank=1 ORDER BY paper_id,page,start,id LIMIT ? OFFSET ?)
            SELECT s.paper_id,s.title,c.value,r.value AS run_value
            FROM selected s JOIN citation_claim_rows c USING(paper_id,scope,id)
            JOIN citation_claim_runs r USING(paper_id,scope)
            ORDER BY s.paper_id,s.page,s.start,s.id''', [*params, limit, offset]).fetchall()
    finally:
        library.db.rollback()
    items, states, size = [], {}, 0
    for row in rows:
        claim, run = json.loads(row['value']), json.loads(row['run_value'])
        key = (row['paper_id'], run['revision'])
        if key not in states:
            states[key] = paper_status(library, row['paper_id'], run)
        item = {**claim, 'source': {'id': row['paper_id'], 'title': row['title'], 'status': states[key]},
                'bibliography_fingerprint': run['bibliography_fingerprint'], 'model': run['model'], 'saved_at': run['saved_at']}
        current = len(json.dumps(item, ensure_ascii=False).encode())
        if items and size + current > MAX_CLAIM_BYTES:
            break
        size += current
        items.append(item)
    return {**empty, 'items': items, 'total': total, 'next_offset': offset + len(items) if items and offset + len(items) < total else None}
