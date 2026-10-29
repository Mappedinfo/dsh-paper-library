import { assertDocument, type DeckDocument, type Slide, type SlideElement, type Theme } from './schema.js'
import { BASE_CANVAS, createLayoutElements, getThemePreset, type LayoutPresetId } from './presets.js'
import { PROJECT_PATHS } from './project-paths.js'
import { resolveLocale, type DeckLocale } from './i18n.js'

import { PlainDeckError } from './errors.js'
export type DeckTemplateId = 'showcase' | 'pitch' | 'blank' | 'paper-reading' | 'nature-methods' | 'flowchart' | 'data-story' | 'course-lecture'

export interface DeckTemplatePreset {
  id: DeckTemplateId
  name: string
  description: string
  slideCount: number
}

export interface CreateDeckTemplateOptions {
  title?: string
  id?: string
  theme?: string | Theme
  /** Deck copy language; `resolveLocale` semantics when omitted defaults to Chinese (CLI/back-compat). */
  lang?: DeckLocale
}

export const deckTemplatePresets: DeckTemplatePreset[] = [
  { id: 'flowchart', name: 'Flow diagrams', description: '五页流程叙事：流水线、判断分支、回环与检查清单', slideCount: 5 },
  { id: 'data-story', name: 'Data story', description: '六页数据叙事：用关键数字与对照改变一个判断', slideCount: 6 },
  { id: 'course-lecture', name: 'Course lecture', description: '六页课程讲义：目标、概念、例证、误区与回顾', slideCount: 6 },
  { id: 'showcase', name: 'Editorial showcase', description: '五页叙事骨架，适合介绍、报告与作品展示', slideCount: 5 },
  { id: 'pitch', name: 'Focused pitch', description: '问题、方案、证据与行动的五页提案', slideCount: 5 },
  { id: 'blank', name: 'Minimal start', description: '只有一张精心排版的封面', slideCount: 1 },
  { id: 'paper-reading', name: 'Paper reading', description: '论文解读八页：问题、贡献、证据、对比、局限与 takeaway', slideCount: 8 },
  { id: 'nature-methods', name: 'Nature methods', description: '证据优先的方法汇报：问题、流程、图表、边界与结论', slideCount: 7 },
]

const deckTemplateMeta = {
  en: {
    showcase: ['Five-slide narrative skeleton for intros, reports and showcases'],
    pitch: ['A five-slide proposal: problem, solution, evidence and action'],
    blank: ['Just one beautifully typeset cover'],
    flowchart: ['Five slides that draw the process: pipeline, decision branch, loop-back and checklist'],
    'data-story': ['Six pages that let one number change one judgment: hook, metric, comparison and takeaways'],
    'course-lecture': ['Six teaching pages: goals, one core concept, a worked example, pitfalls and recap'],
    'paper-reading': ['Eight pages for reading a paper: problem, contributions, evidence, comparison, limits and takeaway'],
    'nature-methods': ['Evidence-led methods talk: question, process, figures, boundaries and conclusion'],
  },
} satisfies Record<'en', Record<DeckTemplateId, [string]>>

export function deckTemplatePresetsFor(locale: DeckLocale): DeckTemplatePreset[] {
  if (locale === 'zh') return deckTemplatePresets
  return deckTemplatePresets.map(preset => ({ ...preset, description: deckTemplateMeta.en[preset.id][0] }))
}

const frame = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })
const text = (id: string, value: string, x: number, y: number, w: number, h: number, options: Partial<Extract<SlideElement, { type: 'text' }>> = {}): SlideElement => ({ id, type: 'text', frame: frame(x, y, w, h), text: value, ...options })
const shape = (id: string, x: number, y: number, w: number, h: number, fill: string, options: Partial<Extract<SlideElement, { type: 'shape' }>> = {}): SlideElement => ({ id, type: 'shape', frame: frame(x, y, w, h), shape: 'rectangle', fill, ...options })

function slug(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return normalized || 'plaindeck-project'
}

