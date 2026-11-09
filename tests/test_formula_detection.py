"""参考文献、跨页与分式裁剪的合成回归，不读取私人文献。"""
import pymupdf as fitz
import pytest
from dsh_paper_library import formula_detection as rules
from dsh_paper_library import document_elements as elements
from dsh_paper_library.core import Library


@pytest.mark.parametrize('text', [
    'ageNet_ICCV_2021_paper.html?ref=',
    'https://example.org/content/paper?id=123',
    '558-567. Available from: https://example.org/a?ref=x',
    'doi:10.1234/synthetic=2021',
    'Smith, J., 2021. A study of x=y (12)',
    'We set x = 1 in the experiment and evaluate several different models (3)',
])
def test_reject_non_equations(text):
    assert not rules.is_formula(text, math_font=True)


@pytest.mark.parametrize('text,font', [('y = a*x + b (1)', False), ('f(x) = a + b (13)', False), ('a = b', False), ('x² ≤ y² (A.2)', False), ('f(x) ¼ x', True)])
def test_math_evidence(text,font):
    assert rules.is_formula(text,font)


def create_library(tmp_path):
    path=tmp_path/'synthetic.pdf'
    with fitz.open() as doc:
        page=doc.new_page()
        page.insert_text((60,80),'Methods')
        page.insert_text((100,130),'y = x + 1 (1)')
        page.insert_text((60,200),'References')
        page.insert_text((60,230),'Smith, J., 2021. A study of x=y (12)')
        page.insert_text((60,260),'https://example.org/paper.html?ref=')
        page=doc.new_page()
        page.insert_text((60,80),'x = y (99)')  # 引用标题不是正文公式
        page.insert_text((60,120),'ageNet_ICCV_2021_paper.html?ref=')
        page=doc.new_page()
        page.insert_text((60,80),'Appendix A. Derivation')
        page.insert_text((100,130),'z = x + y (A.1)')
        doc.save(path)
    library=Library(tmp_path/'library')
    paper=library.create({'title':'Synthetic reference boundaries'})
    paper=library.attach(paper['id'],str(path))
    return library,paper['id']


def scan(lib,id,**kwargs):
    return elements.dispatch(lib,dict(action='document_elements_scan',id=id,**kwargs))


def formulas(lib,id):
    return elements.dispatch(lib,dict(action='document_elements_list',id=id,kind='formula'))['elements']


def test_reference_state_across_batches_and_appendix(tmp_path):
    lib,id=create_library(tmp_path)
    try:
        for _ in range(3): scan(lib,id,limit=1)
        assert [v['page'] for v in formulas(lib,id)]==[1,3]
    finally: lib.close()


def test_out_of_order_page_is_revisited_without_extra_page_reads(tmp_path,monkeypatch):
    lib,id=create_library(tmp_path)
    calls=[]
    original=elements._preflight_page
    def track(doc,n): calls.append(n);return original(doc,n)
    monkeypatch.setattr(elements,'_preflight_page',track)
    try:
        result=scan(lib,id,start_page=2,limit=1)
        assert calls==[2] and not result['coverage']['complete']
        assert not formulas(lib,id)
        scan(lib,id,limit=3)
        assert calls==[2,1,2,3]
        assert [v['page'] for v in formulas(lib,id)]==[1,3]
        assert scan(lib,id)['coverage']['complete']
    finally:lib.close()


def test_two_columns_do_not_hide_body_equation():
    with fitz.open() as doc:
        p=doc.new_page(width=600,height=800)
        for x,y,t in [(40,70,'Methods'),(60,140,'x = y (1)'),(340,80,'References'),(340,110,'x = y (2)')]:p.insert_text((x,y),t)
        values,_=elements._extract(p,'synthetic')
        assert [v['title'] for v in values if v['kind']=='formula']==['公式 (1)']


def test_superscript_crop_expands_but_not_definition():
    with fitz.open() as doc:
        p=doc.new_page()
        # 插入一个文本块的分式片段和相邻自然语言定义。
        p.insert_text((100,120),'x = a\nb\nwhere b denotes denominator.',fontsize=11)
        values,_=elements._extract(p,'synthetic')
        v=next(v for v in values if v['kind']=='formula')
        lines=elements._lines(p)
        denominator=next(l for l in lines if l['text']=='b')
        definition=next(l for l in lines if l['text'].startswith('where'))
        assert 'b' in v['text'].splitlines()
        assert v['rect'][3] >= denominator['rect'].y1 - .01
        assert v['rect'][3] <= definition['rect'].y0 + .01


def test_legacy_index_is_not_reused(tmp_path):
    lib,id=create_library(tmp_path)
    try:
        scan(lib,id,limit=3)
        lib.db.execute("UPDATE document_element_pages SET version=replace(version,'document-elements-v3','document-elements-v2')")
        lib.db.execute("UPDATE document_elements SET version=replace(version,'document-elements-v3','document-elements-v2')")
        result=scan(lib,id,limit=1)
        assert result['scanned_batch']==[1] and not result['coverage']['complete']
        assert all(v['page']==1 for v in formulas(lib,id))
    finally:lib.close()


def test_adjacent_numbered_equations_stay_separate():
    with fitz.open() as doc:
        p=doc.new_page()
        p.insert_text((100,120),'x = a (1)\ny = b (2)',fontsize=11)
        values,_=elements._extract(p,'synthetic')
        formulas=[v for v in values if v['kind']=='formula']
        assert [v['title'] for v in formulas]==['公式 (1)','公式 (2)']
        assert '(2)' not in formulas[0]['text']
        assert '(1)' not in formulas[1]['text']
