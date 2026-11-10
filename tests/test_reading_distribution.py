"""Synthetic-only native reading-strip coverage; never touch a real library."""
import json
from types import SimpleNamespace

import pymupdf as fitz
import pytest

from dsh_paper_library import reading_distribution as rd
from dsh_paper_library.ai_annotation_style import AI_RGB, apply_ai_reading_style
from dsh_paper_library.core import Library, dispatch
from dsh_paper_library.pdf_write import PdfWrites
from dsh_paper_library.worker import dispatch_request


class ReadOnlyPaper:
    _open_pdf = staticmethod(PdfWrites._open_pdf)

    def __init__(self, path, has_pdf=True):
        self.path = path
        self.has_pdf = has_pdf
        self.calls = []

    def get(self, id):
        self.calls.append(('get', id))
        assert id == 'synthetic'
        return {'pdf': self.has_pdf}

    def pdf_path(self, id):
        self.calls.append(('path', id))
        assert id == 'synthetic'
        return self.path


def paper(tmp_path, pages=1, size=(400, 400)):
    path = tmp_path / 'synthetic.pdf'
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=size[0], height=size[1])
    return path, doc


def saved(path, doc):
    doc.save(path)
    doc.close()
    return ReadOnlyPaper(path)


def result(path, doc):
    return rd.read_distribution(saved(path, doc), 'synthetic')


def check_shape(value):
    assert value['bin_count'] == 96
    for name in ('other', 'ai_style'):
        assert len(value[name]['bins']) == 96
        assert all(type(n) is int and n >= 0 for n in value[name]['bins'])
        if value[name]['annotation_count'] is not None:
            assert sum(value[name]['bins']) == value[name]['annotation_count']
    assert len(json.dumps(value, allow_nan=False)) < 2500


def test_empty_pdf_is_measured_zero(tmp_path):
    path, doc = paper(tmp_path, 3)
    value = result(path, doc)
    check_shape(value)
    assert value['status'] == 'ready'
    assert value['page_count'] == value['coverage']['scanned_pages'] == 3
    assert value['total_marks'] == value['marked_pages'] == 0
    assert value['reason'] is None


def test_counts_only_root_text_marks_without_content_or_rendering(tmp_path, monkeypatch):
    path, doc = paper(tmp_path, 2)
    page = doc[0]
    parent = None
    for index, add in enumerate((page.add_highlight_annot, page.add_underline_annot,
                                 page.add_squiggly_annot, page.add_strikeout_annot)):
        annot = add(fitz.Rect(30, 20 + index * 50, 150, 40 + index * 50))
        annot.set_info(title='AI human claim', content='PRIVATE CONTENT MUST NEVER BE READ')
        annot.update()
        if parent is None:
            parent = annot.xref
    for kind in ('text', 'underline', 'nested', 'malformed'):
        annot = (page.add_text_annot((20, 250), 'PRIVATE') if kind == 'text' else
                 page.add_underline_annot(fitz.Rect(30, 250, 150, 270)))
        if kind == 'malformed':
            doc.xref_set_key(annot.xref, 'IRT', '(broken reference)')
        else:
            annot.set_irt_xref(parent)
            parent = annot.xref
    page.add_rect_annot(fitz.Rect(30, 300, 150, 350))
    page.add_ink_annot([[(30, 300), (150, 350)]])
    page.add_line_annot((30, 300), (150, 350))
    library = saved(path, doc)
    before = path.read_bytes()

    def forbidden(*args, **kwargs):
        raise AssertionError('No text, rendering, contents, vertex list or eager annotation list allowed')
    monkeypatch.setattr(fitz.Page, 'get_text', forbidden)
    monkeypatch.setattr(fitz.Page, 'get_pixmap', forbidden)
    monkeypatch.setattr(fitz.Page, 'annots', forbidden)
    monkeypatch.setattr(fitz.Annot, 'info', property(forbidden))
    monkeypatch.setattr(fitz.Annot, 'vertices', property(forbidden))
    value = rd.read_distribution(library, 'synthetic')
    check_shape(value)
    assert value['status'] == 'ready'
    assert value['total_marks'] == value['other']['annotation_count'] == 4
    assert value['marked_pages'] == value['other']['marked_pages'] == 1
    assert value['ai_style']['annotation_count'] == 0
    assert 'PRIVATE' not in json.dumps(value)
    assert 'human' not in json.dumps(value)
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]
    assert library.calls == [('get', 'synthetic'), ('path', 'synthetic')]


