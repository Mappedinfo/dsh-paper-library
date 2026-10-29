import type { SlideElement, Theme } from './schema.js'
import { createSummaryCardElements } from './summary-cards.js'
import { BRAND_ACCENT } from './brand.js'
import type { DeckLocale } from './i18n.js'

export type LayoutPresetId = 'blank' | 'title-body' | 'section' | 'statement' | 'metric' | 'two-column' | 'image-right' | 'three-cards' | 'summary-cards' | 'paper-figure' | 'paper-table' | 'versus' | 'contributions' | 'limits' | 'closing' | 'hook-statement' | 'prose-panel' | 'takeaway' | 'process-flow' | 'decision-branch'

export interface ThemePreset {
  id: string
  name: string
  description: string
  colors: Theme['colors']
  theme: Theme
}

export interface LayoutPreset {
  id: LayoutPresetId
  name: string
  description: string
}

/** Localized display metadata for layout presets; ids stay language-neutral. */
export const layoutMeta = {
  zh: {
    blank: ['空白页', '从完全空白开始'],
    'title-body': ['标题与正文', '标准信息页面'],
    section: ['章节标题', '醒目的过渡页面'],
    statement: ['核心观点', '一句话成为视觉中心'],
    metric: ['关键数字', '数据、结论与解释'],
    'two-column': ['双栏文字', '并列观点或对比'],
    'image-right': ['图文并排', '左文右图的叙事页'],
    'three-cards': ['三张卡片', '步骤、能力或分类'],
    'summary-cards': ['结构化卡片', '1–8 个自适应信息要点'],
    'paper-figure': ['论文原图', '证据直出：原图居中，注脚在右'],
    'paper-table': ['论文表格', '表格骨架：高亮关键行，底部给读法'],
    versus: ['对比页', '两个方法或结果的并排对照'],
    contributions: ['贡献列表', '编号式贡献陈述'],
    limits: ['局限页', '诚实标注方法的边界'],
    closing: ['金句收尾', '一句话 takeaway 作为结束'],
    'hook-statement': ['开场论断页', '超大标题 + 引导/支撑两句，右侧幽灵页码'],
    'prose-panel': ['正文面板页', '标题 + 面板卡片正文，右侧幽灵页码'],
    takeaway: ['编号要点收尾', '分号切条成编号要点，底部 END 收束'],
    'process-flow': ['横向流程图', '四步节点加箭头，画清一条流水线'],
    'decision-branch': ['判断分支图', '条件判断 + 是/否分支 + 回环路径'],
  },
  en: {
    blank: ['Blank page', 'Start from a completely clean canvas'],
    'title-body': ['Title & body', 'A standard content page'],
    section: ['Section title', 'A bold transition page'],
    statement: ['Statement', 'One sentence as the visual center'],
    metric: ['Key metric', 'Number, conclusion and interpretation'],
    'two-column': ['Two columns', 'Side-by-side points or a comparison'],
    'image-right': ['Image + text', 'Narrative on the left, visual on the right'],
    'three-cards': ['Three cards', 'Steps, capabilities or categories'],
    'summary-cards': ['Summary cards', '1–8 adaptive key points'],
    'paper-figure': ['Paper figure', 'Evidence first: figure centered, notes on the right'],
    'paper-table': ['Paper table', 'Table skeleton: highlight the key row, read-out below'],
    versus: ['Versus', 'Two methods or results side by side'],
    contributions: ['Contributions', 'Numbered contribution statements'],
    limits: ['Limitations', 'The honest boundaries of the method'],
    closing: ['Takeaway quote', 'A one-sentence takeaway to close'],
    'hook-statement': ['Hook statement', 'Oversized claim with lead and support lines plus a ghost page number'],
    'prose-panel': ['Prose panel', 'Heading with a panel-card body and a ghost page number'],
    takeaway: ['Numbered takeaways', 'Semicolon-split numbered points ending with END'],
    'process-flow': ['Process flow', 'Four nodes with arrows — one pipeline at a glance'],
    'decision-branch': ['Decision branch', 'A condition with yes/no branches and a loop-back path'],
  },
} satisfies Record<DeckLocale, Record<LayoutPresetId, [string, string]>>

export const layoutPresets: LayoutPreset[] = [
  { id: 'blank', name: '空白页', description: '从完全空白开始' },
  { id: 'title-body', name: '标题与正文', description: '标准信息页面' },
  { id: 'section', name: '章节标题', description: '醒目的过渡页面' },
  { id: 'statement', name: '核心观点', description: '一句话成为视觉中心' },
  { id: 'metric', name: '关键数字', description: '数据、结论与解释' },
  { id: 'two-column', name: '双栏文字', description: '并列观点或对比' },
  { id: 'image-right', name: '图文并排', description: '左文右图的叙事页' },
  { id: 'three-cards', name: '三张卡片', description: '步骤、能力或分类' },
  { id: 'summary-cards', name: '结构化卡片', description: '1–8 个自适应信息要点' },
  { id: 'paper-figure', name: '论文原图', description: '证据直出：原图居中，注脚在右' },
  { id: 'paper-table', name: '论文表格', description: '表格骨架：高亮关键行，底部给读法' },
  { id: 'versus', name: '对比页', description: '两个方法或结果的并排对照' },
  { id: 'contributions', name: '贡献列表', description: '编号式贡献陈述' },
  { id: 'limits', name: '局限页', description: '诚实标注方法的边界' },
  { id: 'closing', name: '金句收尾', description: '一句话 takeaway 作为结束' },
  { id: 'hook-statement', name: '开场论断页', description: '超大标题 + 引导/支撑两句，右侧幽灵页码' },
  { id: 'prose-panel', name: '正文面板页', description: '标题 + 面板卡片正文，右侧幽灵页码' },
  { id: 'takeaway', name: '编号要点收尾', description: '分号切条成编号要点，底部 END 收束' },
  { id: 'process-flow', name: '横向流程图', description: '四步节点加箭头，画清一条流水线' },
  { id: 'decision-branch', name: '判断分支图', description: '条件判断 + 是/否分支 + 回环路径' },
]

/** Layout presets with display metadata for one locale; element builders still use zh-neutral ids. */
export function layoutPresetsFor(locale: DeckLocale): LayoutPreset[] {
  return layoutPresets.map(preset => ({ ...preset, name: layoutMeta[locale][preset.id][0], description: layoutMeta[locale][preset.id][1] }))
}

