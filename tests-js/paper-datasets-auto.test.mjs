import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperDatasets } from '../src/harness/paper-datasets.mjs';

test('automatic links require explicit paper usage, a matching registered identity, and a unique target', async () => {
  const cases = [
    ['Synthetic Sample', 'We used Synthetic Sample (10.5555/sample) for evaluation.', 'sample', 'Synthetic Sample v2'],
    ['Synthetic Omission', 'We did not use Synthetic Omission (10.5555/omission).', 'omission', 'Synthetic Omission'],
    ['Synthetic Ambiguity', 'We used Synthetic Ambiguity (10.5555/ambiguity).', 'ambiguity', 'Synthetic Ambiguity'],
    ['Synthetic Conflict', 'We used Synthetic Conflict (10.5555/conflict).', 'conflict', 'A Different Dataset'],
  ];
  const pages = cases.map(([, text], index) => ({ page: index + 1, text }));
  const candidates = cases.map(([title, quote, doi], index) => ({ title, quote, identifier: '10.5555/' + doi, relation: 'uses', page: index + 1 }));
  const linked = new Set();
  let saved;
  const handle = createPaperDatasets({
    store: { get: async () => ({ value: saved, revision: 0 }), put: async (key, value) => ({ value: saved = value }) },
    getModel: async () => ({ provider: 'synthetic', model: 'synthetic' }),
    ai: async () => JSON.stringify({ candidates }),
    verify: async identifier => ({ status: 'verified', access: 'accessible', doi: identifier, title: cases.find(row => identifier.endsWith(row[2]))[3] }),
    async request(input) {
      if (input.action === 'get') return { id: 'paper', pdf: true };
      if (input.action === 'paper_dataset_sources') return { page_count: 4, scanned_pages: 4, pages, source_version: 'pdf-version' };
      if (input.action === 'dataset_candidate_matches') return { requires_selection: input.candidate.title === 'Synthetic Ambiguity' };
      if (input.action === 'dataset_candidate_confirmed') return [...linked];
      if (input.action === 'dataset_candidate_commit') {
        assert.equal(input.automatic, true);
        assert.equal(input.source_version, 'pdf-version');
        assert.equal(input.candidate.title, 'Synthetic Sample');
        linked.add(input.candidate.id);
        return { review_status: 'needs-review' };
      }
      assert.fail(input.action);
    },
  });
  const result = await handle({ action: 'paper_datasets_auto', id: 'paper' });
  assert.equal(result.auto_linked, 1);
  assert.equal(result.auto_skipped, 1);
  assert.deepEqual(result.candidates.map(entry => entry.confirmed), [true, false, false, false]);
});
