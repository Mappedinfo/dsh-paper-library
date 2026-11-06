"""持久翻译只用合成 PDF，核对来源、去重和文件可携带性。"""
import hashlib
import pymupdf
import pytest
from test_annotation_references import prepare, refs


def test_translation_reply_survives_reimport_and_keeps_source(tmp_path):
    library, item = prepare(tmp_path, count=1, comment='The estimate remains uncertain.')
    try:
        ref = refs(library.annotation_catalog(item['id']))[0]
        key = hashlib.sha256(b'translation').hexdigest()
        assert not library.annotation_translation_result(item['id'], ref, key)['saved']
        result = library.annotation_translation_result(item['id'], ref, key, '该估计仍有不确定性。', 'synthetic/model')
        assert result['saved'] and not result['duplicate']
        note = result['annotation']
        assert note['comment'].startswith('翻译：')
        assert note['reply_to'] == ref['id']
        assert note['source_kind'] == 'annotation-translation'
        again = library.annotation_translation_result(item['id'], ref, key, '不应重复写入', 'synthetic/model')
        assert again['duplicate'] and again['annotation']['id'] == note['id']
        assert refs(library.annotation_catalog(item['id'])) == [ref]
        exported = tmp_path / 'exported.pdf'
        exported.write_bytes(library.pdf_path(item['id']).read_bytes())
        with pymupdf.open(exported) as doc:
            assert sum(1 for page in doc for a in page.annots() or [] if a.info['content'].startswith('翻译：')) == 1
        from dsh_paper_library.core import Library
        second = Library(tmp_path / 'second')
        try:
            imported = second.import_items(path=str(exported))['items'][0]
            restored = next(a for a in second.annotations(imported['id'])['annotations'] if a.get('source_kind') == 'annotation-translation')
            assert restored['reply_to'] == ref['id']
            assert restored['comment'] == note['comment']
        finally: second.close()
        library.annotation_update(item['id'], ref['id'], comment='Changed source')
        with pytest.raises(ValueError, match='STALE'):
            library.annotation_translation_result(item['id'], ref, key, '过期译文', 'synthetic/model')
    finally: library.close()
