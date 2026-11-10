"""Synthetic native annotation range editing retains PDF identities and replies."""
import uuid
import pymupdf as fitz
import pytest
from dsh_paper_library.core import dispatch


def test_reselect_preserves_replies_and_external_objects(tmp_path):
    original = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((50, 80), 'Synthetic source sentence for questions.')
        external = page.add_text_annot((20, 30), 'External note'); external.update()
        doc.save(original)
    before = original.read_bytes()
    def call(action, **values): return dispatch({'library': str(tmp_path / 'lib'), 'action': action, **values})
    paper = call('import', path=str(original))['items'][0]['id']
    root = call('annotate', id=paper, page=1, type='underline', rects=[[50, 68, 100, 82]], text='Synthetic', comment='Keep comment')['annotation']
    reply = call('annotation_reply_create', id=paper, annotation_id=root['id'], reply_id=str(uuid.uuid4()), comment='Keep reply')['annotation']
    args = dict(id=paper, annotation_id=root['id'], page=1, rects=[[50, 68, 180, 82]], text='Synthetic source sentence', expected_version=root['edit_version'])
    updated = call('annotation_reselect', **args)['annotation']
    assert updated['id'] == root['id'] and updated['comment'] == 'Keep comment'
    assert updated['text'] == args['text'] and updated['rects'][0] == pytest.approx(args['rects'][0])
    listed = call('annotations', id=paper)['annotations']
    assert next(n for n in listed if n['id']==reply['id'])['reply_to'] == root['id']
    assert any(n['comment'] == 'External note' for n in listed)
    with pytest.raises(ValueError, match='ANNOTATION_STALE'): call('annotation_reselect', **args)
    with pytest.raises(ValueError, match='原批注所在页'): call('annotation_reselect', **{**args, 'expected_version': updated['edit_version'], 'page': 2})
    assert original.read_bytes() == before


def test_reselect_owned_note_retains_selected_region(tmp_path):
    original = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        doc.new_page(width=400,height=500); doc.save(original)
    def call(action, **values): return dispatch({'library':str(tmp_path/'lib'), 'action':action, **values})
    paper=call('import',path=str(original))['items'][0]['id']
    note=call('annotate',id=paper,page=1,type='note',rects=[[30,40,80,55]],text='Old',comment='Keep')['annotation']
    result=call('annotation_reselect',id=paper,annotation_id=note['id'],page=1,rects=[[50,60,150,75]],text='New',expected_version=note['edit_version'])['annotation']
    assert result['text']=='New' and result['rects'][0]==pytest.approx([50,60,150,75])
    assert next(n for n in call('annotations',id=paper)['annotations'] if n['id']==note['id'])['text']=='New'

@pytest.mark.parametrize('rotation', [90, 180, 270])
def test_reselect_rotated_markup(tmp_path, rotation):
    original = tmp_path / 'source.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=400, height=500)
        page.insert_text((50,80),'Synthetic rotated source')
        page.set_rotation(rotation)
        rect = list(fitz.Rect(50,68,180,82) * page.rotation_matrix)
        doc.save(original)
    def call(action, **values): return dispatch({'library':str(tmp_path/'lib'), 'action':action, **values})
    paper=call('import',path=str(original))['items'][0]['id']
    root=call('annotate',id=paper,page=1,type='underline',rects=[rect],text='Old')['annotation']
    saved=call('annotation_reselect',id=paper,annotation_id=root['id'],page=1,rects=[rect],text='Synthetic rotated source',expected_version=root['edit_version'])['annotation']
    assert saved['rects'][0] == pytest.approx(rect,abs=.01)
    listed=call('annotations',id=paper)['annotations'];assert next(x for x in listed if x['id']==root['id'])['text']=='Synthetic rotated source'
