import { z } from 'zod'
import type { SlideElement, Theme } from './schema.js'

import { PlainDeckError } from './errors.js'
export const tableStyles = ['rules', 'grid', 'stripes'] as const
export type TableStyle = typeof tableStyles[number]
export type TableAlignment = 'left' | 'center' | 'right'

export const TableContentSchema = z.object({
  title: z.string().trim().min(1),
  columns: z.array(z.string().trim().min(1)).min(2).max(8),
  rows: z.array(z.array(z.string())).min(1).max(12),
  alignments: z.array(z.enum(['left', 'center', 'right'])).optional(),
  takeaway: z.string().trim().optional(),
  source: z.string().trim().optional(),
}).superRefine((content, context) => {
  content.rows.forEach((row, index) => {
    if (row.length !== content.columns.length) context.addIssue({ code: 'custom', path: ['rows', index], message: `第 ${index + 1} 行有 ${row.length} 列，表头有 ${content.columns.length} 列。` })
  })
  if (content.alignments && content.alignments.length !== content.columns.length) context.addIssue({ code: 'custom', path: ['alignments'], message: '列对齐方式数量必须与表格列数一致。' })
})

export type TableContent = z.infer<typeof TableContentSchema>

export const exampleTable = `# 主要结果：本文方法在准确率与延迟上同时改进

| 方法 | Accuracy ↑ | Latency ↓ |
| --- | ---: | ---: |
| Baseline | 82.4 | 41 ms |
| PlainDeck | 89.7 | 28 ms |
| Ablation | 85.1 | 33 ms |

Takeaway: 改进不是以更高延迟为代价。
Source: Table 2 · replace with the original source`

