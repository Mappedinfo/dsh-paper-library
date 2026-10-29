const KEY_ORDER = [
  'schemaVersion', 'id', 'title', 'canvas', 'width', 'height', 'theme', 'footer', 'left', 'center', 'right', 'slides',
  'name', 'layoutRef', 'background', 'token', 'color', 'motion', 'camera', 'fromScale', 'toScale', 'elements', 'type', 'styleRef',
  'frame', 'x', 'y', 'w', 'h', 'text', 'cells', 'headerRows', 'columnWidths', 'alignments', 'style', 'textColor', 'headerTextColor',
  'headerFill', 'stripeFill', 'ruleColor', 'accentColor', 'ruleWidth', 'cellPadding', 'highlightRows', 'align', 'verticalAlign', 'fit', 'fontSize', 'fontFamily',
  'fontWeight', 'src', 'alt', 'shape', 'fill', 'stroke', 'strokeWidth', 'radius',
  'dash', 'arrowEnd', 'opacity', 'rotation', 'zIndex', 'animation', 'enter', 'delayFrames', 'durationFrames', 'fonts', 'fontSizes', 'colors',
  'spacing', 'body', 'mono', 'heading', 'caption', 'muted', 'accent', 'page', 'small',
  'medium', 'large',
]

const rank = new Map(KEY_ORDER.map((key, index) => [key, index]))

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999) || a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}