function copyFor(template: 'showcase' | 'pitch', title: string, locale: DeckLocale) {
  if (template === 'pitch') return locale === 'zh' ? {
    coverKicker: 'FOCUSED PITCH / FIVE SLIDES', coverTitle: title, coverSubtitle: '把问题、方案与下一步压缩成一条清晰的决策路径。',
    thesisKicker: '01 / THE PROBLEM', thesis: '先描述一个真实、具体、值得解决的问题。', thesisNote: '谁在何时遇到它？现有方案为什么仍然不够？',
    pillarsTitle: '方案必须同时回答三件事', cards: [['01', '价值\n解决什么'], ['02', '机制\n如何做到'], ['03', '差异\n为何是你']],
    evidenceTitle: '用一个证据降低不确定性', evidenceBody: '替换左侧图片或图表，说明它支持的结论、适用条件与证据来源。', metric: '待补', metricLabel: '填入已核验的指标与单位',
    closeTitle: '明确说出你希望观众做什么。', closeBody: '下一步 · 负责人 · 时间点',
  } : {
    coverKicker: 'FOCUSED PITCH / FIVE SLIDES', coverTitle: title, coverSubtitle: 'Compress the problem, the solution and the next step into one clear path to a decision.',
    thesisKicker: '01 / THE PROBLEM', thesis: 'Start from a real, specific problem worth solving.', thesisNote: 'Who hits it and when? Why do existing solutions still fall short?',
    pillarsTitle: 'A solution must answer three things at once', cards: [['01', 'Value\nWhat it solves'], ['02', 'Mechanism\nHow it works'], ['03', 'Edge\nWhy you']],
    evidenceTitle: 'Use one piece of evidence to cut uncertainty', evidenceBody: 'Replace the image or chart here and explain the supported conclusion, conditions and source.', metric: 'TBD', metricLabel: 'Add a verified metric and unit',
    closeTitle: 'Say plainly what you want the audience to do.', closeBody: 'Next step · Owner · Date',
  }
  return locale === 'zh' ? {
    coverKicker: 'EDITORIAL SHOWCASE / PLAINDECK', coverTitle: title, coverSubtitle: '一套为人阅读、为 Agent 编辑、为 Web 播放而设计的开放幻灯片。',
    thesisKicker: '01 / POINT OF VIEW', thesis: '每一页只负责一个值得记住的观点。', thesisNote: '标题给结论，正文给证据；把装饰留给真正需要强调的地方。',
    pillarsTitle: '让叙事拥有清楚的骨架', cards: [['01', '观点\n先说结论'], ['02', '证据\n建立可信度'], ['03', '行动\n给出下一步']],
    evidenceTitle: '让视觉承担一半表达', evidenceBody: '使用本地图片、图表或研究结果。导出 HTML 时可嵌入资源，分享一个真正独立的文件。', metric: '1:1', metricLabel: '内容与视觉同等重要',
    closeTitle: '以明确的结论和下一步收尾。', closeBody: '打开编辑器 · 替换内容 · 讲出你的版本',
  } : {
    coverKicker: 'EDITORIAL SHOWCASE / PLAINDECK', coverTitle: title, coverSubtitle: 'An open slide format designed to be read by people, edited by agents and played on the web.',
    thesisKicker: '01 / POINT OF VIEW', thesis: 'Every slide argues one point worth remembering.', thesisNote: 'Give the headline a conclusion and the body evidence; save decoration for what truly needs emphasis.',
    pillarsTitle: 'Give your story a clear skeleton', cards: [['01', 'Point\nLead with it'], ['02', 'Evidence\nEarn trust'], ['03', 'Action\nName the next step']],
    evidenceTitle: 'Let visuals carry half the message', evidenceBody: 'Use local images, charts or research results. HTML export embeds resources so you can share one truly self-contained file.', metric: '1:1', metricLabel: 'Content and visuals matter equally',
    closeTitle: 'End with a clear conclusion and next step.', closeBody: 'Open the editor · Replace the copy · Tell your version',
  }
}

function storySlides(template: 'showcase' | 'pitch', theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const copy = copyFor(template, title, locale)
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'showcase-cover', background: { color: c.background }, elements: [
      shape('accent-panel', 0, 0, 420, 900, c.accent),
      text('panel-mark', 'PLAIN\nDECK', 62, 76, 300, 170, { fontSize: 62, fontWeight: 800, color: c.background }),
      text('panel-index', '01 — 05', 62, 756, 280, 50, { fontSize: 20, fontWeight: 700, color: c.background }),
      text('kicker', copy.coverKicker, 510, 78, 880, 42, { fontSize: 18, fontWeight: 800, color: c.accent }),
      text('title', copy.coverTitle, 510, 188, 980, 260, { styleRef: 'slide-title', fontSize: 84, fontWeight: 800, color: c.text }),
      shape('rule', 510, 530, 980, 4, c.text),
      text('subtitle', copy.coverSubtitle, 510, 588, 890, 130, { fontSize: 30, fontWeight: 500, color: c.muted }),
      text('hint', 'ARROWS TO NAVIGATE · F FOR FULLSCREEN', 510, 790, 900, 34, { fontSize: 16, fontWeight: 700, color: c.muted }),
    ] },
    './slides/002-thesis.json': { id: 'thesis', name: 'Core idea', layoutRef: 'statement', background: { color: c.background }, elements: [
      text('kicker', copy.thesisKicker, 88, 72, 720, 40, { fontSize: 18, fontWeight: 800, color: c.accent }),
      text('index', '01', 1260, 46, 252, 150, { fontSize: 112, fontWeight: 800, align: 'right', color: c.accent }),
      text('statement', copy.thesis, 88, 230, 1240, 275, { styleRef: 'slide-title', fontSize: 76, fontWeight: 800, color: c.text }),
      shape('rule', 88, 622, 1424, 3, c.text),
      text('context', copy.thesisNote, 88, 682, 1180, 90, { fontSize: 28, fontWeight: 500, color: c.muted }),
    ] },
    './slides/003-structure.json': { id: 'structure', name: 'Structure', layoutRef: 'three-cards', background: { color: c.background }, elements: [
      text('kicker', '02 / STRUCTURE', 80, 64, 600, 36, { fontSize: 18, fontWeight: 800, color: c.accent }),
      text('title', copy.pillarsTitle, 80, 122, 1200, 95, { styleRef: 'slide-title', fontSize: 60, fontWeight: 800, color: c.text }),
      ...copy.cards.flatMap(([number, label], index) => {
        const x = 80 + index * 510; const fill = index === 0 ? c.accent : index === 1 ? c.text : c.background; const labelColor = index < 2 ? c.background : c.text
        return [
          shape(`card-${index + 1}`, x, 280, 440, 430, fill, { shape: 'rounded-rectangle', radius: 24, stroke: index === 2 ? c.text : undefined, strokeWidth: index === 2 ? 3 : 0 }),
          text(`card-number-${index + 1}`, number, x + 38, 316, 160, 52, { fontSize: 24, fontWeight: 800, color: labelColor }),
          text(`card-label-${index + 1}`, label, x + 38, 430, 340, 170, { fontSize: 44, fontWeight: 800, color: labelColor }),
        ]
      }),
      text('footer', 'ONE SLIDE · ONE JOB · ONE CLEAR NEXT STEP', 80, 786, 1440, 36, { fontSize: 17, fontWeight: 800, align: 'center', color: c.muted }),
    ] },
    './slides/004-evidence.json': { id: 'evidence', name: 'Evidence', layoutRef: 'image-right', background: { color: c.background }, elements: [
      { id: 'visual', type: 'image', frame: frame(0, 0, 900, 900), src: 'placeholder:image', fit: 'cover', alt: 'Replace with evidence' },
      text('kicker', '03 / EVIDENCE', 990, 76, 500, 36, { fontSize: 18, fontWeight: 800, color: c.accent }),
      text('title', copy.evidenceTitle, 990, 148, 510, 170, { styleRef: 'slide-title', fontSize: 52, fontWeight: 800, color: c.text }),
      text('body', copy.evidenceBody, 990, 372, 500, 175, { fontSize: 25, fontWeight: 500, color: c.muted }),
      shape('metric-rule', 990, 602, 500, 3, c.text),
      text('metric', copy.metric, 990, 636, 220, 120, { fontSize: 82, fontWeight: 800, color: c.accent }),
      text('metric-label', copy.metricLabel, 1216, 654, 274, 86, { fontSize: 21, fontWeight: 700, color: c.text, verticalAlign: 'middle' }),
    ] },
    './slides/005-close.json': { id: 'close', name: 'Close', layoutRef: 'section', background: { color: c.text }, elements: [
      shape('accent-block', 0, 0, 34, 900, c.accent),
      text('kicker', '04 / THE DECISION', 96, 80, 700, 42, { fontSize: 18, fontWeight: 800, color: c.accent }),
      text('title', copy.closeTitle, 96, 220, 1270, 260, { styleRef: 'slide-title', fontSize: 82, fontWeight: 800, color: c.background }),
      shape('rule', 96, 598, 1408, 3, c.accent),
      text('body', copy.closeBody, 96, 660, 1200, 70, { fontSize: 29, fontWeight: 600, color: c.muted }),
      text('end', 'END / 05', 1320, 768, 184, 46, { fontSize: 19, fontWeight: 800, align: 'right', color: c.accent }),
    ] },
  }
}

