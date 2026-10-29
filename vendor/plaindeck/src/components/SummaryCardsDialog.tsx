import { useMemo, useState } from 'react'
import { ArrowRight, Search, Sparkles, X } from 'lucide-react'
import { designRecipeCategories, designRecipes, exampleSummaryCards, parseSummaryCards } from 'plaindeck/core'
import { useEditor } from '../store'
import { useT } from '../i18n'
import { errorText } from '../i18n/errors'

export function SummaryCardsDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState(exampleSummaryCards)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [style, setStyle] = useState('claudeStyle')
  const { t } = useT()
  const parsed = useMemo(() => {
    try { return { content: parseSummaryCards(source), error: '' } }
    catch (error) { return { content: null, error: errorText(error) } }
  }, [source])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return designRecipes.filter(recipe => (!category || recipe.category.id === category) && (!normalized || `${recipe.id} ${recipe.name} ${recipe.description}`.toLocaleLowerCase().includes(normalized)))
  }, [category, query])
  const selected = designRecipes.find(recipe => recipe.id === style) ?? designRecipes[0]
  const addSummarySlide = useEditor(state => state.addSummarySlide)

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="summary-dialog" role="dialog" aria-label={t.summaryCardsDialog.dialogLabel} onMouseDown={event => event.stopPropagation()}>
      <div className="summary-dialog-head">
        <div><span className="eyebrow">{t.summaryCardsDialog.eyebrow}</span><h2>{t.summaryCardsDialog.title}</h2></div>
        <button onClick={onClose} aria-label={t.common.close}><X /></button>
      </div>
      <div className="summary-workbench">
        <section className="summary-content-panel">
          <div className="summary-panel-label"><strong>{t.summaryCardsDialog.contentStep}</strong><span>{t.summaryCardsDialog.contentFormat}</span></div>
          <p>{t.summaryCardsDialog.privacyHint}</p>
          <div className="summary-format"><code>{t.summaryCardsDialog.formatExampleMain}</code><code>{t.summaryCardsDialog.formatExamplePoint}</code><code>{t.summaryCardsDialog.formatExampleDescription}</code><code>{t.summaryCardsDialog.formatExampleIcon}</code></div>
          <textarea value={source} onChange={event => setSource(event.target.value)} spellCheck={false} aria-label={t.summaryCardsDialog.sourceAria} />
        </section>
        <section className="style-catalog">
          <div className="summary-panel-label"><strong>02 / VISUAL RECIPE</strong><span>{filtered.length} / {designRecipes.length}</span></div>
          <div className="style-filters">
            <label><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t.summaryCardsDialog.searchPlaceholder} aria-label={t.summaryCardsDialog.searchAria} /></label>
            <select value={category} onChange={event => setCategory(event.target.value)} aria-label={t.summaryCardsDialog.categoryAria}><option value="">{t.summaryCardsDialog.categoryAll}</option>{designRecipeCategories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          </div>
          <div className="style-recipe-list">{filtered.map(recipe => <button key={recipe.id} className={recipe.id === style ? 'active' : ''} onClick={() => setStyle(recipe.id)} title={recipe.description}>
            <span className="recipe-swatches">{Object.values(recipe.theme.colors).map((color, index) => <i key={index} style={{ background: color }} />)}</span>
            <span><strong>{recipe.name}</strong><small>{recipe.id} · {recipe.category.name}</small></span>
            <em>{recipe.card.variant}</em>
          </button>)}</div>
        </section>
      </div>
      <div className="summary-dialog-foot">
        <div className="selected-recipe"><span className="recipe-swatches">{Object.values(selected.theme.colors).map((color, index) => <i key={index} style={{ background: color }} />)}</span><span><strong>{selected.name}</strong><small>{selected.description}</small></span></div>
        <span className={parsed.error ? 'invalid' : ''}>{parsed.error || t.summaryCardsDialog.parsedCount(parsed.content?.cards.length ?? 0)}</span>
        <button disabled={!parsed.content} onClick={() => {
          if (!parsed.content) return
          addSummarySlide(parsed.content, selected.id)
          onClose()
        }}><Sparkles /> {t.summaryCardsDialog.generate} <ArrowRight /></button>
      </div>
    </div>
  </div>
}
