import importlib.util
import io
import json
from pathlib import Path
import urllib.error

import pytest


spec = importlib.util.spec_from_file_location('direct_probe', Path(__file__).parents[1] / 'scripts/probe-direct-metadata-api.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def test_reads_only_named_literal_without_executing_environment(tmp_path):
    env = tmp_path / 'fixture.env'
    env.write_text('IGNORED=$(bad-command)\nexport SELECTED="fixture-secret" # note\n')
    assert probe.read_named_key(env, 'SELECTED') == 'fixture-secret'
    env.write_text('SELECTED=$(bad-command)\n')
    with pytest.raises(ValueError, match='literal'):
        probe.read_named_key(env, 'SELECTED')


def test_rejects_duplicate_or_missing_selected_credential(tmp_path):
    env = tmp_path / 'fixture.env'
    for text in ('UNRELATED=x\n', 'SELECTED=a\nSELECTED=b\n', 'SELECTED=\n'):
        env.write_text(text)
        with pytest.raises(ValueError):
            probe.read_named_key(env, 'SELECTED')


def test_request_routes_and_headers_are_explicit():
    url, body, headers = probe.build_request('glm', 'fixture-secret')
    assert url == 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    assert headers['Authorization'] == 'Bearer fixture-secret'
    assert body['response_format'] == {'type': 'json_object'}
    url, body, headers = probe.build_request('kimi', 'fixture-secret')
    assert url == 'https://api.kimi.com/coding/v1/messages'
    assert headers['x-api-key'] == 'fixture-secret'
    assert headers['User-Agent'] == 'dsh-paper-library-direct-probe/1.0'
    assert 'Authorization' not in headers
    assert probe.NoRedirect().redirect_request(None, None, None, None, None, None) is None


class Response(io.BytesIO):
    code = 200


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.calls = 0

    def open(self, request, timeout):
        self.calls += 1
        assert timeout == 45
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


@pytest.mark.parametrize('provider', ['glm', 'kimi'])
def test_synthetic_fixture_and_usage_are_checked(provider):
    text = json.dumps(probe.EXPECTED)
    payload = {'model': 'fixture-model', 'usage': {'input_tokens': 10, 'output_tokens': 20}}
    payload.update({'choices': [{'message': {'content': text}}]} if provider == 'glm' else {'content': [{'type': 'text', 'text': text}]})
    opener = FakeOpener(Response(json.dumps(payload).encode()))
    result = probe.perform(provider, 'fixture-secret', opener=opener)
    assert result['fixture_passed'] and result['status'] == 'passed'
    assert result['usage']['input_tokens'] == 10
    assert opener.calls == 1
    assert 'fixture-secret' not in json.dumps(result)


def test_http_rejection_is_redacted_and_never_retried():
    raw = json.dumps({'error': {'message': 'Denied fixture-secret', 'type': 'permission_error'}}).encode()
    error = urllib.error.HTTPError('https://api.kimi.com/coding/v1/messages', 403, 'Denied', {}, io.BytesIO(raw))
    opener = FakeOpener(error)
    result = probe.perform('kimi', 'fixture-secret', opener=opener)
    assert result['status'] == 'http-error' and result['http_status'] == 403
    assert not result['fixture_passed'] and opener.calls == 1
    assert 'fixture-secret' not in json.dumps(result)


def test_missing_doi_must_stay_null():
    wrong = {**probe.EXPECTED, 'doi': '10.1234/invented'}
    opener = FakeOpener(Response(json.dumps({'choices': [{'message': {'content': json.dumps(wrong)}}]}).encode()))
    assert not probe.perform('glm', 'fixture-secret', opener=opener)['fixture_passed']


def test_accepts_only_single_answer_wrapper_without_guessing_fields():
    assert probe.decode_fixture(json.dumps({'answer': probe.EXPECTED})) == probe.EXPECTED
    assert probe.decode_fixture(json.dumps({'answer': probe.EXPECTED, 'extra': 'unexpected'})) != probe.EXPECTED
    assert probe.decode_fixture(json.dumps({'answer': {'title': 'incomplete'}})) != probe.EXPECTED
