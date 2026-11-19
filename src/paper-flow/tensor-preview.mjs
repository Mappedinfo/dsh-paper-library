const controlOperations = new Set(['guard', 'condition', 'branch', 'scope', 'exit', 'loop_exit', 'spawn', 'command', 'wait', 'checks', 'launch_group', 'wait_group', 'optimizer_step', 'zero_grad'])
const statuses = new Set(['inferred', 'partial', 'unknown', 'not_applicable'])

function descriptor(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string') return null
  const shape = Array.isArray(value.shape) && value.shape.every(axis =>
    (typeof axis === 'string' && axis.trim()) || (Number.isSafeInteger(axis) && axis >= 0)) ? value.shape : null
  if (value.kind === 'none') return { name: value.name, kind: 'none', shape: null, note: typeof value.note === 'string' ? value.note : '' }
  return { name: value.name, shape, note: typeof value.note === 'string' ? value.note : '' }
}

/** 旧版文档只有端口时保留端口名，未知形状不会被画成一个标量。 */
export function nodeTensorPreview(node) {
  const raw = node?.tensor
  if (raw && typeof raw === 'object' && statuses.has(raw.status)) {
    const list = key => Array.isArray(raw[key]) ? raw[key].map(descriptor).filter(item => item !== null) : []
    return { status: raw.status, note: typeof raw.note === 'string' ? raw.note : '',
      inputs: list('inputs'), outputs: list('outputs'), parameters: list('parameters') }
  }
  const ports = side => Object.entries(node?.ports?.[side] || {}).filter(([, port]) =>
    port?.type === 'tensor').map(([name]) => ({ name, shape: null, note: '' }))
  const inputs = ports('in'), outputs = ports('out')
  const control = !inputs.length && !outputs.length && controlOperations.has(node?.op)
  return { status: control ? 'not_applicable' : 'unknown',
    note: control ? '此节点描述控制或调度操作。' : '此版本的文档没有记录该节点的张量形状。',
    inputs, outputs, parameters: [] }
}

/** 高阶张量展示最后两轴的切片，省略号不计作一个已知轴。 */
export function shapeSketch(shape, valueKind = '') {
  if (valueKind === 'none') return { kind: 'none', label: '未返回（None）', axes: [], prefix: [], open: false }
  if (!Array.isArray(shape)) return { kind: 'unknown', label: '形状未知', axes: [], prefix: [], open: false }
  const label = shape.length ? shape.map(d => d === '...' ? '…' : d).join(' × ') : '[]'
  const open = shape.includes('...')
  const axes = open ? shape.slice(shape.lastIndexOf('...') + 1) : shape
  const prefix = axes.slice(0, -2)
  const kind = shape.includes(0) ? 'empty' : open && !axes.length ? 'open' : !axes.length ? 'scalar' :
    axes.length === 1 ? 'vector' : axes.length === 2 && !open ? 'matrix' : 'slices'
  return { kind, label, axes, prefix, open }
}

export function tileCount(axis) {
  return typeof axis === 'number' ? Math.min(axis, 5) : 4
}

const identifier = /^[\p{L}_][\p{L}\p{N}_]*$/u
const specialAxes = new Set(['?', '...', '…', 'None', 'unknown'])

