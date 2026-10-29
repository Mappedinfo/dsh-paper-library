import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, Clipboard, LockKeyhole, X } from 'lucide-react'
import { auditPresentation, createPresentationGuidance, PresentationBriefSchema, type PresentationBrief } from 'plaindeck/core'
import { useT } from '../i18n'
import { useEditor } from '../store'

type BriefDraft = Omit<PresentationBrief, 'minutes'> & { minutes: string }
type StorageState = 'ready' | 'stored' | 'draft' | 'recovered' | 'storageUnavailable'
type CopyState = 'idle' | 'copying' | 'copied' | 'fallback' | 'selected'

function loadBrief(key: string): { draft: BriefDraft; storage: StorageState } {
  const defaults = PresentationBriefSchema.parse({})
  const fresh = { ...defaults, minutes: String(defaults.minutes) }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { draft: fresh, storage: 'ready' }
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('brief' in data)) return { draft: fresh, storage: 'recovered' }
    const result = PresentationBriefSchema.safeParse(data.brief)
    if (!result.success) return { draft: fresh, storage: 'recovered' }
    return { draft: { ...result.data, minutes: String(result.data.minutes) }, storage: 'stored' }
  } catch (error) {
    return { draft: fresh, storage: error instanceof SyntaxError ? 'recovered' : 'storageUnavailable' }
  }
}

