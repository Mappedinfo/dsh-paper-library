import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { annotationReferenceSource } from './annotation-usage.mjs'
import { annotationSnapshotSourceCharacters } from './annotation-snapshots.mjs'

const tokenPattern = () => /\[\[paper-library-ref:v1:([A-Za-z0-9_-]{1,160}):([a-f0-9]{64})\]\]/g

/** Expand only explicit direct-user references; reading never invokes a model. */
export async function preparePaperReferenceMessages(messages, { store, sessionId, maxCharacters = 24000, signal }) {
  const prepared = []
  let characters = 0, groups = 0
  for (const message of messages) {
    if (message.source.kind !== 'user') { prepared.push(message); continue }
    const references = new Map()
    const content = []
    for (const block of message.content) {
      if (block.type !== 'text' || !block.text.includes('[[paper-library-ref:')) { content.push(block); continue }
      const matches = [...block.text.matchAll(tokenPattern())]
      if (!matches.length || block.text.replace(tokenPattern(), '').includes('[[paper-library-ref:')) throw new Error('批注引用格式无效；请从文献库重新加入引用。')
      let text = '', end = 0
      for (const match of matches) {
        signal?.throwIfAborted()
        const [, paperId, snapshotId] = match
        let snapshot = references.get(snapshotId)
        if (!snapshot) {
          if (++groups > 4) throw new Error('本轮最多引用 4 组批注；请合并选择或分次提问。')
          snapshot = await store.load(snapshotId, { paperId, sessionId })
          // The immutable store binds the configured library and target Session.
          if (snapshot.sessionId !== sessionId) throw new Error('这份批注引用属于另一篇论文的对话。')
          characters += annotationSnapshotSourceCharacters(snapshot)
          if (characters > maxCharacters) throw new Error(`本次引用共 ${characters} 字符，超过 ${maxCharacters} 字符预算；请减少引用集合。`)
          references.set(snapshotId, snapshot)
        }
        if (snapshot.paperId !== paperId || snapshot.sessionId !== sessionId) throw new Error('这份批注引用不属于当前论文对话。')
        const label = snapshot.annotation_refs.length ? `引用批注 ${snapshot.annotation_refs.length} 条${snapshot.selection ? '，含选文' : ''}` : snapshot.selection ? '引用选文' : '文献信息'
        text += block.text.slice(end, match.index) + `〔${label}〕`
        end = match.index + match[0].length
      }
      content.push({ ...block, text: text + block.text.slice(end) })
    }
    if (!references.size) { prepared.push(message); continue }
    signal?.throwIfAborted()
    prepared.push(freezeMessage({ ...message, content }))
    for (const [snapshotId, snapshot] of references) {
      prepared.push(createUserMessage({
        source: annotationReferenceSource(snapshot, snapshotId),
        content: [{ type: 'text', text: snapshot.text }],
      }))
    }
  }
  return prepared
}