/** 只解析轴尺寸中的整数算术与完整标识符，不读取对象属性或执行表达式。 */
function axisValue(axis, bindings) {
  const unchanged = { value: axis, names: [], changed: false }
  if (typeof axis !== 'string' || specialAxes.has(axis) || axis.length > 512) return unchanged
  const tokens = axis.match(/[\p{L}_][\p{L}\p{N}_]*|\d+|\/\/|[+*/%×()-]/gu) || []
  if (!tokens.length || tokens.length > 64 || tokens.join('') !== axis.replace(/\s+/gu, '')) return unchanged
  const names = new Set()
  let at = 0, valid = true, replaced = false
  const finite = x => Number.isSafeInteger(x) ? x : null
  function atom() {
    const token = tokens[at++]
    if (token === '(') {
      const value = sum()
      if (tokens[at++] !== ')') valid = false
      return value
    }
    if (token === '-' || token === '+') {
      const v = atom()
      return v === null ? null : token === '-' ? -v : v
    }
    if (token && identifier.test(token) && !specialAxes.has(token)) {
      names.add(token)
      const value = bindings.get(token)?.value
      if (value === undefined) return null
      replaced = true
      return value
    }
    if (token && /^\d+$/u.test(token)) return finite(Number(token))
    valid = false
    return null
  }
  function product() {
    let value = atom()
    while (['*', '×', '/', '//', '%'].includes(tokens[at])) {
      const op = tokens[at++], b = atom()
      if (value === null || b === null) value = null
      else if (op === '*' || op === '×') value = finite(value * b)
      else if (b === 0) value = null
      else if (op === '//') value = finite(Math.floor(value / b))
      else if (op === '%') {
        const rem = value % b
        value = rem && (rem < 0) !== (b < 0) ? finite(rem + b) : rem
      }
      else value = finite(value / b)
    }
    return value
  }
  function sum() {
    let value = product()
    while (tokens[at] === '+' || tokens[at] === '-') {
      const op = tokens[at++], b = product()
      value = value === null || b === null ? null : finite(op === '+' ? value + b : value - b)
    }
    return value
  }
  const value = sum()
  if (!valid || at !== tokens.length || !names.size) return unchanged
  // 部分代入保留表达式和缺值符号，非整数、不安全整数及负结果均不标为确定轴宽。
  const mapped = !replaced ? axis : value !== null && value >= 0 ? value :
    axis.replace(/[\p{L}_][\p{L}\p{N}_]*/gu, name => String(bindings.get(name)?.value ?? name))
  return { value: mapped, names: [...names], changed: replaced }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validSize = value => Number.isSafeInteger(value) && value >= 0

/** 真实输入优先于示例。尚未观察的轴保留符号，不混用另一组赋值。 */
export function tensorDimensionContext(tensor, examples, meanings, observed, imported) {
  const readings = raw => record(raw) ? Object.entries(raw).filter(([name, item]) =>
    identifier.test(name) && record(item) && validSize(item.value) && typeof item.source === 'string' && item.source.trim()) : []
  const files = readings(observed)
  const measurements = files.length ? files : readings(imported)
  const mode = measurements.length ? 'actual' : 'example'
  const values = new Map()
  if (mode === 'actual') {
    for (const [name, item] of measurements) {
      const source = item.source.trim()
      values.set(name, { value: item.value, source: files.length ? source.split(/[\\/]/u).at(-1) || source : source })
    }
  } else if (record(examples)) {
    for (const [name, value] of Object.entries(examples)) if (identifier.test(name) && validSize(value)) values.set(name, { value })
  }
  const bindings = new Map()
  for (const item of [...tensor.inputs, ...tensor.outputs, ...tensor.parameters]) {
    for (const axis of item.shape || []) for (const name of axisValue(axis, values).names) {
      if (!bindings.has(name)) bindings.set(name, { name, ...values.get(name),
        meaning: record(meanings) && Object.hasOwn(meanings, name) && typeof meanings[name] === 'string' ? meanings[name].trim() : '' })
    }
  }
  return { mode, bindings, imported: mode === 'actual' && !files.length }
}

/** 原形状保持可追溯；图示使用同一套可核对的代入结果。 */
export function bindTensorShape(shape, context) {
  if (!Array.isArray(shape)) return { shape, axes: [], hasSymbols: false, changed: false }
  const axes = shape.map(axis => axisValue(axis, context.bindings))
  return { shape: axes.map(a => a.value), axes, hasSymbols: axes.some(a => a.names.length), changed: axes.some(a => a.changed) }
}

export function boundAxisLabel(axis, context) {
  const resolved = axisValue(axis, context.bindings)
  return resolved.names.length ? `${axis} = ${resolved.changed ? resolved.value : '未指定'}` : String(axis)
}