/** Build a slide from a layout preset, overriding placeholder text by element id. */
function layoutSlide(id: string, name: string, layoutId: LayoutPresetId, theme: Theme, overrides: Record<string, string> = {}, locale: DeckLocale = 'zh'): Slide {
  const elements = createLayoutElements(layoutId, theme, BASE_CANVAS, locale).map(element =>
    element.type === 'text' && overrides[element.id] ? { ...element, text: overrides[element.id] } : element)
  return { id, name, layoutRef: layoutId, background: { color: theme.colors.background }, elements }
}

function paperReadingSlides(theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const mono = theme.fonts.mono ?? theme.fonts.body
  const copy = locale === 'zh' ? {
    authors: '作者列表 · 机构',
    statementKicker: '01 / THE PROBLEM',
    statement: '这篇论文要解决的核心问题，\n用一句话说清楚。',
    context: '为什么已有方法在这个问题上仍然不够？',
  } : {
    authors: 'Authors · Affiliations',
    statementKicker: '01 / THE PROBLEM',
    statement: 'State the core problem of this paper\nin one clear sentence.',
    context: 'Why do existing methods still fall short on this problem?',
  }
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'paper-cover', background: { color: c.background }, elements: [
      shape('accent-panel', 0, 0, 420, 900, c.accent),
      text('panel-mark', 'PAPER\nREADING', 62, 76, 320, 170, { fontSize: 56, fontWeight: 800, color: c.background }),
      text('panel-index', '01 — 08', 62, 756, 280, 50, { fontSize: 20, fontWeight: 700, color: c.background, fontFamily: mono }),
      text('kicker', 'VENUE · YEAR · TRACK', 510, 78, 880, 42, { fontSize: 18, fontWeight: 800, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', title, 510, 188, 980, 260, { styleRef: 'slide-title', fontSize: 80, fontWeight: 800, color: c.text }),
      shape('rule', 510, 530, 980, 4, c.text),
      text('authors', copy.authors, 510, 588, 890, 60, { fontSize: 28, fontWeight: 500, color: c.muted }),
      text('hint', 'ONE PAPER · ONE READING · EIGHT SLIDES', 510, 790, 900, 34, { fontSize: 16, fontWeight: 700, color: c.muted, fontFamily: mono, letterSpacing: 2 }),
    ] },
    './slides/002-problem.json': layoutSlide('problem', 'Problem', 'statement', theme, {
      kicker: copy.statementKicker, index: '01',
      statement: copy.statement,
      context: copy.context,
    }),
    './slides/003-contributions.json': layoutSlide('contributions', 'Contributions', 'contributions', theme, { kicker: '02 / CONTRIBUTIONS' }, locale),
    './slides/004-figure.json': layoutSlide('figure', 'Key figure', 'paper-figure', theme, { kicker: '03 / EVIDENCE · FIGURE' }, locale),
    './slides/005-table.json': layoutSlide('table', 'Key table', 'paper-table', theme, { kicker: '04 / EVIDENCE · TABLE' }, locale),
    './slides/006-versus.json': layoutSlide('versus', 'Comparison', 'versus', theme, { kicker: '05 / COMPARISON' }, locale),
    './slides/007-limits.json': layoutSlide('limits', 'Limitations', 'limits', theme, { kicker: '06 / LIMITATIONS' }, locale),
    './slides/008-closing.json': layoutSlide('closing', 'Takeaway', 'closing', theme, { kicker: '07 / TAKEAWAY' }, locale),
  }
}

