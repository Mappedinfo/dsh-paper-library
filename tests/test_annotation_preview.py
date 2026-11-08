"""只使用合成页验证原生矩形截图的坐标、预算和只读边界。"""
import base64
import hashlib
import pymupdf as fitz
import pytest
from dsh_paper_library.core import dispatch


def request(tmp_path, action, **kwargs):
    return dispatch({'library':str(tmp_path/'library'),'action':action,**kwargs})


@pytest.mark.parametrize('rotation',[0,90,180,270])
def test_rectangle_crop_is_the_native_region_and_read_only(tmp_path,rotation):
    source=tmp_path/'source.pdf'
    with fitz.open() as doc:
        p=doc.new_page(width=500,height=600)
        p.draw_rect(fitz.Rect(90,120,210,220),fill=(1,0,0),color=(1,0,0))
        p.draw_rect(fitz.Rect(300,300,400,400),fill=(0,0,1),color=(0,0,1))
        p.set_cropbox(fitz.Rect(30,40,470,560));p.set_rotation(rotation);doc.save(source)
        rect=list(fitz.Rect(65,85,175,175)*p.rotation_matrix)
    paper=request(tmp_path,'import',path=str(source))['items'][0]
    note=request(tmp_path,'annotate',id=paper['id'],page=1,type='square',rects=[rect],comment='',color='#00ff00',width=8)['annotation']
    managed=next((tmp_path/'library').rglob('*.pdf'))
    before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [source,managed]}
    result=request(tmp_path,'annotation_preview',id=paper['id'],page=1,annotation_id=note['id'])
    pix=fitz.Pixmap(base64.b64decode(result['image']))
    assert pix.pixel(pix.width//2,pix.height//2)==(255,0,0)
    assert pix.width*pix.height<=303000 and max(pix.width,pix.height)<=642
    assert result['annotation_id']==note['id'] and result['mime_type']=='image/png'
    assert result['rect']==pytest.approx(note['rect'],abs=.001)
    assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [source,managed]}


def test_missing_wrong_kind_and_unbounded_sizes_are_rejected(tmp_path):
    source=tmp_path/'source.pdf'
    with fitz.open() as doc:
        doc.new_page();doc.save(source)
    paper=request(tmp_path,'import',path=str(source))['items'][0]
    note=request(tmp_path,'annotate',id=paper['id'],page=1,type='note',comment='Synthetic note')['annotation']
    with pytest.raises(ValueError,match='Only rectangle'):
        request(tmp_path,'annotation_preview',id=paper['id'],page=1,annotation_id=note['id'])
    with pytest.raises(ValueError,match='missing'):
        request(tmp_path,'annotation_preview',id=paper['id'],page=1,annotation_id='missing')
    for width in [0,641,float('nan'),True]:
        with pytest.raises(ValueError,match='width'):
            request(tmp_path,'annotation_preview',id=paper['id'],page=1,annotation_id=note['id'],render_width=width)
