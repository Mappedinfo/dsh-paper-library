/** Whiteboard references inside a conversation.
 *
 * A board reference is a token in the reader's draft plus one immutable snapshot
 * record. The token carries only identity; the material always comes from the frozen
 * snapshot, so a package placed in the draft can never change what the model receives.
 * The appended message keeps its own plugin source and a body hash, so board material
 * is verifiable in the log and can never be mistaken for AI output or for an annotation
 * reference (which stays PDF-bound and session-bound).
 *
 * Loading one reference performs bounded local reads only: no model, no PDF, no network.
 */
import { createHash } from 'node:crypto'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'

export const BOARD_REFERENCE_PLUGIN = 'Paper Library'
export const BOARD_REFERENCE_SOURCE = 'paper-library-board'
export const BOARD_REFERENCE_MAX_GROUPS = 4
export const BOARD_REFERENCE_DEFAULT_CHARACTERS = 24_000

const TOKEN = /^\[\[paper-library-board:v1:([A-Za-z0-9_-]{1,60}):([a-f0-9]{64})\]\]$/
const tokenPattern = () => /\[\[paper-library-board:v1:([A-Za-z0-9_-]{1,60}):([a-f0-9]{64})\]\]/g

export function boardReferenceToken(boardId, snapshotId) {
  if (typeof boardId !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(boardId)) throw new Error('画板引用标识无效。')
  if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('画板引用快照无效。')
  return `[[paper-library-board:v1:${boardId}:${snapshotId}]]`
}

export function parseBoardReference(token) {
  const match = typeof token === 'string' && TOKEN.exec(token)
  return match ? { boardId: match[1], snapshot_id: match[2], ref: token } : null
}

export const boardReferenceBodyHash = text => createHash('sha256').update(typeof text === 'string' ? text : '').digest('hex')

/** Plugin-owned provenance: enough to re-verify the material without storing it twice. */
export function boardReferenceSource(snapshot, snapshotId) {
  return {
    kind: 'plugin', plugin: BOARD_REFERENCE_PLUGIN,
    paperLibraryBoard: {
      version: 1,
      board_id: snapshot.board_id,
      board_title: snapshot.board_title,
      snapshot_id: snapshotId,
      characters: snapshot.characters,
      truncated: snapshot.truncated === true,
      body_hash: boardReferenceBodyHash(snapshot.text),
    },
  }
}

const textOf = content => (Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  : '')

/**
 * Expand board tokens in the reader's own messages. The visible draft keeps a short
 * marker; the frozen outline follows as a separate user message, charged against the
 * same character budget the annotation references use.
 */
export async function prepareBoardReferenceMessages(messages, { boards, maxCharacters = BOARD_REFERENCE_DEFAULT_CHARACTERS, signal } = {}) {
  const prepared = []
  let characters = 0, groups = 0
  for (const message of messages) {
    if (message.source?.kind !== 'user') { prepared.push(message); continue }
    const references = new Map()
    const content = []
    for (const block of message.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.includes('[[paper-library-board:')) { content.push(block); continue }
      const matches = [...block.text.matchAll(tokenPattern())]
      // A leftover fragment means a hand-edited or truncated token; refuse it loudly
      // instead of silently sending material the reader did not choose.
      if (!matches.length || block.text.replace(tokenPattern(), '').includes('[[paper-library-board:')) {
        throw new Error('画板引用格式无效；请从画板重新加入引用。')
      }
      let rest = '', end = 0
      for (const match of matches) {
        signal?.throwIfAborted()
        const [, boardId, snapshotId] = match
        let snapshot = references.get(snapshotId)
        if (!snapshot) {
          if (++groups > BOARD_REFERENCE_MAX_GROUPS) throw new Error(`本轮最多引用 ${BOARD_REFERENCE_MAX_GROUPS} 张画板；请合并选择或分次提问。`)
          if (!boards) throw new Error('画板引用需要本机的画板存储。')
          snapshot = await boards.snapshotLoad(snapshotId)
          if (snapshot.board_id !== boardId) throw new Error('画板引用与快照不一致，请从画板重新加入。')
          characters += typeof snapshot.characters === 'number' ? snapshot.characters : snapshot.text.length
          if (characters > maxCharacters) throw new Error(`本次引用共 ${characters} 字符，超过 ${maxCharacters} 字符预算；请减少引用内容。`)
          references.set(snapshotId, snapshot)
        }
        const label = `引用画板 ${snapshot.board_title}${snapshot.truncated ? '（已按预算截断）' : ''}`
        rest += block.text.slice(end, match.index) + `〔${label}〕`
        end = match.index + match[0].length
      }
      content.push({ ...block, text: rest + block.text.slice(end) })
    }
    if (!references.size) { prepared.push(message); continue }
    signal?.throwIfAborted()
    prepared.push(freezeMessage({ ...message, content }))
    for (const [snapshotId, snapshot] of references) {
      prepared.push(createUserMessage({
        source: boardReferenceSource(snapshot, snapshotId),
        content: [{ type: 'text', text: snapshot.text }],
      }))
    }
  }
  return prepared
}

/** Whether a logged message carries a verifiable board reference (used by tests and audits). */
export function loggedBoardReference(event) {
  const source = event?.data?.source
  if (event?.type !== 'user/message' || source?.kind !== 'plugin' || source?.plugin !== BOARD_REFERENCE_PLUGIN) return null
  const board = source.paperLibraryBoard
  if (!board || board.version !== 1) return null
  const text = textOf(event.data.content)
  if (boardReferenceBodyHash(text) !== board.body_hash) return null
  return { ...board, text }
}
