"""文内定位仅使用合成 PDF，不渲染、不写文件。"""
import hashlib
import pymupdf as fitz
import pytest
from dsh_paper_library.core import Library
from dsh_paper_library.worker import dispatch_request

@pytest.mark.parametrize('rotation', [0,90,180,270])
def test_find_rotated_pages_and_continuation(tmp_path, rotation, monkeypatch):
    source=tmp_path/'synthetic.pdf'
    with fitz.open() as doc:
        page=doc.new_page(width=400,height=500)
        for y in range(40,400,20):
            page.insert_text((40,y),'Synthetic directionality example')
        page.set_rotation(rotation)
        doc.new_page()
        doc.save(source)
    library=Library(tmp_path/'lib')
    item=library.create({'title':'Synthetic find'})
    item=library.attach(item['id'],str(source))
    path=library.pdf_path(item['id']);before=hashlib.sha256(path.read_bytes()).hexdigest()
    def forbidden(*args,**kwargs):raise AssertionError('Search must not rasterize')
    monkeypatch.setattr(fitz.Page,'get_pixmap',forbidden)
    def call(**args):return dispatch_request({'library':str(library.root),'id':item['id'],'action':'paper_text_find',**args})
    result=call(query='direction\u00adality',page=1,limit=5)
    assert len(result['matches'])==5 and result['next_offset']==5
    assert result['page_matches']==18 and result['next_page']==2
    with fitz.open(path) as doc:
        expected=doc[0].search_for('directionality')[0]*doc[0].rotation_matrix
        assert result['matches'][0]['rects'][0]==pytest.approx(list(expected))
    rest=call(query='DIRECTIONALITY',page=1,offset=5)
    assert len(rest['matches'])==13 and rest['next_offset'] is None
    empty=call(query='example',page=2)
    assert empty['no_extractable_text'] and not empty['matches'] and empty['next_page'] is None
    for args in [{'query':''},{'query':'x','page':3},{'query':'x','limit':101},{'query':'x','offset':-1}]:
        with pytest.raises(ValueError):call(**args)
    assert before==hashlib.sha256(path.read_bytes()).hexdigest()
    library.close()

def test_find_matching_options(tmp_path):
    source = tmp_path / 'synthetic.pdf'
    with fitz.open() as doc:
        page = doc.new_page()
        page.insert_text((40, 80), 'Cat cat catalogue cat.')
        doc.save(source)
    library = Library(tmp_path / 'lib')
    item = library.attach(library.create({'title': 'Synthetic'})['id'], str(source))
    def call(**args):
        return dispatch_request({'library': str(library.root), 'id': item['id'], 'action': 'paper_text_find', 'query': 'cat', **args})
    assert call(match='whole')['page_matches'] == 3
    assert call(match='whole', case_sensitive=True)['page_matches'] == 2
    assert call(match='partial', case_sensitive=True)['page_matches'] == 3
    assert call()['page_matches'] == 4
    assert call(match='whole')['matches'][0]['rects']
    with pytest.raises(ValueError):
        call(match='invalid')
    library.close()
