import test from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeMining } from '../src/harness/challenge-mining.mjs';

const source = (id, page, text) => ({ id, entity: { kind: 'paper', id: 'paper-a' }, kind: 'source-note', text, locator: { page, section: 'discussion · candidate 1' }, content_hash: `hash-${id}`, pdf_snapshot: { kind: 'challenge-candidate' } });
const request = { action: 'challenge_extract_start', id: 'paper-a', request_id: 'run-a' };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let count = 0; count < 200; count++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Synthetic challenge job did not reach its checkpoint');
}

function fixture() {
  const f = { records: new Map(), drafts: new Map(), kernel: [], calls: [], agentGate: null, agentError: null, output: null, failComplete: false };
  const sources = [source('source-a', 2, 'A key limitation is that our evaluation covers only one synthetic city.'), source('source-b', 5, 'Despite these results, synthetic transfer remains unclear.')];
  f.sources = sources;
  f.defaultOutput = {
    nodes: [
      { id: 'coverage', type: 'gap', label: '合成评测只覆盖一个城市', source_status: 'author-stated', fields: { target: 'evaluation', kind: 'limitation' } },
      { id: 'transfer', type: 'question', label: '合成迁移是否可推广仍不清楚', source_status: 'author-stated', fields: { target: 'setting', kind: 'open-question' } },
      { id: 'evidence-one', type: 'evidence', label: '作者自陈局限句', source_id: 'source-a', quote: 'A key limitation is that our evaluation covers only one synthetic city.' },
      { id: 'evidence-two', type: 'evidence', label: '未决问题句', source_id: 'source-b', quote: 'synthetic transfer remains unclear' },
    ],
    edges: [{ subject: 'gap:coverage', object: 'question:transfer', relation: 'limits' }],
    assertions: [{ subject: 'evidence:evidence-one', object: 'gap:coverage', relation: 'identifies', surface: 'Explicit limitation' }],
  };
  let revision = 0;
  f.options = {
    library: '/synthetic/library', python: '/synthetic/python',
    store: {
      async get(key) { return structuredClone(f.records.get(key) ?? { key, value: null, revision: 0 }); },
      async put(key, value, expected) {
        if (f.failComplete && value.status === 'complete') throw new Error('Synthetic completion checkpoint failure');
        assert.equal(expected, f.records.get(key)?.revision ?? 0, 'State writes must use CAS');
        const record = { key, value: structuredClone(value), revision: ++revision };
        f.records.set(key, record); return structuredClone(record);
      },
    },
    async dispatch(input) {
      f.kernel.push(structuredClone(input));
      if (input.action === 'get') return { id: input.id, title: 'Synthetic challenge paper', citekey: 'synthetic2026', pdf: true, archived: false, modified: 'revision-a' };
      if (input.action === 'challenge_sources') return { schema: 'paper-library-challenge-sources.v1', paper: { id: 'paper-a', title: 'Synthetic challenge paper', citekey: 'synthetic2026', year: 2026 }, sources: f.sources, source_ids: f.sources.map(item => item.id), sections_used: ['discussion', 'future-work'], candidates: f.sources.length, characters: 120, truncated: false, warnings: [], model_calls: 0 };
      if (input.action === 'knowledge_draft_put') {
        const draft = { ...structuredClone(input), id: 'kd-challenge', status: 'needs-review', revision: 1 };
        f.drafts.set(draft.id, draft); return structuredClone(draft);
      }
      if (input.action === 'knowledge_draft_get') return structuredClone(f.drafts.get(input.id));
      throw new Error(`Unexpected kernel operation ${input.action}`);
    },
    async paperChat(input) { assert.equal(input.action, 'chat_ensure'); return { model: { provider: 'synthetic-provider', model: 'challenge-model' } }; },
    async agent(input) {
      f.calls.push(input);
      if (f.agentGate) await new Promise((resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal.reason ?? new Error('aborted')), { once: true });
        f.agentGate.promise.then(resolve);
      });
      if (f.agentError) throw f.agentError;
      const value = f.output ?? f.defaultOutput;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
  f.handle = createChallengeMining(f.options);
  f.record = () => [...f.records.values()].find(record => record.key.startsWith('challenge.job:'));
  f.done = async () => { await until(() => f.record() && !['queued', 'reading', 'generating', 'committing'].includes(f.record().value.status)); return f.handle({ action: 'challenge_extract_get', id: 'paper-a', request_id: 'run-a' }); };
  return f;
}

test('a completed job freezes sources, calls the isolated model once and saves a reviewable draft', async () => {
  const f = fixture();
  const started = await f.handle(request);
  assert.equal(started.status, 'queued');
  const result = await f.done();
  assert.equal(result.status, 'complete');
  assert.equal(result.draft_id, 'kd-challenge');
  assert.equal(result.draft.status, 'needs-review');
  assert.deepEqual(result.records, { nodes: 4, edges: 1, assertions: 1 });
  assert.equal(f.calls.length, 1, 'Exactly one model call');
  assert.equal(f.calls[0].provider, 'synthetic-provider');
  assert.match(f.calls[0].prompt, /author-stated/);
  assert.match(f.calls[0].prompt, /END_OF_CHALLENGE_SOURCES/);
  const saved = f.kernel.find(call => call.action === 'knowledge_draft_put');
  assert.equal(saved.mode, 'graph');
  assert.equal(saved.origin, 'llm');
  assert.deepEqual(saved.source_ids, ['source-a', 'source-b']);
  assert.match(saved.request_id, /^challenge-/);
  assert.equal(saved.nodes.find(node => node.id === 'coverage').source_status, 'author-stated');
  const repeated = await f.handle({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'run-a' });
  assert.equal(repeated.status, 'complete', 'Re-issuing a finished request returns the saved record');
  assert.equal(f.calls.length, 1);
});

