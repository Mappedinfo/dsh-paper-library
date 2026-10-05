import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location('metadata_audit', Path(__file__).parents[1] / 'scripts/audit-pdf-metadata.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def test_complete_metadata_does_not_require_doi():
    row = audit.normalized({'title': 'Reading methods', 'author': [{'family': 'Example'}], 'issued': {'date-parts': [[2024]]}}, 'fixture')
    assert row['basic_complete']
    assert not row['fields']['doi']


def test_creation_date_cannot_satisfy_publication_year():
    row = audit.normalized({'title': 'Reading methods', 'author': 'Example', 'creationDate': 'D:20250101'}, 'fixture')
    assert row['year'] is None
    assert not row['basic_complete']


def test_filename_placeholders_keep_their_provenance():
    row = audit.normalized({'title': 'Reading methods', 'author': 'Example', 'year': 2024}, 'paper-library', filename_only=True)
    assert row['filename_only']


def test_zotero_and_collection_field_mapping():
    row = audit.normalized({'title': 'Reading methods', 'creators': [{'lastName': 'Example'}], 'date': '2024-02-01', 'DOI': 'https://doi.org/10.1234/EXAMPLE', 'publicationTitle': 'Example Journal'}, 'zotero-live')
    assert row['year'] == 2024
    assert row['doi'] == '10.1234/example'
    assert row['basic_complete']
    assert row['fields']['venue']


def test_zotero_creator_roles_only_count_authors():
    editor_only = audit.normalized({'title': 'Reading methods', 'creators': [
        {'creatorType': 'editor', 'lastName': 'Editor'}, {'creatorType': 'translator', 'name': 'Translator'}],
        'date': '2024'}, 'zotero-live')
    assert editor_only['author'] == []
    assert not editor_only['fields']['author']
    assert not editor_only['basic_complete']
    mixed = audit.normalized({'creators': [
        {'creatorType': 'editor', 'lastName': 'Editor'}, {'creatorType': 'author', 'lastName': 'Author'},
        {'name': 'Undeclared role'}, {'creatorType': 'author'}]}, 'zotero-live')
    assert len(mixed['author']) == 2


def test_filename_fallback_title_is_not_complete_and_provenance_is_kept():
    row = audit.normalized({'title': 'article-2024.pdf', 'author': [{'family': 'Example'}],
                            'issued': {'date-parts': [[2024]]},
                            'parse': {'field_sources': {'title': 'filename-fallback'}}}, 'embedded-csl')
    assert row['field_provenance']['title'] == 'filename-fallback'
    assert not row['fields']['title']
    assert not row['basic_complete']


def test_layout_title_needs_review_without_vetoing_other_provenance():
    row = audit.normalized({'title': 'A plausible extracted title', 'author': [{'family': 'Example'}],
                            'issued': {'date-parts': [[2024]]},
                            'parse': {'field_sources': {'title': 'first-page-layout-heuristic', 'author': 'crossref'}}}, 'paper-library')
    assert row['needs_review']
    assert row['fields']['title']
    assert row['fields']['author']
    assert row['basic_complete']


def test_remote_zotero_endpoint_is_rejected_before_request(tmp_path):
    import pytest
    with pytest.raises(ValueError, match='loopback'):
        audit.fetch_zotero('https://example.com/api', tmp_path, set(), tmp_path)


class FakeResponse:
    def __init__(self, value):
        import json
        self.payload = json.dumps(value).encode()
        self.headers = {'Last-Modified-Version': '7'}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size=-1):
        return self.payload[:size]


def test_zotero_parent_fetch_uses_top_endpoint(monkeypatch, tmp_path):
    import json
    import urllib.request

    attached = tmp_path / 'paper.pdf'
    requests = []

    class FakeOpener:
        def open(self, url, timeout):
            from urllib.parse import urlsplit, parse_qs
            parsed = urlsplit(url)
            requests.append(parsed.path)
            if parsed.path.endswith('/items'):
                page = [{'data': {'path': str(attached), 'parentItem': 'PARENT', 'key': 'ATTACH'}}]
            elif parsed.path.endswith('/items/top'):
                assert parse_qs(parsed.query)['itemKey'] == ['PARENT']
                page = [{'data': {'key': 'PARENT', 'title': 'A paper', 'creators': [{'creatorType': 'author', 'lastName': 'Writer'}], 'date': '2024'}}]
            else:
                raise AssertionError(parsed.path)
            return FakeResponse(page)

    monkeypatch.setattr(urllib.request, 'build_opener', lambda *args: FakeOpener())
    out = tmp_path / 'out'
    out.mkdir()
    items, status = audit.fetch_zotero('http://127.0.0.1:23119/api/users/0', tmp_path, {str(attached)}, out)
    assert requests == ['/api/users/0/items', '/api/users/0/items/top']
    assert len(items) == 1
    assert items[0][1]['basic_complete']
    assert status['parents'] == 1
    assert json.loads((out / 'zotero-metadata.json').read_text())['parents']['PARENT']['basic_complete']


def test_zotero_missing_parent_fails_audit(monkeypatch, tmp_path):
    import pytest
    import urllib.request

    attached = tmp_path / 'paper.pdf'

    class FakeOpener:
        def open(self, url, timeout):
            from urllib.parse import urlsplit
            if urlsplit(url).path.endswith('/items/top'):
                return FakeResponse([])
            return FakeResponse([{'data': {'path': str(attached), 'parentItem': 'MISSING', 'key': 'ATTACH'}}])

    monkeypatch.setattr(urllib.request, 'build_opener', lambda *args: FakeOpener())
    out = tmp_path / 'out'
    out.mkdir()
    with pytest.raises(ValueError, match='omitted requested parent'):
        audit.fetch_zotero('http://127.0.0.1:23119/api/users/0', tmp_path, {str(attached)}, out)


def test_cached_probe_reuses_only_full_matching_file_identity(tmp_path):
    import os
    import stat

    path = tmp_path / 'unchanged.pdf'
    path.write_bytes(b'synthetic')
    observed = os.lstat(path)
    expected = {'size': observed.st_size, 'mtime_ns': observed.st_mtime_ns, 'ctime_ns': observed.st_ctime_ns,
                'dev': observed.st_dev, 'ino': observed.st_ino, 'mode': stat.S_IMODE(observed.st_mode)}
    probe = {'sha256': 'synthetic-hash', 'stat': expected}
    item = {'references': [{'local_path': str(path)}]}
    assert audit.cached_probe(item, {str(path): probe}) is probe
    for field in expected:
        changed = {**expected, field: expected[field] + 1}
        assert audit.cached_probe(item, {str(path): {'sha256': probe['sha256'], 'stat': changed}}) is None
    path.write_bytes(b'changed file bytes')
    assert audit.cached_probe(item, {str(path): probe}) is None