export function getLayoutPreset(id: LayoutPresetId | string, locale: DeckLocale = 'zh'): LayoutPreset | undefined {
  return locale === 'zh' ? layoutPresets.find(preset => preset.id === id) : layoutPresetsFor(locale).find(preset => preset.id === id)
}

/** Mix background toward text by a small amount to derive a card surface color. */
export function deriveThemeSurface(background: string, text: string): string | undefined {
  const parse = (value: string) => {
    const match = /^#([\da-f]{6})$/i.exec(value.trim())
    return match ? [0, 2, 4].map(index => Number.parseInt(match[1].slice(index, index + 2), 16)) : undefined
  }
  const bg = parse(background); const fg = parse(text)
  if (!bg || !fg) return undefined
  return `#${bg.map((channel, index) => Math.round(channel + (fg[index] - channel) * 0.07).toString(16).padStart(2, '0')).join('')}`
}

const makeTheme = (colors: Theme['colors'], fonts: Theme['fonts'] = {
  title: 'Avenir Next, Aptos Display, Helvetica Neue, "PingFang SC", "Noto Sans SC", sans-serif',
  body: 'Avenir Next, Aptos, Helvetica Neue, "PingFang SC", "Noto Sans SC", sans-serif',
  mono: 'SFMono-Regular, IBM Plex Mono, Consolas, monospace',
}): Theme => ({
  fonts,
  fontSizes: { title: 76, heading: 48, body: 28, caption: 19 },
  colors: { ...colors, surface: colors.surface ?? deriveThemeSurface(colors.background, colors.text) },
  spacing: { page: 80, small: 16, medium: 30, large: 64 },
})

const themePreset = (id: string, name: string, description: string, colors: Theme['colors'], fonts?: Theme['fonts']): ThemePreset => {
  const theme = makeTheme(colors, fonts)
  return { id, name, description, colors: theme.colors, theme }
}

const natureEditorialTheme: Theme = {
  ...makeTheme(
    { background: '#FBFBF8', text: '#202326', muted: '#666B70', accent: '#A63C3C', surface: '#F0F1ED' },
    {
      title: 'Georgia, Charter, "Songti SC", "Noto Serif SC", serif',
      body: 'Aptos, Helvetica Neue, "PingFang SC", "Noto Sans SC", sans-serif',
      mono: 'SFMono-Regular, IBM Plex Mono, Consolas, monospace',
    },
  ),
  fontSizes: { title: 64, heading: 42, body: 24, caption: 16 },
  spacing: { page: 88, small: 14, medium: 28, large: 60 },
  typeScale: [16, 18, 20, 24, 28, 34, 42, 52, 64],
}

export const themePresets: ThemePreset[] = [
  { id: 'nature-editorial', name: 'Nature 学术编辑', description: '浅色、证据优先、克制而高密度', colors: natureEditorialTheme.colors, theme: natureEditorialTheme },
  themePreset('studio-cobalt', '钴蓝工作室', '编辑感、鲜明、现代', { background: '#F2F0E8', text: '#102A43', muted: '#667085', accent: '#FF5A4F' }),
  themePreset('night-citrus', '午夜柑橘', '深色、锐利、舞台感', { background: '#101714', text: '#F6F3E8', muted: '#9FAB9F', accent: '#D8FF52' }),
  themePreset('ink-rose', '墨色玫瑰', '克制、时尚、高对比', { background: '#171319', text: '#FFF7F2', muted: '#BAAEB6', accent: '#FF6B8A' }),
  themePreset('paper-signal', '纸张信号', '温暖、直接', { background: '#FFF8E9', text: '#20211D', muted: '#706F67', accent: BRAND_ACCENT }, { title: 'Georgia, Charter, "Songti SC", "Noto Serif SC", serif', body: 'Avenir Next, Aptos, "PingFang SC", "Noto Sans SC", sans-serif', mono: 'SFMono-Regular, Consolas, monospace' }),
  themePreset('night-blue', '深夜蓝图', '技术、沉静', { background: '#111820', text: '#F3F7F5', muted: '#8C9AA3', accent: '#36B7D4' }),
  themePreset('field-notes', '田野笔记', '自然、克制', { background: '#F1F0E7', text: '#203027', muted: '#6E786F', accent: '#547A5A' }, { title: 'Georgia, Charter, "Songti SC", "Noto Serif SC", serif', body: 'Avenir Next, Aptos, "PingFang SC", "Noto Sans SC", sans-serif', mono: 'SFMono-Regular, Consolas, monospace' }),
  themePreset('editorial-blue', '编辑蓝', '清晰、理性', { background: '#F3F6F7', text: '#17242C', muted: '#6F7C83', accent: '#235D83' }),
  themePreset('poster-red', '海报红黑', '高对比、强表达', { background: '#F1EBDF', text: '#171715', muted: '#706A62', accent: '#C93428' }),
  // 色卡实验室 Palette Lab 主题（https://mappedinfo.github.io/palette-lab/ · 机器可读档案 llms-full.txt）
  themePreset('palette-vermillion', '宣纸与朱砂', '宣纸底、朱砂点睛，学术严谨感首选', { background: '#F5E6D0', text: '#20211D', muted: '#6F685A', accent: '#9E1D1C' }, { title: 'Georgia, Charter, "Songti SC", "Noto Serif SC", serif', body: 'Avenir Next, Aptos, "PingFang SC", "Noto Sans SC", sans-serif', mono: 'SFMono-Regular, Consolas, monospace' }),
  themePreset('palette-ice-magenta', '冰蓝与品红', '冷色冰面托起品红，阴性/阳性对照', { background: '#F1F6FF', text: '#1F2733', muted: '#6A7686', accent: '#EE1969' }),
  themePreset('palette-jade-ivory', '翡翠与象牙', '深翡翠与象牙白，克制清爽留白', { background: '#FBFFF2', text: '#232B25', muted: '#6E7A6F', accent: '#008E6B' }, { title: 'Georgia, Charter, "Songti SC", "Noto Serif SC", serif', body: 'Avenir Next, Aptos, "PingFang SC", "Noto Sans SC", sans-serif', mono: 'SFMono-Regular, Consolas, monospace' }),
  themePreset('palette-jade-night', '翡翠夜', '翡翠底、象牙字，琥珀强调的深色舞台', { background: '#008E6B', text: '#FBFFF2', muted: '#C6E5D9', accent: '#FFD15D' }),
]

