import test from 'node:test';
import assert from 'node:assert/strict';
import { arxivID } from '../src/paper-fetch.mjs';

test('arXiv identifiers preserve versions and legacy category casing', () => {
  for (const id of ['2601.01234', '0704.1234', '2601.01234v12', 'hep-th/9901001', 'math.GT/0301001v2', 'cs.AI/0601001']) {
    assert.equal(arxivID(id), id);
    assert.equal(arxivID(`  ${id}  `), id);
    assert.equal(arxivID(`arXiv: ${id}`), id);
    assert.equal(arxivID(`ARXIV:${id}`), id);
  }
});

test('official arXiv abstract, PDF and HTML links normalize without losing versions', () => {
  for (const scheme of ['https://', 'http://', '']) {
    for (const host of ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org', 'ARXIV.ORG']) {
      for (const path of ['abs', 'pdf', 'html']) {
        for (const id of ['2601.01234v2', 'math.GT/0301001v3']) {
          for (const suffix of ['', '/', '.pdf', '.pdf/', '?download=1', '#page=2', '.pdf/?download=1#page=2']) {
            const url = `${scheme}${host}/${path}/${id}${suffix}`;
            assert.equal(arxivID(url), id, url);
          }
        }
      }
    }
  }
});

test('arXiv parser rejects malformed identifiers and does not reinterpret DOI input', () => {
  for (const value of [
    '', 'arxiv:', '2601.123', '2601.123456', '2600.01234', '2613.01234',
    '2601.01234v0', '2601.01234v01', '2601.01234v', '2601.01234V2',
    '2601.01234v-1', '2601.01234v1.5', '2601.01234 trailing text',
    '2601.01234.pdf', '2601.01234/', '2601.01234?download=1',
    'hep-th/9900001', 'hep-th/9913001', 'hep-th/990100', 'hep-th/99010011',
    'math..GT/0301001', 'math./0301001', '-math/0301001', 'math--GT/0301001',
    '10.1234/example', 'doi:10.1234/example', '10.48550/arXiv.2601.01234',
    'https://doi.org/10.48550/arXiv.2601.01234',
    'arXiv:https://arxiv.org/abs/2601.01234',
  ]) assert.equal(arxivID(value), null, value);
});

test('arXiv links require an exact official host, protocol and path', () => {
  for (const value of [
    'https://arxiv.org.evil.example/abs/2601.01234',
    'https://evil.example/arxiv.org/abs/2601.01234',
    'https://evil.example/?url=https://arxiv.org/abs/2601.01234',
    'https://arxiv.org@evil.example/abs/2601.01234',
    'https://user@arxiv.org/abs/2601.01234',
    'https://user:pass@arxiv.org/abs/2601.01234',
    'https://@arxiv.org/abs/2601.01234',
    'https://arxiv.org:443/abs/2601.01234',
    'http://arxiv.org:80/abs/2601.01234',
    'https://arxiv.org:8080/abs/2601.01234',
    'https://arxiv.org./abs/2601.01234',
    'https://%61rxiv.org/abs/2601.01234',
    'https://www.export.arxiv.org/abs/2601.01234',
    'ftp://arxiv.org/abs/2601.01234', 'javascript:https://arxiv.org/abs/2601.01234',
    '//arxiv.org/abs/2601.01234', 'https:arxiv.org/abs/2601.01234',
    'https://arxiv.org/2601.01234', 'https://arxiv.org/list/2601.01234',
    'https://arxiv.org/ABS/2601.01234', 'https://arxiv.org/abs/2601.01234/extra',
    'https://arxiv.org/abs/2601.01234//', 'https://arxiv.org/abs/2601.01234.pdf.pdf',
    'https://arxiv.org/foo/../abs/2601.01234',
    'https://arxiv.org/abs/%32%3601.01234',
    'https://arxiv.org/abs/math.GT%2F0301001',
    'https://arxiv.org\\abs\\2601.01234',
    'https://arxiv.org/abs/2601.\n01234',
    'https://arxiv.org/abs/2601.01234?x=\t1',
  ]) assert.equal(arxivID(value), null, value);
});

test('arXiv parser never coerces or throws on nonstring values', () => {
  for (const value of [undefined, null, 2601.01234, true, [], {}, Symbol('arxiv'), { toString() { throw new Error('Do not coerce'); } }]) {
    assert.equal(arxivID(value), null);
  }
});
