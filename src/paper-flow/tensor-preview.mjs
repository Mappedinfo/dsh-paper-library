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