export function getThemePreset(id: string): ThemePreset | undefined {
  return themePresets.find(preset => preset.id === id)
}

/** Localized display metadata for theme presets; ids stay language-neutral. */
const themeMeta: Record<DeckLocale, Record<string, [string, string]>> = {
  zh: {
    'nature-editorial': ['Nature 学术编辑', '浅色、证据优先、克制而高密度'],
    'studio-cobalt': ['钴蓝工作室', '编辑感、鲜明、现代'],
    'night-citrus': ['午夜柑橘', '深色、锐利、舞台感'],
    'ink-rose': ['墨色玫瑰', '克制、时尚、高对比'],
    'paper-signal': ['纸张信号', '温暖、直接'],
    'night-blue': ['深夜蓝图', '技术、沉静'],
    'field-notes': ['田野笔记', '自然、克制'],
    'editorial-blue': ['编辑蓝', '清晰、理性'],
    'poster-red': ['海报红黑', '高对比、强表达'],
    'palette-vermillion': ['宣纸与朱砂', '宣纸底、朱砂点睛，学术严谨感首选'],
    'palette-ice-magenta': ['冰蓝与品红', '冷色冰面托起品红，阴性/阳性对照'],
    'palette-jade-ivory': ['翡翠与象牙', '深翡翠与象牙白，克制清爽留白'],
    'palette-jade-night': ['翡翠夜', '翡翠底、象牙字，琥珀强调的深色舞台'],
  },
  en: {
    'nature-editorial': ['Nature academic editorial', 'Light, evidence-first, restrained and dense'],
    'studio-cobalt': ['Cobalt studio', 'Editorial, vivid, modern'],
    'night-citrus': ['Night citrus', 'Dark, sharp, stage-like'],
    'ink-rose': ['Ink rose', 'Restrained, fashionable, high contrast'],
    'paper-signal': ['Paper signal', 'Warm and direct'],
    'night-blue': ['Night blue', 'Technical and calm'],
    'field-notes': ['Field notes', 'Natural and restrained'],
    'editorial-blue': ['Editorial blue', 'Clear and rational'],
    'poster-red': ['Poster red-black', 'High contrast, expressive'],
    'palette-vermillion': ['Vermillion on rice paper', 'Rice-paper base with a vermillion accent — first choice for academic rigor'],
    'palette-ice-magenta': ['Ice blue & magenta', 'A cool ice surface carrying magenta; negative/positive pairing'],
    'palette-jade-ivory': ['Jade & ivory', 'Deep jade with ivory white; calm, fresh whitespace'],
    'palette-jade-night': ['Jade night', 'Jade base, ivory type and an amber accent on a dark stage'],
  },
}

export function themePresetsFor(locale: DeckLocale): ThemePreset[] {
  if (locale === 'zh') return themePresets
  return themePresets.map(preset => {
    const meta = themeMeta[locale][preset.id]
    return meta ? { ...preset, name: meta[0], description: meta[1] } : preset
  })
}

const imagePlaceholder = 'placeholder:image'
const frame = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

/** Design base canvas every preset is authored against; layouts scale to other canvases. */
export const BASE_CANVAS = { width: 1600, height: 900 }

/** Create preset layout elements, scaled uniformly when the target canvas differs from the 1600×900 design base. */
export function createLayoutElements(layoutId: LayoutPresetId, theme: Theme, canvas: { width: number; height: number } = BASE_CANVAS, locale: DeckLocale = 'zh'): SlideElement[] {
  const elements = buildLayoutElements(layoutId, theme, locale)
  const scaleX = canvas.width / BASE_CANVAS.width; const scaleY = canvas.height / BASE_CANVAS.height
  if (Math.abs(scaleX - 1) < 1e-6 && Math.abs(scaleY - 1) < 1e-6) return elements
  const fontScale = Math.min(scaleX, scaleY)
  return elements.map(element => ({
    ...element,
    frame: {
      x: Math.round(element.frame.x * scaleX), y: Math.round(element.frame.y * scaleY),
      w: Math.round(element.frame.w * scaleX), h: Math.round(element.frame.h * scaleY),
    },
    ...('fontSize' in element && element.fontSize ? { fontSize: Math.round(element.fontSize * fontScale) } : {}),
    ...('letterSpacing' in element && element.letterSpacing ? { letterSpacing: Math.round(element.letterSpacing * fontScale * 10) / 10 } : {}),
    ...('strokeWidth' in element && element.strokeWidth ? { strokeWidth: Math.max(1, Math.round(element.strokeWidth * fontScale)) } : {}),
    ...('ruleWidth' in element && element.ruleWidth ? { ruleWidth: Math.max(1, Math.round(element.ruleWidth * fontScale)) } : {}),
    ...('cellPadding' in element && element.cellPadding ? { cellPadding: Math.round(element.cellPadding * fontScale) } : {}),
    ...('radius' in element && element.radius ? { radius: Math.round(element.radius * fontScale) } : {}),
  }))
}

