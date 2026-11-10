/** Import an explicitly supplied agent result; no generation, credentials or source discovery. */
import { createHash } from 'node:crypto';
import { parseRadarAnalysis } from './field-radar-analysis.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'FIELD_RADAR_ANALYSIS_IMPORT_INVALID') => Object.assign(new Error(message), { code, status: 409 });
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value)) throw fail('Invalid analysis identity'); return value; };
export async function importFieldRadarAnalysis({ store, radar }, input) {
  id(input.id); id(input.request_id);
  if (!input.provenance || input.provenance.kind !== 'chatgpt-native-subagent' || input.provenance.external_model_calls !== 0) throw fail('This import accepts explicitly identified ChatGPT native-subagent results only. It does not certify external model quality.');
  if (typeof input.provenance.evidence_scope !== 'string' || !input.provenance.evidence_scope.trim() || input.provenance.evidence_scope.length > 4000) throw fail('Evidence scope is required');
  const topic = await radar.get(input.id);
  if (!topic.document || topic.revision !== input.expected_revision) throw fail('Topic changed; reload evidence before importing.', 'FIELD_RADAR_ANALYSIS_CONFLICT');
  const raw = JSON.stringify(input.draft), draft = parseRadarAnalysis(raw, topic.document);
  const key = `field-radar-analysis:${hash(`${input.id}:${input.request_id}`)}`;
  const fingerprint = hash(JSON.stringify({ topic_revision: topic.revision, draft, provenance: input.provenance }));
  let saved = await store.get(key), replayed = false;
  if (saved.value) {
    if (saved.value.import_fingerprint !== fingerprint) throw fail('Request identity already holds different content.', 'FIELD_RADAR_ANALYSIS_CONFLICT');
    replayed = true;
  } else {
    const timestamp = new Date().toISOString();
    const value = { status: 'complete', request_id: input.request_id, topic_id: input.id, topic_revision: topic.revision, evidence_hash: hash(JSON.stringify(topic.document)), model: { provider: 'OpenAI', model: 'ChatGPT native subagent' }, provenance: { kind: input.provenance.kind, external_model_calls: 0, evidence_scope: input.provenance.evidence_scope }, import_fingerprint: fingerprint, created_at: timestamp, completed_at: timestamp, draft };
    try { saved = await store.put(key, value, 0); }
    catch (error) { if (error.code !== 'STATE_CONFLICT') throw error; saved = await store.get(key); if (saved.value?.import_fingerprint !== fingerprint) throw error; replayed = true; }
  }
  // Optional pointer update uses the caller's last observed revision. Never replace a newer UI selection.
  let activated = false;
  if (Object.hasOwn(input, 'expected_pointer_revision')) {
    const pointerKey = `knowledge-draft:field-radar:${input.id}`, pointer = await store.get(pointerKey);
    if (pointer.value?.request_id === input.request_id) activated = true;
    else {
      if (pointer.revision !== input.expected_pointer_revision) throw fail('Draft saved, but the selected analysis changed. Do not overwrite it.', 'FIELD_RADAR_ANALYSIS_POINTER_CONFLICT');
      await store.put(pointerKey, { request_id: input.request_id }, input.expected_pointer_revision); activated = true;
    }
  }
  return { ...saved.value, revision: saved.revision, replayed, activated };
}