test('duplicate starts and restarts never replay a generation', async () => {
  const f = fixture(); f.agentGate = gate();
  const [first, duplicate] = await Promise.all([f.handle(request), f.handle(request)]);
  assert.deepEqual(first, duplicate);
  await until(() => f.calls.length === 1);
  f.agentGate.resolve();
  await f.done();
  assert.equal(f.calls.length, 1);
  const restarted = createChallengeMining(f.options);
  const again = await restarted({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'run-a' });
  assert.equal(again.status, 'complete');
  assert.equal(f.calls.length, 1, 'A completed request is never regenerated');
});

test('invalid model output fails the job without writing a draft', async () => {
  const cases = [
    ['missing source_status', { nodes: [{ id: 'coverage', type: 'gap', label: '无来源状态' }, { id: 'e', type: 'evidence', label: 'x', source_id: 'source-a', quote: 'A key limitation is that our evaluation covers only one synthetic city.' }], edges: [], assertions: [{ subject: 'evidence:e', object: 'gap:coverage', relation: 'identifies' }] }],
    ['invented quote', { ...fixture().defaultOutput, nodes: [{ ...fixture().defaultOutput.nodes[0] }, { id: 'e', type: 'evidence', label: 'x', source_id: 'source-a', quote: 'This sentence is not in the source' }], assertions: [{ subject: 'evidence:e', object: 'gap:coverage', relation: 'identifies' }] }],
    ['unbacked gap', { nodes: [{ id: 'coverage', type: 'gap', label: '无证据', source_status: 'inferred' }], edges: [], assertions: [] }],
    ['question without a gap link', { nodes: [{ id: 'transfer', type: 'question', label: '孤立问题', source_status: 'inferred' }], edges: [], assertions: [] }],
    ['unknown source id', { nodes: [{ id: 'e', type: 'evidence', label: 'x', source_id: 'source-missing', quote: 'x' }], edges: [], assertions: [] }],
  ];
  for (const [name, output] of cases) {
    const f = fixture(); f.output = output;
    await f.handle(request);
    const result = await f.done();
    assert.equal(result.status, 'failed', name);
    assert.ok(result.error, name);
    assert.equal(result.draft_id, undefined, name);
    assert.equal(f.kernel.some(call => call.action === 'knowledge_draft_put'), false, name);
  }
});

test('a second paper waits, cancellation stops the model call and no draft appears', async () => {
  const f = fixture(); f.agentGate = gate();
  await f.handle(request);
  await until(() => f.calls.length === 1);
  await assert.rejects(f.handle({ ...request, id: 'paper-b', request_id: 'run-b' }), error => error.code === 'CHALLENGE_BUSY');
  const cancelled = await f.handle({ action: 'challenge_extract_cancel', id: 'paper-a', request_id: 'run-a' });
  f.agentGate.resolve();
  const settled = await f.done();
  assert.equal(settled.status, 'cancelled');
  assert.equal(f.kernel.some(call => call.action === 'knowledge_draft_put'), false);
  assert.equal(cancelled.status === 'cancelled' || settled.status === 'cancelled', true);
});

test('an interrupted run reports itself and never replays; explicit retry needs a new request id', async () => {
  const f = fixture(); f.agentGate = gate();
  await f.handle(request);
  await until(() => f.calls.length === 1);
  const restarted = createChallengeMining(f.options);
  const interrupted = await restarted({ action: 'challenge_extract_get', id: 'paper-a', request_id: 'run-a' });
  assert.equal(interrupted.status, 'interrupted');
  assert.match(interrupted.error, /中断/);
  assert.equal(f.calls.length, 1);
  f.agentGate.resolve();
  await f.done();
  const fresh = await restarted({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'run-a2' });
  assert.equal(fresh.status, 'queued');
  await until(() => f.calls.length === 2);
  await until(() => f.kernel.filter(call => call.action === 'knowledge_draft_put').length === 2);
  assert.equal(f.calls.length, 2, 'A new request id generates again');
});

test('actions and section scopes are validated before any work', async () => {
  const f = fixture();
  await assert.rejects(f.handle({ action: 'challenge_extract_start', id: 'dataset_x', request_id: 'x' }), /请选择文献/);
  await assert.rejects(f.handle({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'bad id' }), /请求标识/);
  await assert.rejects(f.handle({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'x', sections: ['nope'] }), /有效小节/);
  await assert.rejects(f.handle({ action: 'challenge_extract_start', id: 'paper-a', request_id: 'x', sections: ['introduction', 'introduction'] }), /有效小节/);
  await assert.rejects(f.handle({ action: 'challenge_unknown', id: 'paper-a' }), /不支持/);
  assert.equal(f.kernel.length, 0, 'Invalid requests touch neither the catalog nor the model');
});