function natureMethodsSlides(theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const mono = theme.fonts.mono ?? theme.fonts.body
  const copy = locale === 'zh' ? {
    subtitle: '用问题、方法、证据与边界组织一场可信的学术汇报。',
    problemTitle: '现有方法在哪个关键条件下仍然不够？',
    problemClaim: '把研究缺口写成一个具体、可验证的瓶颈。',
    problemBoundary: '限定对象、条件与失败方式；下一页的方法必须逐项回应这些条件。',
    methodTitle: '方法流程直接对应问题中的四个约束',
    methodStages: ['输入与假设', '核心机制', '验证设计', '可复用输出'],
    methodBodies: ['定义输入、假设与适用边界。', '说明关键变换与作用路径。', '用数据、基线与消融建立证据。', '输出可复查结果与使用边界。'],
    methodTakeaway: '每个阶段都应留下可检查的输入、输出或证据。',
    figureTitle: '主图必须直接支撑本页结论',
    tableTitle: '比较表只保留改变判断的指标',
    boundariesTitle: '可信结论同时说明证据覆盖与失效条件',
    boundaryItems: [
      ['01', '证据覆盖', '哪些数据、场景与比较已经被实验直接支持？'],
      ['02', '失效条件', '哪些假设一旦不成立，方法表现就可能改变？'],
      ['03', '仍待验证', '哪些外推、机制解释或应用判断仍是开放问题？'],
    ] as Array<[string, string, string]>,
    boundariesTakeaway: '结论强度不能超过证据覆盖范围。',
    closingQuote: '方法的价值，\n体现在证据对判断的推进。',
    closingNext: '下一步：替换占位证据，核对来源，并把未验证的部分明确标出。',
  } : {
    subtitle: 'Organize a credible academic talk around question, method, evidence and boundaries.',
    problemTitle: 'Under which key condition do existing methods fall short?',
    problemClaim: 'Frame the research gap as a specific, verifiable bottleneck.',
    problemBoundary: 'Pin down subjects, conditions and failure modes; the next slide must answer each one.',
    methodTitle: 'The method maps directly onto the four constraints above',
    methodStages: ['Inputs & assumptions', 'Core mechanism', 'Validation design', 'Reusable outputs'],
    methodBodies: ['Define inputs, assumptions and scope.', 'Explain the key transformation and how it acts.', 'Build evidence with data, baselines and ablations.', 'Deliver results others can re-check.'],
    methodTakeaway: 'Every stage should leave inspectable inputs, outputs or evidence.',
    figureTitle: 'The key figure must directly support this slide’s claim',
    tableTitle: 'Keep only the metrics that change the verdict',
    boundariesTitle: 'A credible conclusion states both coverage and failure modes',
    boundaryItems: [
      ['01', 'Evidence coverage', 'Which data, settings and comparisons do experiments directly support?'],
      ['02', 'Failure conditions', 'Which assumptions, once broken, could change how the method performs?'],
      ['03', 'Still open', 'Which extrapolations, mechanistic claims or applications remain open questions?'],
    ] as Array<[string, string, string]>,
    boundariesTakeaway: 'A conclusion is never stronger than its evidence.',
    closingQuote: 'A method earns its value through\nevidence that advances understanding.',
    closingNext: 'Next: replace placeholder evidence, check sources, and clearly mark what remains unverified.',
  }
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'nature-cover', background: { color: c.background }, elements: [
      shape('accent-rule', 88, 76, 8, 748, c.accent),
      text('kicker', 'METHODS / EVIDENCE-LED DECK', 132, 82, 920, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', title, 132, 204, 1240, 250, { styleRef: 'slide-title', fontSize: 72, fontWeight: 700, color: c.text, fit: 'shrink' }),
      text('subtitle', copy.subtitle, 132, 520, 1080, 80, { fontSize: 28, fontWeight: 400, color: c.muted }),
      shape('metadata-rule', 132, 706, 1380, 2, c.muted),
      text('metadata', 'AUTHOR · AFFILIATION · VENUE · YEAR', 132, 738, 1180, 32, { fontSize: 15, fontWeight: 600, color: c.muted, fontFamily: mono, letterSpacing: 1.5 }),
      text('page', '01', 1370, 738, 142, 40, { fontSize: 23, fontWeight: 700, color: c.accent, fontFamily: mono, align: 'right' }),
    ] },
    './slides/002-problem.json': { id: 'problem', name: 'Problem', layoutRef: 'claim-led', background: { color: c.background }, elements: [
      text('kicker', '01 / BOTTLENECK', 88, 62, 720, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', copy.problemTitle, 88, 142, 1260, 146, { styleRef: 'slide-title', fontSize: 58, fontWeight: 700, color: c.text, fit: 'shrink' }),
      text('claim', copy.problemClaim, 88, 382, 1130, 118, { fontSize: 38, fontWeight: 600, color: c.text, lineHeight: 1.32 }),
      shape('claim-rule', 88, 548, 170, 7, c.accent),
      text('boundary', copy.problemBoundary, 88, 602, 1140, 90, { fontSize: 25, color: c.muted, lineHeight: 1.45 }),
      text('index', '02', 1354, 96, 158, 80, { fontSize: 52, fontWeight: 700, color: c.surface, fontFamily: mono, align: 'right' }),
    ] },
    './slides/003-method.json': { id: 'method', name: 'Method', layoutRef: 'process-wide', background: { color: c.background }, elements: [
      text('kicker', '02 / METHOD', 88, 56, 720, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', copy.methodTitle, 88, 112, 1340, 76, { styleRef: 'slide-title', fontSize: 48, fontWeight: 700, color: c.text, fit: 'shrink' }),
      ...copy.methodStages.flatMap((label, index): SlideElement[] => {
        const x = 88 + index * 374
        return [
          { id: `stage-${index + 1}-number`, type: 'text', frame: frame(x, 276, 110, 46), text: `0${index + 1}`, fontSize: 23, fontWeight: 700, color: c.accent, fontFamily: mono },
          { id: `stage-${index + 1}-title`, type: 'text', frame: frame(x, 350, 300, 52), text: label, fontSize: 30, fontWeight: 700, color: c.text },
          { id: `stage-${index + 1}-body`, type: 'text', frame: frame(x, 430, 300, 148), text: copy.methodBodies[index], fontSize: 22, color: c.muted, lineHeight: 1.45 },
          { id: `stage-${index + 1}-rule`, type: 'shape', frame: frame(x, 620, 300, index === 3 ? 7 : 3), shape: 'rectangle', fill: index === 3 ? c.accent : c.muted, opacity: index === 3 ? 1 : .45 },
          ...(index < 3 ? [{ id: `stage-${index + 1}-arrow`, type: 'line', frame: frame(x + 304, 452, 56, 2), color: c.accent, strokeWidth: 2, arrowEnd: true } as SlideElement] : []),
        ]
      }),
      text('takeaway', copy.methodTakeaway, 88, 736, 1320, 58, { fontSize: 26, fontWeight: 600, color: c.text }),
    ] },
    './slides/004-figure.json': layoutSlide('figure', 'Key figure', 'paper-figure', theme, { kicker: '03 / EVIDENCE · FIGURE', title: copy.figureTitle }, locale),
    './slides/005-table.json': layoutSlide('table', 'Key table', 'paper-table', theme, { kicker: '04 / EVIDENCE · TABLE', title: copy.tableTitle }, locale),
    './slides/006-boundaries.json': { id: 'boundaries', name: 'Boundaries', layoutRef: 'discussion', background: { color: c.background }, elements: [
      text('kicker', '05 / BOUNDARIES', 88, 58, 720, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', copy.boundariesTitle, 88, 118, 1350, 76, { styleRef: 'slide-title', fontSize: 48, fontWeight: 700, color: c.text, fit: 'shrink' }),
      ...copy.boundaryItems.flatMap(([number, heading, body], index): SlideElement[] => {
        const y = 284 + index * 156
        return [
          { id: `boundary-${index + 1}-number`, type: 'text', frame: frame(88, y, 100, 48), text: number, fontSize: 23, fontWeight: 700, color: c.accent, fontFamily: mono },
          { id: `boundary-${index + 1}-title`, type: 'text', frame: frame(226, y, 300, 48), text: heading, fontSize: 29, fontWeight: 700, color: c.text },
          { id: `boundary-${index + 1}-body`, type: 'text', frame: frame(558, y, 890, 74), text: body, fontSize: 23, color: c.muted, lineHeight: 1.4 },
          { id: `boundary-${index + 1}-rule`, type: 'line', frame: frame(226, y + 104, 1222, 2), color: c.muted, strokeWidth: 1, opacity: .35 },
        ]
      }),
      shape('boundary-anchor', 88, 770, 8, 58, c.accent),
      text('boundary-takeaway', copy.boundariesTakeaway, 124, 770, 1120, 58, { fontSize: 27, fontWeight: 600, color: c.text, verticalAlign: 'middle' }),
    ] },
    './slides/007-closing.json': { id: 'closing', name: 'Takeaway', layoutRef: 'closing', background: { color: c.background }, elements: [
      text('kicker', 'TAKEAWAY / ONE CLAIM', 88, 72, 720, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('quote', copy.closingQuote, 88, 262, 1300, 210, { styleRef: 'slide-title', fontSize: 62, fontWeight: 700, color: c.text, fit: 'shrink' }),
      shape('rule', 88, 584, 1424, 4, c.accent),
      text('next', copy.closingNext, 88, 646, 1260, 72, { fontSize: 27, color: c.muted }),
      text('end', 'END / 07', 1300, 790, 212, 34, { fontSize: 17, fontWeight: 700, color: c.accent, fontFamily: mono, align: 'right', letterSpacing: 2 }),
    ] },
  }
}

const defaultTitles: Record<DeckLocale, Partial<Record<DeckTemplateId, string>>> = {
  zh: { 'paper-reading': '论文标题：一句话说清核心贡献', 'nature-methods': '方法标题：一句话说清解决了什么', flowchart: '流程标题：把过程画成一张图', 'data-story': '数据故事：用一个数字改变判断', 'course-lecture': '课程讲义：把一个概念真正讲透' },
  en: { 'paper-reading': 'Paper headline: the core contribution in one sentence', 'nature-methods': 'Methods headline: what was solved, in one clear sentence', flowchart: 'Flow headline: turn the process into one picture', 'data-story': 'A data story: change one judgment with one number', 'course-lecture': 'One lecture: teach a single concept until it sticks' },
}

function flowchartSlides(theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const mono = theme.fonts.mono ?? theme.fonts.body
  const copy = locale === 'zh' ? {
    kicker: 'FLOWCHART / PROCESS AS DIAGRAM',
    subtitle: '用节点、箭头与回环把隐性的过程显性化。',
    hint: 'NODES · BRANCHES · LOOPS',
    deckTitle: '流程图脚本',
    cardsTitle: '画流程图的四条纪律',
    card1Title: '一图一事',
    card1Body: '一张图只回答一个问题；多条流水线就拆成多页。',
    card2Title: '出口要画出来',
    card2Body: '失败、打回与边界路径和成功路径同等重要，必须落在图上。',
    card3Title: '回环要有终止条件',
    card3Body: '每次循环都应减少不确定性，并写明何时停。',
    closingQuote: '把过程画清楚，\n分歧自然就消失了。',
    closingNext: '下一步：套用本模板的流水线页与分支页，替换为你真实的步骤。',
  } : {
    kicker: 'FLOWCHART / PROCESS AS DIAGRAM',
    subtitle: 'Make the invisible process explicit with nodes, arrows and loop-backs.',
    hint: 'NODES · BRANCHES · LOOPS',
    deckTitle: 'Flow script',
    cardsTitle: 'Four disciplines for drawing a process',
    card1Title: 'One question per diagram',
    card1Body: 'A single diagram answers a single question; split extra pipelines onto more pages.',
    card2Title: 'Draw every exit',
    card2Body: 'Failure, rejection and boundary paths matter as much as the happy path.',
    card3Title: 'Loops need stopping rules',
    card3Body: 'Each cycle should reduce uncertainty and say when to stop.',
    closingQuote: 'When the process is drawn clearly,\ndisagreement fades on its own.',
    closingNext: 'Next: reuse the pipeline and branch pages in this template with your real steps.',
  }
  const chipLabels = locale === 'zh' ? ['输入', '分支', '回环'] : ['Input', 'Branch', 'Loop']
  const nodeChips: SlideElement[] = chipLabels.flatMap((label, index): SlideElement[] => {
    const x = 510 + index * 196
    return [
      { id: `chip-${index + 1}`, type: 'shape', frame: frame(x, 584, 148, 60), shape: 'rounded-rectangle', radius: 14, fill: c.background, stroke: c.accent, strokeWidth: 2, text: label, textColor: c.accent, fontSize: 21, fontWeight: 700 },
      ...(index < 2 ? [{ id: `chip-arrow-${index + 1}`, type: 'line', frame: frame(x + 156, 612, 32, 3), color: c.muted, strokeWidth: 2.5, arrowEnd: true } as SlideElement] : []),
    ]
  })
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'flow-cover', background: { color: c.background }, elements: [
      shape('accent-panel', 0, 0, 420, 900, c.accent),
      text('panel-mark', 'FLOW\nCHART', 62, 76, 320, 170, { fontSize: 56, fontWeight: 800, color: c.background }),
      text('panel-index', '01 — 05', 62, 756, 280, 50, { fontSize: 20, fontWeight: 700, color: c.background, fontFamily: mono }),
      text('kicker', copy.kicker, 510, 78, 880, 42, { fontSize: 18, fontWeight: 800, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', title, 510, 188, 980, 260, { styleRef: 'slide-title', fontSize: 80, fontWeight: 800, color: c.text }),
      shape('rule', 510, 470, 980, 4, c.text),
      text('subtitle', copy.subtitle, 510, 512, 890, 120, { fontSize: 28, fontWeight: 500, color: c.muted }),
      ...nodeChips,
      text('hint', copy.hint, 510, 790, 900, 34, { fontSize: 16, fontWeight: 700, color: c.muted, fontFamily: mono, letterSpacing: 2 }),
    ] },
    './slides/002-pipeline.json': layoutSlide('pipeline', 'Pipeline', 'process-flow', theme, {}, locale),
    './slides/003-branch.json': layoutSlide('branch', 'Branch & loop', 'decision-branch', theme, {}, locale),
    './slides/004-discipline.json': (() => {
      const slide = layoutSlide('discipline', 'Checklist', 'three-cards', theme, {
        kicker: '04 / CHECKLIST',
        title: copy.cardsTitle,
      }, locale)
      const titles = [copy.card1Title, copy.card2Title, copy.card3Title]
      const bodies = [copy.card1Body, copy.card2Body, copy.card3Body]
      const mapped = slide.elements.map(element => {
        if (!element.id.startsWith('card-') || element.type !== 'shape') return element
        const index = Number(element.id.slice(-1)) - 1
        return { ...element, text: `0${index + 1}\n${titles[index]}\n${bodies[index]}`, fontSize: 24, fontWeight: 700 }
      })
      return { ...slide, elements: mapped }
    })(),
    './slides/005-closing.json': layoutSlide('closing', 'Closing', 'closing', theme, { quote: copy.closingQuote, attribution: copy.closingNext }, locale),
  }
}
function dataStorySlides(theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const mono = theme.fonts.mono ?? theme.fonts.body
  const copy = locale === 'zh' ? {
    kicker: 'DATA STORY / NUMBERS FIRST',
    subtitle: '一个数字、一次对照、一句结论。',
    hookLead: '先给判断，再给数字：本页只论证一件事。',
    hookSupport: '把最重要的结论写成超大标题。\n\n下面两段给出支撑：数据来源与口径，以及它为什么改变你此前的看法。',
    metricTitle: '这组数字改变了什么判断',
    cardsTitle: '三条要点撑起整个故事',
    cardTitles: ['口径透明', '对照可信', '结论可执行'],
    cardBodies: ['样本、时间段与统计方式全部写明，拒绝黑箱数字。', '有基线才有意义；没有对照的数字只是装饰。', '每个图表都要落到下一步行动或决策。'],
    closingQuote: '让数字去说服，\n让人去做决定。',
    closingNext: '下一步：替换占位数字与来源，核对每一个口径。',
  } : {
    kicker: 'DATA STORY / NUMBERS FIRST',
    subtitle: 'One number, one comparison, one conclusion.',
    hookLead: 'Judgment first, numbers second — this page argues exactly one thing.',
    hookSupport: 'Write the most important conclusion as the oversized headline.\n\nThe two paragraphs below carry the support: where the data comes from and why it should change your prior view.',
    metricTitle: 'What judgment does this number change?',
    cardsTitle: 'Three points that hold the story together',
    cardTitles: ['Transparent sourcing', 'Credible comparison', 'Actionable conclusion'],
    cardBodies: ['State the sample, the window and the method; no black-box numbers.', 'A number means nothing without a baseline; comparisons make it evidence.', 'Every chart must land on a next action or decision.'],
    closingQuote: 'Let the numbers persuade\nso people can decide.',
    closingNext: 'Next: replace placeholder figures and sources, then verify every definition.',
  }
  const chipLabels = locale === 'zh' ? ['口径', '对照', '结论'] : ['Source', 'Compare', 'Conclude']
  const nodeChips: SlideElement[] = chipLabels.flatMap((label, index): SlideElement[] => {
    const x = 176 + index * 196
    return [
      { id: `chip-${index + 1}`, type: 'shape', frame: frame(x, 620, 148, 60), shape: 'rounded-rectangle', radius: 14, fill: c.background, stroke: c.accent, strokeWidth: 2, text: label, textColor: c.accent, fontSize: 21, fontWeight: 700 },
      ...(index < 2 ? [{ id: `chip-arrow-${index + 1}`, type: 'line', frame: frame(x + 156, 648, 32, 3), color: c.muted, strokeWidth: 2.5, arrowEnd: true } as SlideElement] : []),
    ]
  })
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'data-cover', background: { color: c.background }, elements: [
      { id: 'accent-rule', type: 'shape', frame: frame(132, 96, 8, 560), shape: 'rectangle', fill: c.accent },
      text('kicker', copy.kicker, 176, 104, 880, 40, { fontSize: 18, fontWeight: 800, color: c.accent, fontFamily: mono, letterSpacing: 2 }),
      text('title', title, 176, 200, 1180, 280, { styleRef: 'slide-title', fontSize: 78, fontWeight: 800, color: c.text }),
      shape('rule', 176, 500, 1140, 4, c.text),
      text('subtitle', copy.subtitle, 176, 542, 860, 110, { fontSize: 28, fontWeight: 500, color: c.muted }),
      ...nodeChips,
      text('hint', 'SOURCES · BASELINE · ACTION', 176, 790, 900, 34, { fontSize: 16, fontWeight: 700, color: c.muted, fontFamily: mono, letterSpacing: 2 }),
    ] },
    './slides/002-hook.json': layoutSlide('hook', 'Hook', 'hook-statement', theme, { heading: locale === 'zh' ? '结论先行：一页只论证一件事' : 'Conclusion first: one claim per slide', lead: copy.hookLead, support: copy.hookSupport }, locale),
    './slides/003-metric.json': layoutSlide('metric', 'Key metric', 'metric', theme, {}, locale),
    './slides/004-versus.json': layoutSlide('versus', 'Comparison', 'versus', theme, {}, locale),
    './slides/005-points.json': (() => {
      const slide = layoutSlide('points', 'Takeaways', 'three-cards', theme, { title: copy.cardsTitle }, locale)
      return { ...slide, elements: slide.elements.map(element => {
        if (!element.id.startsWith('card-') || element.type !== 'shape') return element
        const index = Number(element.id.slice(-1)) - 1
        return { ...element, text: `0${index + 1}\n${copy.cardTitles[index]}\n${copy.cardBodies[index]}`, fontSize: 24, fontWeight: 700 }
      }) }
    })(),
    './slides/006-closing.json': layoutSlide('closing', 'Closing', 'closing', theme, { quote: copy.closingQuote, attribution: copy.closingNext }, locale),
  }
}

function courseLectureSlides(theme: Theme, title: string, locale: DeckLocale): Record<string, Slide> {
  const c = theme.colors; const mono = theme.fonts.mono ?? theme.fonts.body
  const copy = locale === 'zh' ? {
    kicker: 'LECTURE / TEACH IT CLEARLY',
    subtitle: '目标 · 概念 · 例证 · 误区 · 回顾。',
    goalsTitle: '这节课解决什么',
    agendaTitle: '课程路线图',
    conceptLead: '用一个生活类比打开概念。',
    exampleKicker: '03 / WORKED EXAMPLE',
    pitfallsTitle: '常见误区：在哪里最容易走偏',
    recapQuote: '能用一句话讲给别人听，\n才算真的学会了。',
    recapNext: '课后练习：向同学复述本节概念，并互相追问一个“为什么”。',
    hint: 'GOALS · CONCEPT · EXAMPLE · RECAP',
  } : {
    kicker: 'LECTURE / TEACH IT CLEARLY',
    subtitle: 'Goals · Concept · Example · Pitfalls · Recap.',
    goalsTitle: 'What this session solves',
    agendaTitle: 'The route map for today',
    conceptLead: 'Open the concept with an everyday analogy.',
    exampleKicker: '03 / WORKED EXAMPLE',
    pitfallsTitle: 'Common pitfalls: where learners drift',
    recapQuote: 'If you cannot explain it in one sentence,\nyou have not learned it yet.',
    recapNext: 'Homework: retell today’s concept to a classmate and ask each other one “why”.',
    hint: 'GOALS · CONCEPT · EXAMPLE · RECAP',
  }
  return {
    './slides/001-cover.json': { id: 'cover', name: 'Cover', layoutRef: 'lecture-cover', background: { color: c.background }, elements: [
      shape('accent-block', 0, 0, 1600, 14, c.accent),
      text('kicker', copy.kicker, 132, 120, 880, 40, { fontSize: 18, fontWeight: 800, color: c.accent, letterSpacing: 2 }),
      text('title', title, 132, 210, 1240, 260, { styleRef: 'slide-title', fontSize: 76, fontWeight: 800, color: c.text }),
      shape('rule', 132, 494, 1336, 3, c.text),
      text('subtitle', copy.subtitle, 132, 536, 900, 70, { fontSize: 28, fontWeight: 500, color: c.muted }),
      text('page', '01', 1370, 738, 142, 50, { fontSize: 26, fontWeight: 700, color: c.accent, fontFamily: mono, align: 'right' }),
      text('hint', copy.hint, 132, 780, 900, 34, { fontSize: 15, fontWeight: 700, color: c.muted, fontFamily: mono, letterSpacing: 2 }),
    ] },
    './slides/002-agenda.json': (() => {
      const slide = layoutSlide('agenda', 'Agenda', 'three-cards', theme, { title: copy.agendaTitle }, locale)
      return { ...slide, elements: slide.elements.map((element): SlideElement => {
        if (!element.id.startsWith('card-') || element.type !== 'shape') return element
        const index = Number(element.id.slice(-1)) - 1
        const items = locale === 'zh'
          ? [['01', '学习目标', '先说清这节课结束时你能做什么。'], ['02', '核心概念', '一个定义 + 一个类比 + 一张图。'], ['03', '巩固路径', '例证 → 练习 → 复述检验。']][index]
          : [['01', 'Learning goal', 'State what you will be able to do afterwards.'], ['02', 'Core concept', 'One definition + one analogy + one diagram.'], ['03', 'Consolidation', 'Example → practice → retell it back.']][index]
        return { ...element, text: `${items[0]}\n${items[1]}\n${items[2]}`, fontSize: 24 }
      }) }
    })(),
    './slides/003-concept.json': layoutSlide('concept', 'Concept', 'hook-statement', theme, { lead: copy.conceptLead }, locale),
    './slides/004-example.json': layoutSlide('example', 'Worked example', 'paper-figure', theme, { kicker: copy.exampleKicker }, locale),
    './slides/005-pitfalls.json': layoutSlide('pitfalls', 'Pitfalls', 'limits', theme, { title: copy.pitfallsTitle }, locale),
    './slides/006-recap.json': layoutSlide('recap', 'Recap', 'takeaway', theme, { quote: copy.recapQuote, attribution: copy.recapNext }, locale),
  }
}
export function createDeckTemplate(templateId: DeckTemplateId = 'showcase', options: CreateDeckTemplateOptions = {}): DeckDocument {
  if (!deckTemplatePresets.some(template => template.id === templateId)) throw new PlainDeckError('unknown-template', { zh: `未知模板：${templateId}`, en: `Unknown template: ${templateId}` })
  const preset = typeof options.theme === 'string' ? getThemePreset(options.theme) : undefined
  if (typeof options.theme === 'string' && !preset) throw new PlainDeckError('unknown-theme', { zh: `未知主题：${options.theme}`, en: `Unknown theme: ${options.theme}` })
  const locale = resolveLocale(options.lang ?? 'zh')
  const defaultTheme = templateId === 'paper-reading' || templateId === 'nature-methods' ? 'nature-editorial' : 'studio-cobalt'
  const theme = structuredClone(typeof options.theme === 'object' ? options.theme : preset?.theme ?? getThemePreset(defaultTheme)!.theme)
  const fallbackTitle = defaultTitles[locale][templateId] ?? (templateId === 'pitch' ? 'A focused idea, ready to move.' : templateId === 'blank' ? 'Untitled presentation' : 'Make the idea visible.')
  const title = options.title?.trim() || fallbackTitle
  const id = options.id?.trim() || slug(title)
  if (templateId === 'blank') {
    const path = `${PROJECT_PATHS.slidesDir}001-cover.json`
    return assertDocument({
      deck: { schemaVersion: '0.1', id, title, canvas: { width: 1600, height: 900 }, theme: PROJECT_PATHS.theme, slides: [path] }, theme,
      slides: { [path]: { id: 'cover', name: 'Cover', layoutRef: 'section', background: { color: theme.colors.background }, elements: [
        text('kicker', 'PLAINDECK / NEW STORY', 88, 76, 760, 40, { fontSize: 18, fontWeight: 800, color: theme.colors.accent }),
        text('title', title, 88, 256, 1280, 220, { styleRef: 'slide-title', fontSize: 86, fontWeight: 800, color: theme.colors.text }),
        shape('rule', 88, 602, 1424, 4, theme.colors.text),
        text('subtitle', 'Add a point of view, then build one slide at a time.', 88, 664, 1120, 70, { fontSize: 28, fontWeight: 500, color: theme.colors.muted }),
        text('page', '01', 1330, 732, 182, 78, { fontSize: 56, fontWeight: 800, align: 'right', color: theme.colors.accent }),
      ] } },
    })
  }
  const slides = templateId === 'paper-reading' ? paperReadingSlides(theme, title, locale) : templateId === 'nature-methods' ? natureMethodsSlides(theme, title, locale) : templateId === 'flowchart' ? flowchartSlides(theme, title, locale) : templateId === 'data-story' ? dataStorySlides(theme, title, locale) : templateId === 'course-lecture' ? courseLectureSlides(theme, title, locale) : storySlides(templateId, theme, title, locale)
  return assertDocument({
    deck: { schemaVersion: '0.1', id, title, canvas: { width: 1600, height: 900 }, theme: PROJECT_PATHS.theme, slides: Object.keys(slides) },
    theme, slides,
  })
}
