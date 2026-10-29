import { useEffect, useMemo, useRef, useState } from 'react'
import { auditPresentation, createPresentationGuidance, PresentationBriefSchema, type PresentationBrief } from 'plaindeck/core'
import { useEditor } from '../../vendor/plaindeck/src/store'
import { api } from './api'

type Draft = Omit<PresentationBrief, 'minutes'> & { minutes: string }
const toDraft = (brief: PresentationBrief): Draft => ({ ...brief, minutes: String(brief.minutes) })

export function Guide({ projectId, onClose, onDirty }: { projectId: string; onClose(): void; onDirty(value: boolean): void }) {
  const deck = useEditor(state => state.document)
  const setActiveSlide = useEditor(state => state.setActiveSlide)
  const select = useEditor(state => state.select)
  const [draft, setDraft] = useState<Draft>(() => toDraft(PresentationBriefSchema.parse({})))
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('读取制作简报…')
  const [dirty, setDirty] = useState(false)
  const latest = useRef(draft), dirtyRef = useRef(false), revision = useRef<any>(null), pending = useRef<Promise<boolean> | null>(null), blocked = useRef(false), mounted = useRef(true), version = useRef(0)
  const parsed = PresentationBriefSchema.safeParse({ ...draft, minutes: Number(draft.minutes) })
  const valid = draft.minutes.trim() !== '' && parsed.success
  const guidance = useMemo(() => createPresentationGuidance({ ...(parsed.success ? parsed.data : PresentationBriefSchema.parse({})), locale: 'zh' }), [draft])
  const review = useMemo(() => auditPresentation(deck, { ...(parsed.success ? parsed.data : PresentationBriefSchema.parse({})), locale: 'zh' }), [deck, draft])

  useEffect(() => {
    mounted.current = true
    api<{ value: unknown; revision: unknown }>('slides_brief_get', { id: projectId }).then(result => {
      if (!mounted.current) return
      const value = PresentationBriefSchema.safeParse(result.value ?? {})
      if (!value.success) { setMessage('已有简报无法解析，请核对后重试。'); return }
      revision.current = result.revision; latest.current = toDraft(value.data); setDraft(latest.current); setReady(true); setMessage('简报保存在当前资料库。')
    }).catch(error => { if (mounted.current) setMessage(`简报读取失败：${error.message}`) })
    return () => { mounted.current = false }
  }, [projectId])

  function update(patch: Partial<Draft>) {
    latest.current = { ...latest.current, ...patch }; version.current++
    dirtyRef.current = true; blocked.current = false; setDirty(true); onDirty(true); setDraft(latest.current); setMessage('简报尚未保存。')
  }
  function save(): Promise<boolean> {
    if (pending.current) return pending.current
    pending.current = (async () => {
      while (dirtyRef.current) {
        const value = PresentationBriefSchema.safeParse({ ...latest.current, minutes: Number(latest.current.minutes) })
        if (!value.success || !latest.current.minutes.trim()) { setMessage('请填写 0–240 分钟的有效时长。'); return false }
        const captured = version.current
        try {
          const result = await api<{ value: PresentationBrief; revision: unknown }>('slides_brief_save', { id: projectId, value: value.data, expected_revision: revision.current })
          if (!mounted.current) return false
          revision.current = result.revision
          if (captured === version.current) { dirtyRef.current = false; setDirty(false); onDirty(false); setMessage('简报已保存。') }
        } catch (error: any) {
          if (mounted.current) { blocked.current = true; setMessage(`简报未保存：${error.message}。文字已保留，可重试或导出草稿。`) }
          return false
        }
      }
      return true
    })().finally(() => { pending.current = null })
    return pending.current
  }
  useEffect(() => {
    if (!ready || !dirty || !valid || blocked.current) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [ready, dirty, draft])
  async function close() { if (!dirtyRef.current || await save()) onClose() }
  function exportDraft() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(latest.current, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'presentation-brief-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function reload() {
    if (pending.current) { setMessage('简报正在保存，请稍候。'); return }
    if (!window.confirm('将放弃本窗口未保存的简报，重新读取资料库中的版本。是否继续？')) return
    const captured = version.current
    try {
      const result = await api<{ value: unknown; revision: unknown }>('slides_brief_get', { id: projectId })
      if (!mounted.current || captured !== version.current) { setMessage('简报在读取期间发生变化，已保留当前草稿。'); return }
      const value = PresentationBriefSchema.parse(result.value ?? {})
      revision.current = result.revision; latest.current = toDraft(value); setDraft(latest.current)
      dirtyRef.current = false; blocked.current = false; setDirty(false); onDirty(false); setMessage('已重新读取资料库简报。')
    } catch (error: any) { setMessage(`重新读取失败：${error.message}。当前草稿保留。`) }
  }
  return <div className="slides-overlay" role="presentation"><section className="slides-guide" role="dialog" aria-modal="true" aria-label="制作指导">
    <header><h2>制作指导</h2><button onClick={() => void close()}>关闭</button></header>
    <p>明确听众、目的和证据，再根据实际内容审阅；自动检查只是提示。</p>
    <fieldset disabled={!ready}>
      <label>听众 <select value={draft.audience} onChange={event => update({ audience: event.target.value as PresentationBrief['audience'] })}>
        <option value="general">一般汇报</option><option value="faculty">导师与学术同行</option><option value="classroom">课堂学习者</option><option value="business">决策与协作</option><option value="public">公众</option><option value="archive">研究档案</option>
      </select></label>
      <label>目的 <textarea value={draft.purpose} onChange={event => update({ purpose: event.target.value })} maxLength={2000} /></label>
      <label>核心主张 <textarea value={draft.keyMessage} onChange={event => update({ keyMessage: event.target.value })} maxLength={2000} /></label>
      <label>时长（分钟） <input type="number" min="0.1" max="240" value={draft.minutes} onChange={event => update({ minutes: event.target.value })} /></label>
      <label>证据深度 <select value={draft.evidenceDepth} onChange={event => update({ evidenceDepth: event.target.value as PresentationBrief['evidenceDepth'] })}><option value="overview">概览</option><option value="supported">有据可查</option><option value="detailed">详细</option></select></label>
    </fieldset>
    <div className="slides-guide-actions"><button disabled={!ready || !dirty} onClick={() => { blocked.current = false; void save() }}>保存／重试</button><button onClick={exportDraft}>导出简报草稿</button><button disabled={!dirty} onClick={() => void reload()}>放弃草稿并重新读取</button><span role="status">{message}</span></div>
    <details><summary>制作原则与提示词</summary><textarea readOnly value={guidance.prompt} rows={10} aria-label="制作提示词" /><button onClick={() => void navigator.clipboard.writeText(guidance.prompt).catch(() => setMessage('复制不可用，可手动选择提示词。'))}>复制提示词</button></details>
    <section><h3>审阅提示（{review.issues.length}）</h3><ul>{review.issues.map((issue, index) => <li key={`${issue.slidePath}-${index}`}><button onClick={() => { setActiveSlide(issue.slidePath); if (issue.elementId) select([issue.elementId]); void close() }}>第 {issue.slideIndex} 页：{issue.message} {issue.suggestion}</button></li>)}</ul><details><summary>人工核对</summary><ul>{review.manualChecks.map(item => <li key={item}>{item}</li>)}</ul></details></section>
  </section></div>
}