@pytest.mark.parametrize('variant', ['bs', 'legacy', 'indirect', 'rounded'])
def test_native_ai_style_classifier_and_ordinary_unknown_source(tmp_path, variant):
    path, doc = paper(tmp_path, 3)
    page = doc[0]
    ordinary = page.add_underline_annot(fitz.Rect(20, 20, 120, 40))
    ordinary.set_info(title='AI 自主阅读', content='AI reading')
    ordinary.set_colors(stroke=AI_RGB)
    ordinary.update()  # Blue solid is ordinary despite a self-claimed AI author.
    ai = page.add_underline_annot(fitz.Rect(20, 80, 120, 100))
    apply_ai_reading_style(doc, ai)
    ai.set_info(title='Human', content='This does not prove an author')
    if variant == 'legacy':
        doc.xref_set_key(ai.xref, 'BS', 'null')
        doc.xref_set_key(ai.xref, 'Border', '[0 0 1 [3 2]]')
    elif variant == 'indirect':
        xref = doc.get_new_xref()
        doc.update_object(xref, '<< /S /D /D [3 2] /W 1 >>')
        doc.xref_set_key(ai.xref, 'BS', f'{xref} 0 R')
    elif variant == 'rounded':
        doc.xref_set_key(ai.xref, 'C', '[0.19 0.50 0.93]')
    child = page.add_strikeout_annot(fitz.Rect(20, 150, 120, 170))
    apply_ai_reading_style(doc, child)
    child.set_irt_xref(ai.xref)
    page = doc[2]
    ai = page.add_strikeout_annot(fitz.Rect(20, 80, 120, 100))
    apply_ai_reading_style(doc, ai)
    rect = page.add_rect_annot(fitz.Rect(20, 180, 120, 200))
    apply_ai_reading_style(doc, rect)  # AI square is not a text-mark progress unit.
    value = result(path, doc)
    check_shape(value)
    assert value['status'] == 'ready'
    assert value['total_marks'] == 3
    assert value['other']['annotation_count'] == 1
    assert value['ai_style']['annotation_count'] == 2
    assert value['other']['marked_pages'] == 1
    assert value['ai_style']['marked_pages'] == value['marked_pages'] == 2


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_real_native_page_dimensions_crop_and_rotation(tmp_path, rotation):
    path, doc = paper(tmp_path, size=(600, 1000))
    page = doc[0]
    page.set_cropbox(fitz.Rect(50, 100, 550, 900))
    mark = page.add_underline_annot(fitz.Rect(100, 200, 200, 240))
    page.set_rotation(rotation)
    center = (mark.rect * page.rotation_matrix).tl + (mark.rect * page.rotation_matrix).br
    expected = int((center.y / 2 - page.rect.y0) / page.rect.height * 96)
    value = result(path, doc)
    assert value['status'] == 'ready'
    assert value['other']['bins'][expected] == 1
    assert sum(value['other']['bins']) == 1


def test_sparse_dense_equal_page_normalization_and_multiline_single_unit(tmp_path):
    path, doc = paper(tmp_path, 3)
    page = doc[0]
    page.add_highlight_annot([fitz.Rect(20, 30, 100, 50), fitz.Rect(20, 80, 150, 100)])
    page = doc[2]
    page.set_mediabox(fitz.Rect(0, 0, 800, 1600))
    for _ in range(100):
        page.add_underline_annot(fitz.Rect(20, 1100, 150, 1120))
    value = result(path, doc)
    check_shape(value)
    assert value['status'] == 'ready'
    assert value['total_marks'] == 101
    assert value['marked_pages'] == 2
    assert max(value['other']['bins']) == 100
    assert sum(value['other']['bins'][:32]) == 1
    assert sum(value['other']['bins'][32:64]) == 0
    assert sum(value['other']['bins'][64:]) == 100


