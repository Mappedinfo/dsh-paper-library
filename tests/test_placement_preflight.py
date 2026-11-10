"""Synthetic PDFs only; no live library, model or annotation writes."""
import copy
import hashlib

import pymupdf
import pytest

from dsh_paper_library.placement_preflight import preflight


@pytest.fixture
def case(tmp_path):
    path = tmp_path / 'synthetic.pdf'
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 50), 'Training uses synthetic examples only.')
        page.insert_text((50, 80), 'Repeated sample phrase appears here.')
        page.insert_text((50, 110), 'Repeated sample phrase appears here.')
        page.insert_text((50, 200), 'Mixed case anchor example text.')
        page.insert_text((50, 230), 'MIXED CASE ANCHOR EXAMPLE TEXT.')
        page.insert_text((50, 140), 'A uniquely wrapped statement explains')
        page.insert_text((50, 155), 'the evaluation procedure in detail.')
        doc.save(path)
    def ref(quote):
        with pymupdf.open(path) as doc:
            quads = [[v for p in q for v in p] for q in doc[0].search_for(quote, quads=True)]
        return dict(source_id='paper', version='v1', sha256=hashlib.sha256(path.read_bytes()).hexdigest(), page=1, quote=quote, quads=quads)
    anchor = ref('Training uses synthetic examples only.')
    entry = dict(id='one', question_id='use', question='How is this data used?', answer='It is used for training.', scope=dict(source_id='paper', version='v1', entity='synthetic examples', use='train'), status='evidence', anchor=anchor, evidence=[anchor], review=dict(reviewer='synthetic reviewer', rationale='This sentence specifies the training role.', most_relevant_local_evidence=True))
    plan = dict(schema='question-placement-v1', questions={'use': entry['question']}, entries=[entry])
    return plan, {'paper': str(path)}, ref


def codes(report):
    return {e['code'] for e in report['errors']}


def test_valid_is_read_only_and_not_semantic_certification(case):
    plan, sources, _ = case
    path = next(iter(sources.values()))
    before = open(path, 'rb').read()
    report = preflight(plan, sources)
    assert report['ok']
    assert report['semantic_validation'] == 'reviewer-attestation-only'
    assert report['write_authorized'] is False
    assert len(report['coverage']['use']['evidence']) == 1
    assert open(path, 'rb').read() == before


@pytest.mark.parametrize('field,value,code', [
    ('sha256', 'stale', 'stale_pdf'),
    ('page', 0, 'invalid_page_or_page_budget'),
    ('page', True, 'invalid_page_or_page_budget'),
    ('quote', 'This sentence is not in the document.', 'anchor_unmatched'),
    ('quads', [], 'quad_mismatch'),
    ('version', 'v2', 'cross_source_or_version_split_required'),
    ('source_id', 'other', 'cross_source_or_version_split_required'),
])
def test_bad_reference_rejected(case, field, value, code):
    plan, sources, _ = case
    plan['entries'][0]['anchor'][field] = value
    assert code in codes(preflight(plan, sources))


def test_repeated_occurrences_rejected_even_with_all_real_quads(case):
    plan, sources, ref = case
    anchor = ref('Repeated sample phrase appears here.')
    assert len(anchor['quads']) == 2
    plan['entries'][0].update(anchor=anchor, evidence=[anchor])
    assert 'anchor_ambiguous' in codes(preflight(plan, sources))


def test_one_wrapped_occurrence_allows_multiple_quads(case):
    plan, sources, ref = case
    anchor = ref('A uniquely wrapped statement explains the evaluation procedure in detail.')
    assert len(anchor['quads']) == 2
    plan['entries'][0].update(anchor=anchor, evidence=[anchor])
    assert preflight(plan, sources)['ok']


def test_unanchored_is_accounted_but_not_evidence(case):
    plan, sources, _ = case
    plan['entries'][0].update(status='unanchored', anchor=None, evidence=[], reason='No relevant passage in the inspected scope.')
    report = preflight(plan, sources)
    assert report['ok']
    assert not report['coverage']['use']['evidence']
    assert report['coverage']['use']['unanchored']


def test_context_is_not_evidence(case):
    plan, sources, _ = case
    plan['entries'][0].update(status='context-not-evidence', evidence=[], reason='Reading navigation only.')
    report = preflight(plan, sources)
    assert report['ok']
    assert not report['coverage']['use']['evidence']
    assert report['coverage']['use']['context']


def test_missing_questions_not_hidden_by_annotation_count(case):
    plan, sources, _ = case
    plan['questions']['scope'] = 'What is the sampling scope?'
    assert 'question_not_accounted_for:scope' in codes(preflight(plan, sources))


def test_one_atomic_question_per_entry(case):
    plan, sources, _ = case
    plan['entries'][0]['question_id'] = ['use', 'scope']
    assert 'unknown_or_non_atomic_question' in codes(preflight(plan, sources))


def test_duplicate_scope_rejected(case):
    plan, sources, _ = case
    second = copy.deepcopy(plan['entries'][0])
    second['id'] = 'two'
    plan['entries'].append(second)
    assert 'duplicate_question_scope' in codes(preflight(plan, sources))


def test_same_local_evidence_independent_questions_allowed(case):
    plan, sources, _ = case
    second = copy.deepcopy(plan['entries'][0])
    second.update(id='two', question_id='kind', question='Are the examples synthetic?')
    second['review']['rationale'] = 'The same local sentence says synthetic.'
    plan['questions']['kind'] = second['question']
    plan['entries'].append(second)
    assert preflight(plan, sources)['ok']


def test_review_required(case):
    plan, sources, _ = case
    plan['entries'][0].pop('review')
    assert 'semantic_review_required' in codes(preflight(plan, sources))


def test_primary_anchor_must_be_answer_evidence(case):
    plan, sources, _ = case
    plan['entries'][0]['evidence'] = []
    assert 'anchor_is_not_answer_evidence' in codes(preflight(plan, sources))


def test_wrong_question_text_rejected(case):
    plan, sources, _ = case
    plan['entries'][0]['question'] = 'Unrelated question'
    assert 'question_text_mismatch' in codes(preflight(plan, sources))


def test_nonfinite_quad_rejected(case):
    plan, sources, _ = case
    plan['entries'][0]['anchor']['quads'][0][0] = float('nan')
    assert 'quad_mismatch' in codes(preflight(plan, sources))


def test_malformed_schema_fails_closed(case):
    _, sources, _ = case
    assert not preflight([], sources)['ok']
    assert not preflight({'schema': 'legacy'}, sources)['ok']


def test_case_insensitive_search_does_not_collect_another_occurrence(case):
    plan, sources, ref = case
    anchor = ref('Mixed case anchor example text.')
    assert len(anchor['quads']) == 2
    plan['entries'][0].update(anchor=anchor, evidence=[anchor])
    assert 'anchor_search_ambiguous' in codes(preflight(plan, sources))
