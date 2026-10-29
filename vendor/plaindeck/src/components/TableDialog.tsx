import { useMemo, useState } from 'react'
import { ArrowRight, Table2, X } from 'lucide-react'
import { exampleTable, parseTableContent, tableStyles, type TableStyle } from 'plaindeck/core'
import { useEditor } from '../store'
import { useT } from '../i18n'
import { errorText } from '../i18n/errors'

const styleCopy = {
  rules: { name: 'Nature rules', descriptionZh: '无竖线，以表头规则和留白建立层级', descriptionEn: 'No vertical rules; hierarchy comes from the header rule and whitespace' },
  grid: { name: 'Compact grid', descriptionZh: '完整网格，适合参数矩阵与密集清单', descriptionEn: 'A full grid for parameter matrices and dense lists' },
  stripes: { name: 'Quiet stripes', descriptionZh: '弱斑马纹，适合逐行比较', descriptionEn: 'Subtle zebra striping for row-by-row comparison' },
} as const

export function TableDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState(exampleTable)
  const [style, setStyle] = useState<TableStyle>('rules')
  const { t, locale } = useT()
  const parsed = useMemo(() => {
    try { return { content: parseTableContent(source), error: '' } }
    catch (error) { return { content: null, error: errorText(error) } }
  }, [source])
  const addTableSlide = useEditor(state => state.addTableSlide)
  const styleDescription = (value: TableStyle) => locale === 'zh' ? styleCopy[value].descriptionZh : styleCopy[value].descriptionEn

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="summary-dialog table-dialog" role="dialog" aria-label={t.tableDialog.dialogLabel} onMouseDown={event => event.stopPropagation()}>
      <div className="summary-dialog-head">
        <div><span className="eyebrow">NATIVE TABLE / EVIDENCE FIRST</span><h2>{t.tableDialog.title}</h2></div>
        <button onClick={onClose} aria-label={t.common.close}><X /></button>
      </div>
      <div className="summary-workbench table-workbench">
        <section className="summary-content-panel">
          <div className="summary-panel-label"><strong>01 / DATA</strong><span>Markdown · CSV · TSV · JSON</span></div>
          <p>{t.tableDialog.intro}</p>
          <div className="summary-format"><code>{t.tableDialog.exampleTitle}</code><code>{t.tableDialog.headerExample}</code><code>Takeaway:</code><code>Source:</code></div>
          <textarea value={source} onChange={event => setSource(event.target.value)} spellCheck={false} aria-label={t.tableDialog.sourceAria} />
        </section>
        <section className="table-preview-panel">
          <div className="summary-panel-label"><strong>02 / PREVIEW</strong><span>{parsed.content ? `${parsed.content.rows.length} × ${parsed.content.columns.length}` : 'INVALID'}</span></div>
          <div className="table-style-options">{tableStyles.map(value => <button key={value} className={style === value ? 'active' : ''} onClick={() => setStyle(value)}><Table2 /><span><strong>{styleCopy[value].name}</strong><small>{styleDescription(value)}</small></span></button>)}</div>
          <div className={`table-data-preview preview-${style}`}>
            {parsed.content ? <><h3>{parsed.content.title}</h3><div className="table-preview-scroll"><table><thead><tr>{parsed.content.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{parsed.content.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}</tr>)}</tbody></table></div>{parsed.content.takeaway && <p>{parsed.content.takeaway}</p>}</> : <div className="table-preview-error">{parsed.error}</div>}
          </div>
        </section>
      </div>
      <div className="summary-dialog-foot table-dialog-foot">
        <div><strong>{styleCopy[style].name}</strong><small>{t.tableDialog.styleHint}</small></div>
        <span className={parsed.error ? 'invalid' : ''}>{parsed.error || t.tableDialog.parsedRows(parsed.content?.rows.length ?? 0)}</span>
        <button disabled={!parsed.content} onClick={() => { if (!parsed.content) return; addTableSlide(parsed.content, style); onClose() }}><Table2 /> {t.tableDialog.generate} <ArrowRight /></button>
      </div>
    </div>
  </div>
}