@pytest.mark.parametrize('kind', ['no_pdf', 'missing', 'invalid', 'encrypted', 'empty_password'])
def test_unavailable_data_is_null_not_zero(tmp_path, kind):
    path = tmp_path / 'missing.pdf'
    library = ReadOnlyPaper(path, has_pdf=kind != 'no_pdf')
    if kind == 'invalid':
        path.write_bytes(b'This is not a PDF')
    elif kind in {'encrypted', 'empty_password'}:
        with fitz.open() as doc:
            doc.new_page()
            doc.save(path, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='owner',
                     user_pw='reader' if kind == 'encrypted' else '')
    value = rd.read_distribution(library, 'synthetic')
    check_shape(value)
    assert value['status'] == 'unknown'
    assert value['reason']
    assert value['total_marks'] is value['marked_pages'] is value['page_count'] is None
    assert value['other']['annotation_count'] is value['ai_style']['annotation_count'] is None
    if kind == 'no_pdf':
        assert value['reason'] == 'no_pdf'
        assert library.calls == [('get', 'synthetic')]


def test_page_limit_returns_unknown_before_scanning(tmp_path):
    path, doc = paper(tmp_path, 2001)
    value = result(path, doc)
    assert value['status'] == 'unknown'
    assert value['reason'] == 'page_limit'
    assert value['coverage']['scanned_pages'] == 0
    assert value['total_marks'] is None


@pytest.mark.parametrize('count,expected_status', [(3, 'ready'), (4, 'partial')])
def test_annotation_limit_is_explicit_and_exact_boundary_ready(tmp_path, monkeypatch, count, expected_status):
    monkeypatch.setattr(rd, 'MAX_ANNOTATIONS', 3)
    path, doc = paper(tmp_path)
    page = doc[0]
    for _ in range(count):
        page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
    value = result(path, doc)
    assert value['status'] == expected_status
    assert value['total_marks'] == 3
    assert value['coverage']['scanned_annotations'] == 3
    assert value['limits']['annotations'] == 3
    assert ('annotation_limit' in value['reasons']) == (count > 3)


def test_ignored_annotations_also_spend_scan_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(rd, 'MAX_ANNOTATIONS', 3)
    path, doc = paper(tmp_path)
    page = doc[0]
    root = page.add_text_annot((20, 20), 'ignored')
    for _ in range(2):
        reply = page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
        reply.set_irt_xref(root.xref)
    page.add_underline_annot(fitz.Rect(20, 200, 150, 220))
    value = result(path, doc)
    assert value['status'] == 'partial'
    assert value['reason'] == 'annotation_limit'
    assert value['total_marks'] == 0  # Explicitly only the observed lower bound.
    assert value['coverage']['scanned_annotations'] == 3


def test_small_page_budget_preserves_full_document_positions(tmp_path, monkeypatch):
    monkeypatch.setattr(rd, 'MAX_PAGES', 2)
    path, doc = paper(tmp_path, 3)
    page = doc[1]
    page.add_underline_annot(fitz.Rect(20, 200, 150, 220))
    value = result(path, doc)
    assert value['status'] == 'partial'
    assert value['reason'] == 'page_limit'
    assert value['page_count'] == 3
    assert value['coverage']['scanned_pages'] == 2
    assert sum(value['other']['bins'][32:64]) == 1
    assert sum(value['other']['bins'][64:]) == 0


def test_bad_geometry_is_partial_without_fabricated_midpoint(tmp_path):
    path, doc = paper(tmp_path)
    page = doc[0]
    page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
    bad = page.add_underline_annot(fitz.Rect(20, 200, 150, 220))
    doc.xref_set_key(bad.xref, 'Rect', '[0 0 0 0]')
    doc.xref_set_key(bad.xref, 'QuadPoints', 'null')
    value = result(path, doc)
    assert value['status'] == 'partial'
    assert value['reason'] == 'invalid_annotation'
    assert value['total_marks'] == 1
    assert value['coverage']['skipped_marks'] == 1


