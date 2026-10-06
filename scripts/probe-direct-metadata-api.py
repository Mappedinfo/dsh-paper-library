#!/usr/bin/env python3
"""使用合成样本测试显式选定的模型凭据，不依赖 DSH，不读取 PDF。"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import time
import urllib.error
import urllib.request


PROVIDERS = {
    'glm': {'endpoint': 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            'model': 'glm-4.7-flash', 'protocol': 'openai-chat-completions'},
    'kimi': {'endpoint': 'https://api.kimi.com/coding/v1/messages',
             'model': 'kimi-for-coding', 'protocol': 'anthropic-messages'},
}
EXPECTED = {'title': 'How to Read Carefully', 'authors': ['Alex Example'], 'year': 2024, 'doi': None}
PROMPT = '''Test fixture for a bibliographic parser. Convert the following synthetic source to JSON.
Return only an object with exactly title (string), authors (array of strings), year (integer), doi (string or null).
Copy only supplied facts. Missing DOI must be null. Do not invent identifiers or look anything up.
Synthetic source:
Title: How to Read Carefully
Author: Alex Example
Publication year: 2024
'''
MAX_RESPONSE_BYTES = 256 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_named_key(path, name):
    """仅解析命名变量；不执行 shell，不展开变量，不输出文件中其他内容。"""
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
        raise ValueError('invalid variable name')
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('environment file exceeds size limit')
    pattern = re.compile(r'^\s*(?:export\s+)?' + re.escape(name) + r'\s*=\s*(.*)$')
    found = []
    with path.open(encoding='utf-8') as handle:
        for line in handle:
            match = pattern.match(line)
            if not match:
                continue
            try:
                tokens = shlex.split(match.group(1), comments=True, posix=True)
            except ValueError:
                raise ValueError('invalid selected variable assignment') from None
            if len(tokens) != 1 or not tokens[0] or any(c.isspace() for c in tokens[0]):
                raise ValueError('selected variable is empty or malformed')
            if '$' in tokens[0] or '`' in tokens[0]:
                raise ValueError('selected variable must be a literal')
            found.append(tokens[0])
    if len(found) != 1:
        raise ValueError('selected variable missing or assigned multiple times')
    return found[0]


def build_request(provider, key):
    profile = PROVIDERS[provider]
    body = {'model': profile['model'], 'max_tokens': 512, 'stream': False,
            'messages': [{'role': 'user', 'content': PROMPT}], 'thinking': {'type': 'disabled'}}
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json',
               'User-Agent': 'dsh-paper-library-direct-probe/1.0'}
    if provider == 'glm':
        headers['Authorization'] = 'Bearer ' + key
        body['response_format'] = {'type': 'json_object'}
    else:
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
    return profile['endpoint'], body, headers


def redact(value, key):
    if isinstance(value, str):
        return value.replace(key, '[REDACTED]')
    if isinstance(value, list):
        return [redact(item, key) for item in value]
    if isinstance(value, dict):
        return {redact(k, key): redact(v, key) for k, v in value.items()}
    return value


def extract_output(provider, payload):
    if provider == 'glm':
        return payload['choices'][0]['message']['content']
    return ''.join(block.get('text', '') for block in payload.get('content', []) if block.get('type') == 'text')


def decode_fixture(text):
    value = text.strip()
    if value.startswith('```json\n') and value.endswith('```'):
        value = value[8:-3].strip()
    elif value.startswith('```\n') and value.endswith('```'):
        value = value[4:-3].strip()
    decoded = json.loads(value)
    # 一些兼容服务将 JSON 放在单一 answer 字段下；仅接受这一种精确包装。
    if isinstance(decoded, dict) and set(decoded) == {'answer'} and isinstance(decoded['answer'], dict):
        return decoded['answer']
    return decoded


def perform(provider, key, *, opener=None):
    endpoint, body, headers = build_request(provider, key)
    request = urllib.request.Request(endpoint, json.dumps(body).encode(), headers, method='POST')
    opener = opener or urllib.request.build_opener(NoRedirect)
    started = time.monotonic()
    result = {'provider': provider, 'protocol': PROVIDERS[provider]['protocol'],
              'model_requested': body['model'], 'endpoint': endpoint, 'request_count': 1,
              'sample': 'synthetic-parser-fixture-v1', 'request_body': body,
              'status': 'unverified', 'fixture_passed': False}
    try:
        try:
            response = opener.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result['http_status'] = response.code
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            result['status'] = 'response-too-large'
            return result
        try:
            payload = redact(json.loads(raw), key)
        except (ValueError, UnicodeError):
            result['status'] = 'non-json-response'
            return result
        result['response'] = payload
        if result['http_status'] != 200:
            result['status'] = 'http-error'
            return result
        result['model_returned'] = payload.get('model')
        result['usage'] = payload.get('usage')
        try:
            output = decode_fixture(extract_output(provider, payload))
            result['fixture_passed'] = output == EXPECTED
            result['status'] = 'passed' if result['fixture_passed'] else 'fixture-mismatch'
        except (KeyError, IndexError, TypeError, ValueError):
            result['status'] = 'invalid-structured-output'
    except (OSError, urllib.error.URLError):
        # 不输出可能夹带请求头或凭据的异常详情。
        result['status'] = 'network-error'
    finally:
        result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=PROVIDERS, required=True)
    parser.add_argument('--env-file', type=Path, required=True)
    parser.add_argument('--key-env', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not args.out.is_absolute() or args.out.exists():
        parser.error('output must be a new absolute path')
    # 报告留在代码仓库之外，避免私人运行状态混入公开材料。
    if args.out.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        parser.error('output must be outside the source repository')
    try:
        key = read_named_key(args.env_file, args.key_env)
    except (OSError, ValueError):
        parser.exit(2, 'Cannot read the explicitly selected credential; no request sent.\n')
    result = perform(args.provider, key)
    result['credential_variable'] = args.key_env
    result['observed_at'] = datetime.now(timezone.utc).isoformat()
    result = redact(result, key)
    with os.fdopen(os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2); handle.write('\n')
    print(json.dumps({k: result[k] for k in ('provider', 'protocol', 'model_requested', 'status', 'fixture_passed', 'elapsed_seconds')}, ensure_ascii=False))
    return 0 if result['fixture_passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