/** Placeholder copy authored per layout; zh is canonical and en mirrors it for browser-detected decks. */
const layoutCopy = {
  en: {
    titleBodyTitle: 'Type your title',
    titleBodyBody: 'Click to edit this paragraph. Organize one clear point; add text, images or shapes from the toolbar.',
    sectionTitle: 'Section title',
    sectionSubtitle: 'One line on what comes next',
    statementTitle: 'Take your single most important point\nand make it one memorable sentence.',
    statementContext: 'Add a line of evidence, a caveat, or what to do next.',
    metricTitle: 'What does this number change?',
    metricBody: 'Show the number, unit and source. Explain the judgment it supports and the next step.',
    twoColumnTitle: 'Two-column title',
    twoColumnLabels: ['Point A', 'Point B'],
    twoColumnBodies: [
      'Write the left column here. Good for one method, one stance or one group of facts.',
      'Write the right column here. Keep both columns at similar depth so they compare well.',
    ],
    imageRightTitle: 'Let the image carry half the story',
    imageRightBody: 'Keep the key narrative on the left; replace the right with a photo, chart or research result.',
    imageAlt: 'image placeholder',
    summaryCardsTitle: 'Turn long content into clear cards',
    summaryCards: [
      { title: 'Distill', description: 'Each card carries exactly one core point — subject, numbers and needed caveats.' },
      { title: 'Arrange', description: 'Cards adapt automatically to one or two rows and stay editable element by element.' },
      { title: 'Verify', description: 'AI drafts; people own facts, judgment and the final word.' },
    ],
    figureTitle: 'This figure is the core evidence',
    figureCaption: 'Caption: say in one sentence what this figure proves.',
    figureNotes: ['Read axes and units first, then the trend.', 'Point at the curve that backs the conclusion.', 'Mark outliers, noise and anomalies.'],
    tableTitle: 'The row worth remembering',
    tableHeader: ['Method', 'Setup', 'Illustrative data'],
    tableRows: [['Baseline', 'Default setup', '82.4'], ['This work', 'Full model', '89.7'], ['Ablation', 'Key module removed', '85.1']],
    tableTakeaway: 'How to read it: present whichever row changes your verdict.',
    versusTitle: 'Put both approaches under the same light',
    versusLeftTitle: 'Existing approach',
    versusLeftBody: 'What it assumes, optimizes and where it breaks down. One fact per line, no judgments.',
    versusRightTitle: 'This work',
    versusRightBody: 'Which assumption it drops and what that costs. Align item by item with the left column.',
    versusVerdict: 'Verdict: under which conditions do you trust which side?',
    contributionsTitle: 'Three contributions of this paper',
    contributionItems: ['A new problem or setting', 'A key design decision', 'A persuasive body of evidence'],
    contributionBody: 'In one or two sentences: what it solves and how it differs from prior work.',
    limitsTitle: 'When does this method break down?',
    limitsIntro: 'Clear limits are more credible than oversold results.',
    limitsCards: [
      { title: 'Scope limits', body: 'Which assumptions does the method rely on? What happens when they fail?' },
      { title: 'Evidence limits', body: 'Which settings did experiments cover? Which conclusions are still conjecture?' },
    ],
    limitsFuture: 'These limits chart future work: turn each boundary into a roadmap step.',
    closingQuote: 'Compress the whole paper into\none sentence worth taking away.',
    attribution: '— Author · Venue / Journal · Year',
    hookHeading: 'Make your strongest claim the headline',
    hookLead: 'Lead: state what this page argues.',
    hookSupport: 'Support: add evidence, caveats or what to do next.\n\nSecond paragraph: expand further — around 200 words max, so every slide stands alone.',
    proseHeading: 'Prose panel',
    proseLead: 'Lead: state the topic of this page.',
    takeawayHeading: 'Numbered takeaways',
    takeawayQuote: 'Compress the whole paper into one sentence worth taking away.',
    cardsFallbackTitle: 'Three parallel points',
    cardsFallbackHint: 'Double-click to edit',
    flowTitle: 'Four steps, one glance',
    flowStages: ['Gather inputs', 'Process', 'Verify', 'Deliver'],
    flowStart: 'Start',
    flowEnd: 'End',
    flowTakeaway: 'Every step needs explicit inputs and outputs.',
    branchTitle: 'Branch and loop back: make the failure path visible',
    branchQuestion: 'Is the evidence strong enough?',
    branchYes: 'Yes',
    branchNo: 'No',
    branchAdopt: 'Adopt the approach',
    branchVerify: 'Validate at small scale',
    branchShip: 'Ship it',
    branchLoopNote: 'If it fails, return to the previous step and strengthen the evidence.',
    branchTakeaway: 'Show both decision outcomes and the path back to verification.',
  },
  zh: {
    titleBodyTitle: '点击输入标题',
    titleBodyBody: '点击输入正文。用清晰的段落组织观点，也可以从工具栏继续添加文字、图片或形状。',
    sectionTitle: '章节标题',
    sectionSubtitle: '用一句话说明接下来要讨论的主题',
    statementTitle: '把最重要的观点，\n写成一句能被记住的话。',
    statementContext: '补充一行证据、限定条件或行动含义。',
    metricTitle: '关键数字说明了什么',
    metricBody: '展示数字、单位和来源，解释它支持的判断，以及观众下一步应该做什么。',
    twoColumnTitle: '双栏标题',
    twoColumnLabels: ['观点 A', '观点 B'],
    twoColumnBodies: [
      '在这里输入左栏内容。适合呈现一种方法、一个立场或一组信息。',
      '在这里输入右栏内容。两栏保持相似的信息层级，更容易比较。',
    ],
    imageRightTitle: '让图片承担一半表达',
    imageRightBody: '左侧保留关键叙述，右侧替换为照片、图表或研究结果。',
    imageAlt: '图片占位',
    summaryCardsTitle: '把长内容整理成清楚的卡片',
    summaryCards: [
      { title: '提炼', description: '每张卡只承载一个核心要点，保留主体、数字与必要限定。' },
      { title: '编排', description: '卡片数量会自动适配为一到两行，生成后仍可逐元素编辑。' },
      { title: '复核', description: 'AI 负责初稿，人负责事实、判断与最终表达。' },
    ],
    figureTitle: '这张原图是核心证据',
    figureCaption: '图注：用一句话说明这张图证明了什么。',
    figureNotes: ['先看坐标轴与单位，再看趋势。', '指出与正文结论对应的曲线。', '标注例外、噪声或反常之处。'],
    tableTitle: '表格里最值得记住的一行',
    tableHeader: ['方法', '设置', '示例数据'],
    tableRows: [['基线方法', '默认设置', '82.4'], ['本文方法', '完整模型', '89.7'], ['消融变体', '移除关键模块', '85.1']],
    tableTakeaway: '读法：哪一行改变了你的判断，就把哪一行讲出来。',
    versusTitle: '把两个方法放在同一束光下',
    versusLeftTitle: '现有方法',
    versusLeftBody: '它假设什么、优化什么、在何处开始失效。每行一个事实，不写评价。',
    versusRightTitle: '本文方法',
    versusRightBody: '它改掉了哪个假设、换来了什么代价。与左栏逐项对齐，方便对照。',
    versusVerdict: '结论：在什么条件下，哪一边更值得相信。',
    contributionsTitle: '本文的三个贡献',
    contributionItems: ['一个新问题或新设定', '一个关键方法设计', '一组有说服力的证据'],
    contributionBody: '用一到两句话说明它解决了什么、与此前工作的差别在哪里。',
    limitsTitle: '这个方法在什么情况下会失效',
    limitsIntro: '把局限讲清楚，比把效果讲满更可信。',
    limitsCards: [
      { title: '适用边界', body: '方法依赖哪些假设？假设不成立时会怎样？' },
      { title: '证据边界', body: '实验覆盖了哪些场景？哪些结论还只是推测？' },
    ],
    limitsFuture: '这些局限指向的未来工作：把边界写成下一步的路线图。',
    closingQuote: '把整篇论文压缩成一句\n可以被带走的话。',
    attribution: '—— 作者 · 会议 / 期刊 · 年份',
    hookHeading: '把最重要的论点写成超大标题',
    hookLead: '引导句：点明本页主题与论点。',
    hookSupport: '支撑句：补充证据、限定条件或行动含义。\n\n第二段：继续展开，最多约两百字，保证每页自含上下文。',
    proseHeading: '正文面板页',
    proseLead: '引导句：点明本页主题。',
    takeawayHeading: '编号要点收尾',
    takeawayQuote: '把整篇论文压缩成一句可以被带走的话。',
    cardsFallbackTitle: '三个并列要点',
    cardsFallbackHint: '双击编辑卡片文字',
    flowTitle: '四步流程，一眼看完',
    flowStages: ['收集输入', '加工处理', '验证结果', '交付产出'],
    flowStart: '起点',
    flowEnd: '终点',
    flowTakeaway: '每一步都要有明确的输入与输出。',
    branchTitle: '分支与回环：让失败路径可见',
    branchQuestion: '证据足够充分吗？',
    branchYes: '是',
    branchNo: '否',
    branchAdopt: '采纳方案',
    branchVerify: '小范围验证',
    branchShip: '正式发布',
    branchLoopNote: '不通过就回到上一步，重做并补充证据。',
    branchTakeaway: '画出两种判断结果，并标明返回验证的路径。',
  },
} satisfies Record<DeckLocale, Record<string, unknown>>

