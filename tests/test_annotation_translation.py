"""持久翻译只用合成 PDF，核对来源、去重和文件可携带性。"""
import hashlib
import json
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


def test_translation_warning_tracks_original_selection_per_reply(tmp_path):
    library, item = prepare(tmp_path, count=0)
    paper = item['id']
    try:
        source = library.annotate(paper, page=1, type='underline', rects=[[40, 30, 105, 42]],
                                  text='Synthetic source', comment='Synthetic remark.')['annotation']
        annotation_id = source['id']

        def translate(label):
            ref = refs(library.annotation_catalog(paper))[0]
            key = hashlib.sha256(label.encode()).hexdigest()
            return library.annotation_translation_result(paper, ref, key, '合成译文')['annotation']['id']

        def stale(reply_id):
            return next(row for row in library.annotations(paper)['annotations'] if row['id'] == reply_id).get('translation_range_stale', False)

        def reselect(rects):
            current = next(row for row in library.annotations(paper)['annotations'] if row['id'] == annotation_id)
            library.annotation_reselect(paper, annotation_id, current['page'], rects, 'Synthetic selection', current['edit_version'])

        original = translate('first')
        legacy = translate('legacy')
        def remove_range_metadata(doc):
            _, annotation = library._find_annotation(doc, legacy)
            extra = library._annotation_metadata(annotation)
            extra.pop('source_range_hash')
            annotation.set_info(subject='paper-library:' + json.dumps(extra))
            annotation.update()
        with library.lock():
            library._write_pdf(paper, remove_range_metadata)
        assert not stale(original) and not stale(legacy)

        library.annotation_update(paper, annotation_id, comment='Updated synthetic remark.')
        reselect(source['rects'])
        assert not stale(original) and not stale(legacy)

        rect = source['rects'][0]
        reselect([[rect[0], rect[1], rect[2] + 8, rect[3]]])
        assert stale(original) and stale(legacy)
        updated = translate('updated')
        assert not stale(updated)

        reselect(source['rects'])
        assert not stale(original)
        assert stale(updated)
    finally:
        library.close()