/** Local authoring support. The brief is separate from the editable deck. */
export function PresentationGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { document: deckDocument, briefScope, setActiveSlide, select } = useEditor()
  const { t, locale } = useT()
  const copy = t.presentationGuide
  const storageKey = `plaindeck.presentation-brief.v1.${encodeURIComponent(briefScope)}`
  const [state, setState] = useState(() => loadBrief(storageKey))
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const draft = state.draft
  const validMinutes = draft.minutes.trim() !== '' && Number.isFinite(Number(draft.minutes)) && Number(draft.minutes) > 0 && Number(draft.minutes) <= 240
  const options = useMemo(() => ({ ...draft, minutes: validMinutes ? Number(draft.minutes) : 10, locale }), [draft, validMinutes, locale])
  const guidance = useMemo(() => createPresentationGuidance(options), [options])
  const review = useMemo(() => open ? auditPresentation(deckDocument, options) : { kind: 'advisory' as const, slideCount: deckDocument.deck.slides.length, issues: [], manualChecks: [] }, [open, deckDocument, options])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      openerRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
      openerRef.current?.focus()
    }
  }, [open])

  function updateBrief(patch: Partial<BriefDraft>) {
    const next = { ...draft, ...patch }
    const minutes = Number(next.minutes)
    const parsed = PresentationBriefSchema.safeParse({ ...next, minutes })
    let storage: StorageState = 'draft'
    if (parsed.success) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ version: 1, brief: parsed.data }))
        storage = 'stored'
      } catch { storage = 'storageUnavailable' }
    }
    setState({ draft: next, storage })
    setCopyState('idle')
  }

  function selectPrompt() {
    promptRef.current?.focus()
    promptRef.current?.select()
  }

  async function copyPrompt() {
    if (!validMinutes) return
    setCopyState('copying')
    try {
      await navigator.clipboard.writeText(guidance.prompt)
      setCopyState('copied')
    } catch {
      selectPrompt()
      setCopyState('fallback')
    }
  }

  const copyNotice = copyState === 'copied' ? copy.copySuccess : copyState === 'fallback' ? copy.copyFallback : copyState === 'selected' ? copy.selectedText : ''
  const storageNotice = state.storage === 'ready' ? copy.localHint : copy[state.storage]

  return <dialog
    ref={dialogRef}
    className="presentation-guide"
    aria-labelledby="presentation-guide-title"
    aria-describedby="presentation-guide-intro"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, summary')].filter(element => element.offsetParent !== null)
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}
  >
    <header className="guide-header">
      <div>
        <span className="guide-eyebrow">{copy.eyebrow}</span>
        <h2 id="presentation-guide-title">{copy.title}</h2>
        <p id="presentation-guide-intro">{copy.intro}</p>
      </div>
      <button className="guide-close" onClick={onClose} aria-label={t.common.close}><X aria-hidden="true" /></button>
    </header>
    <div className="guide-workbench">
      <section className="guide-brief" aria-labelledby="guide-brief-heading">
        <h3 id="guide-brief-heading" className="guide-section-label">{copy.briefHeading}</h3>
        <label className="guide-field">
          <span>{copy.audience}</span>
          <select autoFocus value={draft.audience} onChange={event => updateBrief({ audience: event.target.value as PresentationBrief['audience'] })}>
            {Object.entries(copy.audiences).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="guide-field">
          <span>{copy.purpose}</span>
          <textarea rows={2} maxLength={2000} placeholder={copy.purposePlaceholder} value={draft.purpose} onChange={event => updateBrief({ purpose: event.target.value })} />
        </label>
        <div className="guide-brief-row">
          <label className="guide-field guide-minutes">
            <span>{copy.minutes}</span>
            <span className="guide-number-wrap"><input type="number" min="0" max="240" step="any" value={draft.minutes} aria-invalid={!validMinutes} aria-describedby={!validMinutes ? 'guide-minutes-error' : undefined} onChange={event => updateBrief({ minutes: event.target.value })} /><span aria-hidden="true">{copy.minutesUnit}</span></span>
          </label>
          <label className="guide-field">
            <span>{copy.evidenceDepth}</span>
            <select value={draft.evidenceDepth} onChange={event => updateBrief({ evidenceDepth: event.target.value as PresentationBrief['evidenceDepth'] })}>
              {Object.entries(copy.evidenceDepths).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        {!validMinutes && <p id="guide-minutes-error" className="guide-field-error" role="alert">{copy.minutesError}</p>}
        <label className="guide-field guide-claim-field">
          <span>{copy.keyMessage}</span>
          <textarea rows={3} maxLength={2000} placeholder={copy.keyMessagePlaceholder} value={draft.keyMessage} onChange={event => updateBrief({ keyMessage: event.target.value })} />
        </label>
        <div className="guide-claim-note"><span aria-hidden="true">A</span><div><strong>{copy.claimHeading}</strong><p>{copy.claimHint}</p></div></div>
        <details className="guide-principles">
          <summary>{copy.principles}</summary>
          <ol>{guidance.principles.map(principle => <li key={principle.id}><strong>{principle.title}</strong><p>{principle.detail}</p></li>)}</ol>
        </details>
      </section>
      <section className="guide-output" aria-labelledby="guide-prompt-heading">
        <div className="guide-output-head"><h3 id="guide-prompt-heading" className="guide-section-label">{copy.promptHeading}</h3><span className="guide-local-badge"><LockKeyhole aria-hidden="true" />{copy.localBadge}</span></div>
        <p className="guide-help">{copy.promptHint}</p>
        <textarea ref={promptRef} className="guide-prompt" aria-label={copy.promptAria} readOnly spellCheck={false} value={validMinutes ? guidance.prompt : copy.invalidPrompt} />
        <div className="guide-prompt-actions">
          <button className="guide-select" disabled={!validMinutes} onClick={() => { selectPrompt(); setCopyState('selected') }}>{copy.selectPrompt}</button>
          <button className="guide-copy" disabled={!validMinutes || copyState === 'copying'} onClick={() => { void copyPrompt() }}>{copyState === 'copied' ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}{copyState === 'copying' ? copy.copying : copyState === 'copied' ? copy.copied : copy.copy}</button>
        </div>
        <p className="guide-copy-notice" role="status">{copyNotice}</p>
        <section className="guide-review" aria-labelledby="guide-review-heading">
          <h3 id="guide-review-heading" className="guide-section-label">{copy.reviewHeading}</h3>
          <strong className="guide-review-count">{copy.reviewCount(review.issues.length, review.slideCount)}</strong>
          <p className="guide-help">{copy.reviewHint}</p>
          {review.issues.length ? <ul className="guide-review-list">{review.issues.map((issue, index) => <li key={`${issue.slidePath}-${issue.code}-${issue.elementId ?? ''}-${index}`}>
            <button aria-label={`${copy.openSlide(issue.slideIndex)}: ${issue.message}`} onClick={() => { setActiveSlide(issue.slidePath); if (issue.elementId) select([issue.elementId]); onClose() }}>
              <span className="guide-issue-page">{copy.slide(issue.slideIndex)}</span><span className="guide-issue-body"><strong>{issue.message}</strong><span>{issue.suggestion}</span></span><ArrowUpRight aria-hidden="true" />
            </button>
          </li>)}</ul> : <p className="guide-review-empty"><Check aria-hidden="true" />{copy.reviewEmpty}</p>}
          <details className="guide-manual-checks"><summary>{copy.manualChecks}</summary><ul>{review.manualChecks.map(item => <li key={item}>{item}</li>)}</ul></details>
        </section>
      </section>
    </div>
    <footer className="guide-footer"><LockKeyhole aria-hidden="true" /><span role="status">{storageNotice}</span><span className="guide-project" title={deckDocument.deck.title}>{deckDocument.deck.title}</span></footer>
  </dialog>
}
