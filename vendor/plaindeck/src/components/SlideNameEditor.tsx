import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'

interface Props {
  name: string
  onCommit: (name: string) => void
}

export function SlideNameEditor({ name, onCommit }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [draftSource, setDraftSource] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const { t } = useT()

  // Sync the draft to an external rename without an effect (render-time adjustment).
  if (draftSource !== name) { setDraftSource(name); setDraft(name) }
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== name) onCommit(next)
    else setDraft(name)
    setEditing(false)
  }
  const cancel = () => { setDraft(name); setEditing(false) }

  if (editing) return <input ref={inputRef} className="canvas-name-input" aria-label={t.slideNameEditor.inputAria} value={draft} maxLength={80} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } else if (event.key === 'Escape') { event.preventDefault(); cancel() } }} />

  return <strong className="canvas-name" tabIndex={0} role="button" aria-label={t.slideNameEditor.renameAria(name)} title={t.slideNameEditor.renameTitle} onDoubleClick={() => setEditing(true)} onKeyDown={event => { if (event.key === 'Enter') setEditing(true) }}>{name}</strong>
}