const stripInline = (value: unknown) => String(value ?? '')
  .trim()
  .replace(/<[^>]+>/g, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/`([^`]+)`/g, '$1')

function splitPipeRow(line: string) {
  const cells: string[] = []
  let current = ''; let escaped = false
  for (const character of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (escaped) { current += character; escaped = false }
    else if (character === '\\') escaped = true
    else if (character === '|') { cells.push(stripInline(current)); current = '' }
    else current += character
  }
  cells.push(stripInline(current))
  return cells
}

function parseDelimited(source: string, delimiter: ',' | '\t') {
  const rows: string[][] = []
  let row: string[] = []; let cell = ''; let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1 }
      else quoted = !quoted
    } else if (!quoted && character === delimiter) { row.push(stripInline(cell)); cell = '' }
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(stripInline(cell)); cell = ''
      if (row.some(value => value.length)) rows.push(row)
      row = []
    } else cell += character
  }
  row.push(stripInline(cell))
  if (row.some(value => value.length)) rows.push(row)
  return rows
}

function alignmentFromSeparator(value: string): TableAlignment {
  const trimmed = value.trim()
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
  if (trimmed.endsWith(':')) return 'right'
  return 'left'
}

const markdownSeparator = (row: string[]) => row.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
const numberLike = (value: string) => /^[-+]?[$¥€£]?[\d,.]+(?:\s*%|\s*(?:ms|s|m|h|px|MB|GB|TB))?$/i.test(value.trim())

function inferAlignments(columns: string[], rows: string[][]): TableAlignment[] {
  return columns.map((_, column) => column > 0 && rows.every(row => !row[column] || numberLike(row[column])) ? 'right' : 'left')
}

function contentFromMatrix(matrix: string[][], metadata: Partial<Pick<TableContent, 'title' | 'takeaway' | 'source' | 'alignments'>> = {}): TableContent {
  if (matrix.length < 2) throw new PlainDeckError('table-needs-header-and-row', { zh: '表格至少需要一行表头和一行数据。', en: 'The table needs at least one header row and one data row.' })
  const columns = matrix[0].map(stripInline)
  const rows = matrix.slice(1).map(row => row.map(stripInline))
  return TableContentSchema.parse({
    title: metadata.title?.trim() || '关键对比',
    columns,
    rows,
    alignments: metadata.alignments ?? inferAlignments(columns, rows),
    takeaway: metadata.takeaway,
    source: metadata.source,
  })
}

function parseJsonTable(source: string): TableContent {
  const raw = JSON.parse(source) as unknown
  if (Array.isArray(raw)) {
    if (raw.length && raw.every(row => Array.isArray(row))) return contentFromMatrix(raw as string[][])
    if (raw.length && raw.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
      const records = raw as Array<Record<string, unknown>>
      const columns = Object.keys(records[0])
      return TableContentSchema.parse({ title: '关键对比', columns, rows: records.map(record => columns.map(column => stripInline(record[column]))), alignments: inferAlignments(columns, records.map(record => columns.map(column => stripInline(record[column])))) })
    }
  }
  if (!raw || typeof raw !== 'object') throw new PlainDeckError('table-json-shape', { zh: 'JSON 表格必须是二维数组、对象数组，或包含 title / columns / rows 的对象。', en: 'A JSON table must be a 2-D array, an array of objects, or an object with title / columns / rows.' })
  const record = raw as Record<string, unknown>
  const columns = (record.columns ?? record.headers) as unknown
  const rows = record.rows as unknown
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new PlainDeckError('table-json-columns-rows', { zh: 'JSON 表格需要 columns 与 rows。', en: 'A JSON table requires columns and rows.' })
  return TableContentSchema.parse({
    title: stripInline(record.title) || '关键对比',
    columns: columns.map(stripInline),
    rows: rows.map(row => Array.isArray(row) ? row.map(stripInline) : []),
    alignments: Array.isArray(record.alignments) ? record.alignments : undefined,
    takeaway: record.takeaway === undefined ? undefined : stripInline(record.takeaway),
    source: record.source === undefined ? undefined : stripInline(record.source),
  })
}

export function parseTableContent(source: string): TableContent {
  const trimmed = source.trim()
  if (!trimmed) throw new PlainDeckError('table-empty', { zh: '表格内容不能为空。', en: 'Table content must not be empty.' })
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonTable(trimmed)

  const lines = trimmed.split(/\r?\n/)
  const title = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim()
  const takeaway = lines.find(line => /^takeaway\s*:/i.test(line))?.replace(/^takeaway\s*:/i, '').trim()
  const sourceLabel = lines.find(line => /^source\s*:/i.test(line))?.replace(/^source\s*:/i, '').trim()
  const pipeLines = lines.filter(line => line.includes('|') && !/^\s*(?:takeaway|source)\s*:/i.test(line))
  if (pipeLines.length >= 2) {
    const pipeRows = pipeLines.map(splitPipeRow)
    const separatorIndex = pipeRows.findIndex(markdownSeparator)
    const header = separatorIndex === 1 ? pipeRows[0] : pipeRows[0]
    const body = separatorIndex === 1 ? pipeRows.slice(2) : pipeRows.slice(1)
    const alignments = separatorIndex === 1 ? pipeRows[1].map(alignmentFromSeparator) : inferAlignments(header, body)
    return contentFromMatrix([header, ...body], { title, takeaway, source: sourceLabel, alignments })
  }

  const contentLines = lines.filter(line => line.trim() && !/^#\s+/.test(line) && !/^\s*(?:takeaway|source)\s*:/i.test(line))
  const delimiter: ',' | '\t' = contentLines.some(line => line.includes('\t')) ? '\t' : ','
  return contentFromMatrix(parseDelimited(contentLines.join('\n'), delimiter), { title, takeaway, source: sourceLabel })
}

export function tableCellsToTsv(cells: string[][]) {
  return cells.map(row => row.join('\t')).join('\n')
}

export function parseTableCells(source: string) {
  const normalized = source.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  const rows = parseDelimited(normalized, source.includes('\t') ? '\t' : ',')
  if (!rows.length || !rows[0].length) throw new PlainDeckError('table-grid-empty', { zh: '表格网格不能为空。', en: 'The table grid must not be empty.' })
  const columns = rows[0].length
  return rows.map((row, index) => {
    if (row.length !== columns) throw new PlainDeckError('row-column-mismatch', { zh: `第 ${index + 1} 行有 ${row.length} 列，第一行有 ${columns} 列。`, en: `Row ${index + 1} has ${row.length} columns while the first row has ${columns}.` })
    return row
  })
}

const frame = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

export function createTableSlideElements(content: TableContent, theme: Theme, canvas = { width: 1600, height: 900 }, style: TableStyle = 'rules'): SlideElement[] {
  const parsed = TableContentSchema.parse(content)
  const scaleX = canvas.width / 1600; const scaleY = canvas.height / 900; const scale = Math.min(scaleX, scaleY)
  const scaledFrame = (x: number, y: number, w: number, h: number) => frame(Math.round(x * scaleX), Math.round(y * scaleY), Math.round(w * scaleX), Math.round(h * scaleY))
  const fs = (value: number) => Math.max(1, Math.round(value * scale))
  const cells = [parsed.columns, ...parsed.rows]
  const firstWeight = parsed.columns.length >= 4 ? 1.35 : 1.55
  const columnWidths = parsed.columns.map((_, index) => index === 0 ? firstWeight : 1)
  const elements: SlideElement[] = [
    { id: 'kicker', type: 'text', frame: scaledFrame(88, 56, 720, 32), text: 'EVIDENCE / TABLE', fontSize: fs(17), fontWeight: 700, fontFamily: theme.fonts.mono ?? theme.fonts.body, color: theme.colors.accent, letterSpacing: 2 },
    { id: 'title', type: 'text', styleRef: 'slide-title', frame: scaledFrame(88, 108, 1424, 78), text: parsed.title, fontSize: fs(46), fontWeight: 700, color: theme.colors.text, fit: 'shrink' },
    {
      id: 'table', type: 'table', frame: scaledFrame(88, 222, 1424, parsed.takeaway ? 442 : 500), cells,
      headerRows: 1, columnWidths, alignments: parsed.alignments, style, fontSize: fs(cells.length > 8 ? 18 : cells.length > 6 ? 20 : 23),
      textColor: theme.colors.text, headerTextColor: theme.colors.text, headerFill: theme.colors.surface,
      stripeFill: theme.colors.surface, ruleColor: theme.colors.muted, accentColor: theme.colors.accent,
      ruleWidth: Math.max(1, fs(2)), cellPadding: fs(18),
    },
  ]
  if (parsed.takeaway) elements.push(
    { id: 'takeaway-rule', type: 'shape', frame: scaledFrame(88, 708, 7, 62), shape: 'rectangle', fill: theme.colors.accent },
    { id: 'takeaway', type: 'text', frame: scaledFrame(122, 708, 1390, 62), text: parsed.takeaway, fontSize: fs(25), fontWeight: 600, color: theme.colors.text, verticalAlign: 'middle', fit: 'shrink' },
  )
  elements.push({ id: 'source', type: 'text', frame: scaledFrame(88, 838, 1424, 28), text: parsed.source || 'SOURCE · TABLE / DATASET · YEAR', fontSize: fs(15), fontWeight: 600, fontFamily: theme.fonts.mono ?? theme.fonts.body, color: theme.colors.muted })
  return elements
}