def test_native_read_failure_and_cycle_are_bounded(monkeypatch):
    monkeypatch.setattr(rd, 'MAX_ANNOTATIONS', 3)
    annot = SimpleNamespace(type=(9, 'Underline'), xref=1, rect=fitz.Rect(20, 20, 60, 40))
    annot.next = annot
    page = SimpleNamespace(first_annot=annot, rect=fitz.Rect(0, 0, 100, 100), rotation_matrix=fitz.Matrix(1, 1))
    class Doc:
        page_count = 2
        is_repaired = False
        def __getitem__(self, i):
            if i == 0:
                raise RuntimeError('Unreadable page')
            return page
        def xref_get_key(self, *args):
            return ('null', 'null')
    monkeypatch.setattr(rd, 'native_style', lambda a: {'ai_reading_style': False})
    value = rd._scan(Doc())
    assert value['status'] == 'partial'
    assert value['reasons'] == ['page_read_error', 'invalid_annotation']
    assert value['coverage']['scanned_annotations'] == 1
    assert value['total_marks'] == 1
    assert value['coverage']['scanned_pages'] == 0


def test_style_failure_stays_other_unknown_source(tmp_path, monkeypatch):
    path, doc = paper(tmp_path)
    page = doc[0]
    page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
    def broken(annot):
        raise RuntimeError('Malformed style object')
    monkeypatch.setattr(rd, 'native_style', broken)
    value = result(path, doc)
    assert value['status'] == 'partial'
    assert value['reason'] == 'style_unavailable'
    assert value['other']['annotation_count'] == value['total_marks'] == 1
    assert value['ai_style']['annotation_count'] == 0


def test_file_changed_during_read_discards_snapshot(tmp_path, monkeypatch):
    path, doc = paper(tmp_path)
    library = saved(path, doc)
    fingerprints = iter([('old',), ('new',)])
    monkeypatch.setattr(rd, '_fingerprint', lambda p: next(fingerprints))
    value = rd.read_distribution(library, 'synthetic')
    assert value['status'] == 'unknown'
    assert value['reason'] == 'pdf_changed'
    assert value['total_marks'] is None


def test_no_cache_keeps_external_native_changes_visible(tmp_path):
    path, doc = paper(tmp_path)
    library = saved(path, doc)
    assert rd.read_distribution(library, 'synthetic')['total_marks'] == 0
    with fitz.open(path) as doc:
        page = doc[0]
        page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
        doc.saveIncr()
    assert rd.read_distribution(library, 'synthetic')['total_marks'] == 1


def test_library_and_worker_dispatch_integration(tmp_path):
    path, doc = paper(tmp_path)
    page = doc[0]
    page.add_underline_annot(fitz.Rect(20, 100, 150, 120))
    saved(path, doc)
    root = str(tmp_path / 'library')
    item = dispatch({'library': root, 'action': 'import', 'path': str(path)})['items'][0]
    request = {'library': root, 'action': 'reading_distribution', 'id': item['id']}
    value = dispatch_request(request)
    assert value['status'] == 'ready'
    assert value['total_marks'] == 1
    library = Library(root)
    try:
        assert library.reading_distribution(item['id']) == value
    finally:
        library.close()
    missing = dispatch({'library': root, 'action': 'create', 'metadata': {'title': 'No attached PDF'}})
    missing_id = missing.get('id') or missing['item']['id']
    assert dispatch_request({**request, 'id': missing_id})['status'] == 'unknown'
    with pytest.raises(ValueError, match='not found'):
        dispatch_request({**request, 'id': 'absent'})
    dispatch({'library': root, 'action': 'archive', 'id': item['id']})
    with pytest.raises(ValueError, match='archived'):
        dispatch_request(request)
