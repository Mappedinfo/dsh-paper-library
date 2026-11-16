"""文内定位仅使用合成 PDF。"""
from contextlib import closing
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
    assert result['matches'][0]['snippet'] == 'Synthetic directionality example'
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


def test_batched_index_skips_non_candidates_and_expired_pages_are_rebuilt(tmp_path, monkeypatch):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        header = doc.new_page()
        header.insert_text((40, 80), "1 Introduction", fontname="hebo", fontsize=16)
        doc.new_page()
        page = doc.new_page()
        page.insert_text((40, 80), "Cat cat catalogue and international\nresearch")
        doc.save(source)
    with closing(Library(tmp_path / "lib")) as library:
        item = library.attach(library.create({"title": "Synthetic"})["id"], str(source))
        path = library.pdf_path(item["id"])
        request = {"library": str(library.root), "id": item["id"], "action": "paper_text_find",
                   "page_limit": 16, "include_sections": True}

        def call(query, **options):
            return dispatch_request({**request, "query": query, **options})

        cold = call("cat")
        assert [row["page"] for row in cold["page_results"]] == [1, 2, 3]
        assert cold["page_results"][1]["no_extractable_text"]
        assert cold["page_results"][0]["section_context"]["last"]["title"] == "1 Introduction"
        original = fitz.Page.get_textpage
        reads = []

        def track(page, *args, **kwargs):
            reads.append(page.number + 1)
            return original(page, *args, **kwargs)

        monkeypatch.setattr(fitz.Page, "get_textpage", track)
        assert call("cat") == cold
        assert reads == [3]
        assert [row["page_matches"] for row in call("research")["page_results"]] == [0, 0, 1]
        joined = call("international research")["page_results"][-1]
        single = dispatch_request({k: v for k, v in request.items() if k != "page_limit"} |
                                  {"query": "international research", "page": 3})
        assert joined["matches"] == single["matches"]
        assert joined["matches"]
        assert [row["page_matches"] for row in call("cat", match="whole", case_sensitive=True)["page_results"]] == [0, 0, 1]
        with fitz.open(path) as doc:
            doc[0].insert_text((40, 130), "The newly matching word")
            doc.saveIncr()
        with pytest.raises(ValueError, match="PAPER_RETRIEVAL_CHANGED"):
            call("newly", expected_version=cold["source_version"])
        fresh = call("newly")
        assert fresh["source_version"] != cold["source_version"]
        assert [row["page_matches"] for row in fresh["page_results"]] == [1, 0, 0]


def test_batch_continuation_respects_one_hit_budget_across_pages(tmp_path):
    source = tmp_path / "synthetic.pdf"
    with fitz.open() as doc:
        for count in (5, 1, 2):
            page = doc.new_page()
            for i in range(count):
                page.insert_text((40, 40 + i * 30), "needle context")
        doc.save(source)
    with closing(Library(tmp_path / "lib")) as library:
        item = library.attach(library.create({"title": "Synthetic"})["id"], str(source))
    request = {"library": str(tmp_path / "lib"), "id": item["id"], "action": "paper_text_find",
               "query": "needle", "page_limit": 3, "limit": 3}
    first = dispatch_request(request)["page_results"]
    assert [(row["page"], len(row["matches"]), row["next_offset"]) for row in first] == [(1, 3, 3)]
    second = dispatch_request({**request, "offset": 3})["page_results"]
    assert [(row["page"], len(row["matches"]), row["next_offset"]) for row in second] == [(1, 2, None), (2, 1, None)]
    last = dispatch_request({**request, "page": second[-1]["next_page"]})["page_results"]
    assert [(row["page"], len(row["matches"]), row["next_page"]) for row in last] == [(3, 2, None)]