function buildLayoutElements(layoutId: LayoutPresetId, theme: Theme, locale: DeckLocale): SlideElement[] {
  const text = theme.colors.text
  const muted = theme.colors.muted
  const accent = theme.colors.accent
  const background = theme.colors.background
  const surface = theme.colors.surface ?? background
  const mono = theme.fonts.mono ?? theme.fonts.body
  const t = layoutCopy[locale] as typeof layoutCopy.en
  const title = (id: string, value: string, x: number, y: number, w: number, h: number, fontSize = 58): SlideElement => ({ id, type: 'text', styleRef: 'slide-title', frame: frame(x, y, w, h), text: value, fontSize, fontWeight: 700 })
  const body = (id: string, value: string, x: number, y: number, w: number, h: number): SlideElement => ({ id, type: 'text', frame: frame(x, y, w, h), text: value, fontSize: 28, color: muted })

  if (layoutId === 'blank') return []
  if (layoutId === 'title-body') return [
    title('title', t.titleBodyTitle, 96, 88, 1408, 110),
    { id: 'accent-rule', type: 'shape', frame: frame(96, 230, 120, 8), shape: 'rectangle', fill: accent },
    body('body', t.titleBodyBody, 96, 286, 1220, 360),
  ]
  if (layoutId === 'section') return [
    { id: 'section-number', type: 'text', frame: frame(96, 96, 300, 54), text: 'SECTION 01', fontSize: 22, fontWeight: 700, color: accent },
    title('title', t.sectionTitle, 96, 286, 1300, 180, 76),
    body('subtitle', t.sectionSubtitle, 100, 500, 1100, 70),
    { id: 'section-block', type: 'shape', frame: frame(1370, 0, 230, 900), shape: 'rectangle', fill: accent, text: '01', textColor: background, fontSize: 72, fontWeight: 700, align: 'center', verticalAlign: 'middle' },
  ]
  if (layoutId === 'statement') return [
    { id: 'kicker', type: 'text', frame: frame(88, 72, 720, 40), text: 'ONE IDEA / ONE SLIDE', fontSize: 18, fontWeight: 700, color: accent },
    { id: 'index', type: 'text', frame: frame(1260, 52, 252, 150), text: '01', fontSize: 112, fontWeight: 700, align: 'right', color: accent },
    title('statement', t.statementTitle, 88, 238, 1240, 270, 76),
    { id: 'rule', type: 'shape', frame: frame(88, 620, 1424, 3), shape: 'rectangle', fill: text },
    body('context', t.statementContext, 88, 682, 1040, 70),
  ]
  if (layoutId === 'metric') return [
    { id: 'kicker', type: 'text', frame: frame(88, 72, 720, 40), text: 'SIGNAL / METRIC', fontSize: 18, fontWeight: 700, color: accent },
    { id: 'metric', type: 'text', frame: frame(84, 190, 850, 260), text: locale === 'zh' ? '待补' : 'TBD', fontSize: 196, fontWeight: 700, color: text },
    { id: 'metric-rule', type: 'shape', frame: frame(930, 214, 8, 420), shape: 'rectangle', fill: accent },
    title('title', t.metricTitle, 1010, 224, 500, 138, 46),
    body('body', t.metricBody, 1010, 410, 480, 220),
    { id: 'source', type: 'text', frame: frame(88, 746, 900, 40), text: 'SOURCE · PERIOD · SAMPLE', fontSize: 17, fontWeight: 700, color: muted },
  ]
  if (layoutId === 'two-column') return [
    title('title', t.twoColumnTitle, 88, 70, 1424, 100, 54),
    { id: 'divider', type: 'shape', frame: frame(796, 230, 3, 490), shape: 'rectangle', fill: accent },
    { id: 'left-label', type: 'text', frame: frame(88, 230, 620, 48), text: t.twoColumnLabels[0], fontSize: 24, fontWeight: 700, color: accent },
    body('left-body', t.twoColumnBodies[0], 88, 302, 620, 320),
    { id: 'right-label', type: 'text', frame: frame(890, 230, 620, 48), text: t.twoColumnLabels[1], fontSize: 24, fontWeight: 700, color: accent },
    body('right-body', t.twoColumnBodies[1], 890, 302, 620, 320),
  ]
  if (layoutId === 'image-right') return [
    { id: 'kicker', type: 'text', frame: frame(88, 72, 600, 42), text: 'IMAGE + STORY', fontSize: 19, fontWeight: 700, color: accent },
    title('title', t.imageRightTitle, 88, 154, 620, 170, 58),
    body('body', t.imageRightBody, 88, 370, 590, 210),
    { id: 'image', type: 'image', frame: frame(800, 72, 712, 756), src: imagePlaceholder, fit: 'cover', alt: t.imageAlt },
  ]
  if (layoutId === 'summary-cards') return createSummaryCardElements({
    title: t.summaryCardsTitle,
    cards: [
      { ...t.summaryCards[0], icon: 'filter_alt' },
      { ...t.summaryCards[1], icon: 'dashboard' },
      { ...t.summaryCards[2], icon: 'verified' },
    ],
  }, theme)
  if (layoutId === 'paper-figure') return [
    { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'EVIDENCE / FIGURE', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    { id: 'fig-label', type: 'text', frame: frame(1000, 64, 512, 34), text: locale === 'zh' ? '图号与来源页码待补' : 'FIGURE / SOURCE PAGE · TBD', fontSize: 17, fontWeight: 700, fontFamily: mono, align: 'right', color: muted },
    title('title', t.figureTitle, 88, 112, 1300, 64, 44),
    { id: 'figure-stage', type: 'shape', frame: frame(88, 200, 950, 556), shape: 'rounded-rectangle', fill: surface, radius: 18 },
    { id: 'figure', type: 'image', frame: frame(112, 224, 902, 508), src: imagePlaceholder, fit: 'contain', alt: t.imageAlt },
    { id: 'caption', type: 'text', frame: frame(88, 770, 950, 64), text: t.figureCaption, fontSize: 24, color: muted, lineHeight: 1.4, fit: 'fill' },
    { id: 'rail-rule', type: 'shape', frame: frame(1076, 200, 3, 556), shape: 'rectangle', fill: accent },
    { id: 'notes-label', type: 'text', frame: frame(1112, 200, 400, 30), text: 'READING NOTES', fontSize: 17, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    ...[0, 1, 2].flatMap((index): SlideElement[] => [
      { id: `note-${index + 1}-number`, type: 'text', frame: frame(1112, 252 + index * 170, 80, 36), text: `0${index + 1}`, fontSize: 22, fontWeight: 700, fontFamily: mono, color: accent },
      { id: `note-${index + 1}`, type: 'text', frame: frame(1112, 296 + index * 170, 400, 120), text: t.figureNotes[index], fontSize: 24, color: text, lineHeight: 1.5, fit: 'fill' },
    ]),
    { id: 'source', type: 'text', frame: frame(88, 848, 1200, 30), text: 'SOURCE · VENUE · YEAR', fontSize: 16, fontWeight: 700, fontFamily: mono, color: muted },
  ]
  if (layoutId === 'paper-table') {
    return [
      { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'EVIDENCE / TABLE', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
      { id: 'table-label', type: 'text', frame: frame(1000, 64, 512, 34), text: locale === 'zh' ? '表号与来源页码待补' : 'TABLE / SOURCE PAGE · TBD', fontSize: 17, fontWeight: 700, fontFamily: mono, align: 'right', color: muted },
      title('title', t.tableTitle, 88, 112, 1300, 64, 44),
      { id: 'table', type: 'table', frame: frame(88, 210, 1424, 394), cells: [t.tableHeader, t.tableRows[0], t.tableRows[1], t.tableRows[2]], headerRows: 1, columnWidths: [1.45, 1.2, 1], alignments: ['left', 'left', 'right'], style: 'rules', fontSize: 23, textColor: text, headerTextColor: text, headerFill: surface, stripeFill: surface, ruleColor: muted, accentColor: accent, ruleWidth: 2, cellPadding: 18, highlightRows: [2] },
      { id: 'takeaway-bar', type: 'shape', frame: frame(88, 640, 6, 56), shape: 'rectangle', fill: accent },
      { id: 'takeaway', type: 'text', frame: frame(114, 636, 1398, 60), text: t.tableTakeaway, fontSize: 26, fontWeight: 600, color: text, lineHeight: 1.3 },
      { id: 'source', type: 'text', frame: frame(88, 848, 1200, 30), text: 'SOURCE · VENUE · YEAR', fontSize: 16, fontWeight: 700, fontFamily: mono, color: muted },
    ]
  }
  if (layoutId === 'versus') return [
    { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'COMPARISON / VERSUS', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    title('title', t.versusTitle, 88, 112, 1300, 64, 44),
    { id: 'panel-left', type: 'shape', frame: frame(88, 210, 664, 480), shape: 'rounded-rectangle', fill: surface, radius: 18 },
    { id: 'panel-right', type: 'shape', frame: frame(848, 210, 664, 480), shape: 'rounded-rectangle', fill: surface, radius: 18 },
    { id: 'left-label', type: 'text', frame: frame(128, 250, 560, 32), text: 'BASELINE', fontSize: 19, fontWeight: 700, fontFamily: mono, color: muted, letterSpacing: 2 },
    { id: 'left-title', type: 'text', frame: frame(128, 300, 560, 48), text: t.versusLeftTitle, fontSize: 32, fontWeight: 700, color: text },
    { id: 'left-body', type: 'text', frame: frame(128, 372, 584, 260), text: t.versusLeftBody, fontSize: 22, color: muted, lineHeight: 1.5 },
    { id: 'right-label', type: 'text', frame: frame(888, 250, 560, 32), text: 'PROPOSED', fontSize: 19, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    { id: 'right-title', type: 'text', frame: frame(888, 300, 560, 48), text: t.versusRightTitle, fontSize: 32, fontWeight: 700, color: text },
    { id: 'right-body', type: 'text', frame: frame(888, 372, 584, 260), text: t.versusRightBody, fontSize: 22, color: text, lineHeight: 1.5 },
    { id: 'vs-badge', type: 'shape', frame: frame(766, 418, 68, 68), shape: 'ellipse', fill: accent, text: 'VS', textColor: background, fontSize: 24, fontWeight: 800, align: 'center', verticalAlign: 'middle' },
    { id: 'verdict-rule', type: 'shape', frame: frame(88, 742, 1424, 3), shape: 'rectangle', fill: accent },
    { id: 'verdict-label', type: 'text', frame: frame(88, 770, 220, 30), text: 'VERDICT', fontSize: 17, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    { id: 'verdict', type: 'text', frame: frame(340, 762, 1172, 52), text: t.versusVerdict, fontSize: 26, fontWeight: 600, color: text },
  ]
  if (layoutId === 'contributions') return [
    { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'CONTRIBUTIONS / WHAT IS NEW', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    title('title', t.contributionsTitle, 88, 118, 1300, 70, 52),
    ...[0, 1, 2].flatMap((index): SlideElement[] => [
      { id: `item-${index + 1}-number`, type: 'text', frame: frame(88, 258 + index * 182, 150, 100), text: `0${index + 1}`, fontSize: 84, fontWeight: 800, fontFamily: mono, color: accent },
      { id: `item-${index + 1}-title`, type: 'text', frame: frame(272, 264 + index * 182, 1100, 52), text: t.contributionItems[index], fontSize: 36, fontWeight: 700, color: text, fit: 'fill' },
      { id: `item-${index + 1}-body`, type: 'text', frame: frame(272, 330 + index * 182, 1180, 76), text: t.contributionBody, fontSize: 26, color: muted, lineHeight: 1.45, fit: 'fill' },
      ...(index < 2 ? [{ id: `item-${index + 1}-rule`, type: 'line', frame: frame(272, 424 + index * 182, 1240, 2), color: muted, strokeWidth: 2, opacity: 0.3 } as SlideElement] : []),
    ]),
    { id: 'source', type: 'text', frame: frame(88, 848, 1200, 30), text: 'SOURCE · VENUE · YEAR', fontSize: 16, fontWeight: 700, fontFamily: mono, color: muted },
  ]
  if (layoutId === 'limits') return [
    { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'LIMITATIONS / HONEST BOUNDARIES', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    title('title', t.limitsTitle, 88, 112, 1300, 64, 44),
    { id: 'intro', type: 'text', frame: frame(88, 192, 1300, 40), text: t.limitsIntro, fontSize: 24, color: muted },
    ...[0, 1].flatMap((index): SlideElement[] => [
      { id: `limit-${index + 1}-card`, type: 'shape', frame: frame(88 + index * 734, 268, 690, 380), shape: 'rounded-rectangle', fill: surface, radius: 18 },
      { id: `limit-${index + 1}-marker`, type: 'text', frame: frame(128 + index * 734, 304, 80, 44), text: '△', fontSize: 32, fontWeight: 700, color: accent },
      { id: `limit-${index + 1}-title`, type: 'text', frame: frame(128 + index * 734, 366, 610, 44), text: t.limitsCards[index].title, fontSize: 30, fontWeight: 700, color: text },
      { id: `limit-${index + 1}-body`, type: 'text', frame: frame(128 + index * 734, 430, 610, 180), text: t.limitsCards[index].body, fontSize: 22, color: muted, lineHeight: 1.5 },
    ]),
    { id: 'future-rule', type: 'shape', frame: frame(88, 716, 1424, 3), shape: 'rectangle', fill: text },
    { id: 'future', type: 'text', frame: frame(88, 764, 1300, 52), text: t.limitsFuture, fontSize: 24, fontWeight: 600, color: text },
  ]
  if (layoutId === 'closing') return [
    { id: 'kicker', type: 'text', frame: frame(88, 72, 720, 40), text: 'TAKEAWAY / ONE SENTENCE', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
    { id: 'quote-mark', type: 'text', frame: frame(72, 120, 260, 220), text: '“', fontSize: 220, fontWeight: 800, color: accent },
    title('quote', t.closingQuote, 120, 330, 1392, 240, 64),
    { id: 'rule', type: 'shape', frame: frame(120, 640, 1392, 3), shape: 'rectangle', fill: accent },
    { id: 'attribution', type: 'text', frame: frame(120, 700, 1100, 44), text: t.attribution, fontSize: 24, color: muted },
    { id: 'end', type: 'text', frame: frame(1300, 786, 212, 46), text: 'END', fontSize: 22, fontWeight: 700, fontFamily: mono, align: 'right', color: accent, letterSpacing: 2 },
  ]
  if (layoutId === 'hook-statement') return [
    { id: 'kicker', type: 'text', frame: frame(88, 48, 750, 34), text: 'HOOK / STATEMENT', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent },
    { id: 'ghost', type: 'text', frame: frame(1108, 100, 392, 300), text: '01', fontSize: 240, fontWeight: 800, fontFamily: mono, align: 'right', color: surface },
    { id: 'heading', type: 'text', styleRef: 'slide-title', frame: frame(100, 200, 1000, 110), text: t.hookHeading, fontSize: 66, fontWeight: 800, color: text },
    { id: 'heading-rule', type: 'line', frame: frame(100, 340, 183, 2), color: accent, strokeWidth: 8 },
    { id: 'lead', type: 'text', frame: frame(100, 402, 1250, 140), text: t.hookLead, fontSize: 40, fontWeight: 700, color: text, lineHeight: 1.45 },
    { id: 'support', type: 'text', frame: frame(100, 560, 1250, 258), text: t.hookSupport, fontSize: 30, fontWeight: 500, color: muted, lineHeight: 1.6 },
  ]
  if (layoutId === 'prose-panel') return [
    { id: 'kicker', type: 'text', frame: frame(88, 48, 750, 34), text: 'CONTEXT / PROSE', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent },
    title('heading', t.proseHeading, 100, 116, 1167, 80, 50),
    { id: 'heading-rule', type: 'line', frame: frame(100, 226, 1400, 2), color: surface, strokeWidth: 3 },
    { id: 'prose-panel', type: 'shape', frame: frame(100, 286, 1033, 500), shape: 'rounded-rectangle', fill: surface, radius: 28 },
    { id: 'ghost', type: 'text', frame: frame(1175, 286, 325, 500), text: '02', fontSize: 200, fontWeight: 800, fontFamily: mono, align: 'center', color: surface, verticalAlign: 'middle' },
    { id: 'lead', type: 'text', frame: frame(155, 332, 915, 92), text: t.proseLead, fontSize: 36, fontWeight: 700, color: text, lineHeight: 1.45 },
    { id: 'lead-rule', type: 'line', frame: frame(155, 446, 117, 2), color: accent, strokeWidth: 6 },
    { id: 'support', type: 'text', frame: frame(155, 472, 915, 284), text: t.hookSupport, fontSize: 30, fontWeight: 500, color: muted, lineHeight: 1.6 },
  ]
  if (layoutId === 'takeaway') return [
    { id: 'kicker', type: 'text', frame: frame(88, 48, 750, 34), text: 'TAKEAWAY / SUMMARY', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent },
    title('heading', t.takeawayHeading, 100, 120, 1083, 84, 50),
    { id: 'heading-rule', type: 'line', frame: frame(100, 232, 183, 2), color: accent, strokeWidth: 8 },
    { id: 'quote', type: 'text', frame: frame(100, 268, 1300, 90), text: t.takeawayQuote, fontSize: 34, fontWeight: 700, color: accent, lineHeight: 1.3 },
    { id: 'end-rule', type: 'line', frame: frame(100, 852, 1400, 2), color: surface, strokeWidth: 3 },
    { id: 'attribution', type: 'text', frame: frame(100, 864, 1000, 30), text: t.attribution, fontSize: 20, fontWeight: 600, color: muted },
    { id: 'end', type: 'text', frame: frame(1350, 864, 150, 30), text: 'END', fontSize: 20, fontWeight: 700, fontFamily: mono, align: 'right', color: accent },
  ]
  if (layoutId === 'process-flow') {
    const flowNode = (id: string, index: number, x: number, w: number, emphasized = false): SlideElement[] => [
      { id: `stage-${id}`, type: 'text', frame: frame(x, 300, w, 40), text: `STEP ${index}`, fontSize: 17, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2, ...(index > 1 ? { animation: { enter: 'fade-up', delayFrames: index * 8, durationFrames: 16 } } : { animation: { enter: 'fade-up', durationFrames: 16 } }) },
      { id: `node-${id}`, type: 'shape', frame: frame(x, 356, w, 176), shape: 'rounded-rectangle', fill: emphasized ? text : surface, radius: 18, stroke: emphasized ? text : muted, strokeWidth: 2, text: t.flowStages[index - 1], textColor: emphasized ? background : text, fontSize: 28, fontWeight: 700, align: 'center', verticalAlign: 'middle', animation: { enter: 'scale', delayFrames: 4 + index * 8, durationFrames: 18 } },
    ]
    const arrow = (id: string, x: number): SlideElement => ({ id, type: 'line', frame: frame(x, 444, 56, 4), color: muted, strokeWidth: 3, arrowEnd: true, animation: { enter: 'fade', delayFrames: 14 * 1, durationFrames: 14 } })
    const boxes = [88, 474, 860, 1246]
    return [
      { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'FLOW / PIPELINE', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
      title('title', t.flowTitle, 88, 112, 1300, 64, 44),
      ...boxes.flatMap((x, index) => flowNode(String(index + 1), index + 1, x, 266, index === 0 || index === 3)),
      arrow('arrow-1', 362),
      arrow('arrow-2', 748),
      arrow('arrow-3', 1134),
      { id: 'edge-start', type: 'text', frame: frame(88, 552, 266, 32), text: t.flowStart.toUpperCase(), fontSize: 15, fontWeight: 700, fontFamily: mono, color: muted, letterSpacing: 2 },
      { id: 'edge-end', type: 'text', frame: frame(1246, 552, 266, 32), text: t.flowEnd.toUpperCase(), fontSize: 15, fontWeight: 700, fontFamily: mono, color: muted, align: 'right', letterSpacing: 2 },
      { id: 'takeaway-bar', type: 'shape', frame: frame(88, 740, 6, 56), shape: 'rectangle', fill: accent },
      body('takeaway', t.flowTakeaway, 114, 750, 1398, 52),
    ]
  }
  if (layoutId === 'decision-branch') {
    const flowNode = (id: string, label: string, x: number, w: number, h = 150): SlideElement => ({ id, type: 'shape', frame: frame(x, 330, w, h), shape: 'rounded-rectangle', fill: surface, radius: 18, stroke: muted, strokeWidth: 2, text: label, textColor: text, fontSize: 26, fontWeight: 700, align: 'center', verticalAlign: 'middle' })
    const arrow = (id: string, x: number, y = 398, w = 52): SlideElement => ({ id, type: 'line', frame: frame(x, y, w, 4), color: muted, strokeWidth: 3, arrowEnd: true })
    const strip = (id: string, x: number, y: number, w: number, h: number): SlideElement => ({ id, type: 'shape', frame: frame(x, y, w, h), shape: 'rectangle', fill: muted, opacity: .75 })
    return [
      { id: 'kicker', type: 'text', frame: frame(88, 64, 700, 34), text: 'FLOW / BRANCH + LOOP-BACK', fontSize: 18, fontWeight: 700, fontFamily: mono, color: accent, letterSpacing: 2 },
      title('title', t.branchTitle, 88, 112, 1350, 64, 44),
      flowNode('adopt', t.branchAdopt, 168, 270),
      arrow('a-pass-1', 446),
      { id: 'decision', type: 'shape', frame: frame(510, 312, 360, 186), shape: 'rounded-rectangle', fill: background, radius: 24, stroke: accent, strokeWidth: 3, text: t.branchQuestion, textColor: text, fontSize: 28, fontWeight: 800, align: 'center', verticalAlign: 'middle' },
      { id: 'label-yes', type: 'text', frame: frame(884, 344, 56, 34), text: t.branchYes, fontSize: 17, fontWeight: 700, fontFamily: mono, color: accent },
      arrow('a-yes', 878, 398, 64),
      flowNode('verify', t.branchVerify, 950, 264),
      arrow('a-ship', 1222),
      flowNode('ship', t.branchShip, 1282, 218),
      strip('loop-v1', 687, 498, 6, 152),
      { id: 'label-no', type: 'text', frame: frame(703, 508, 220, 34), text: t.branchNo, fontSize: 17, fontWeight: 700, fontFamily: mono, color: accent },
      strip('loop-h', 108, 650, 579, 6),
      strip('loop-v2', 108, 406, 6, 244),
      arrow('a-loop-back', 120, 412, 42),
      body('loop-note', t.branchLoopNote, 238, 674, 900, 44),
      { id: 'takeaway-bar', type: 'shape', frame: frame(88, 740, 6, 56), shape: 'rectangle', fill: accent },
      body('takeaway', t.branchTakeaway, 114, 750, 1398, 52),
    ]
  }
  return [
    title('title', t.cardsFallbackTitle, 80, 64, 1440, 90, 54),
    ...[0, 1, 2].map((index): SlideElement => ({
      id: `card-${index + 1}`,
      type: 'shape',
      frame: frame(80 + index * 510, 230, 440, 430),
      shape: 'rounded-rectangle',
      fill: index === 0 ? accent : index === 1 ? text : surface,
      radius: 22,
      text: `0${index + 1}\n${t.cardsFallbackHint}`,
      textColor: index < 2 ? background : text,
      fontSize: 32,
      fontWeight: 700,
      align: 'left',
      verticalAlign: 'middle',
    })),
  ]
}
