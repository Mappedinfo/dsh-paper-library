const HEADER_LIMIT = 64 * 1024
const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]
const ITEM_WIDTHS = { b: [1], u: [1, 2, 4, 8], i: [1, 2, 4, 8], f: [2, 4, 8, 12, 16], c: [8, 16, 24, 32] }

const dimension = value => Number.isSafeInteger(value) && value >= 0
const invalidHeader = () => new Error('NPY 文件头无效，需要包含 descr、fortran_order 和 shape 三个字段。')

/** 仅解析简单数值 dtype 所需的 Python 字面量子集；不执行文件头中的表达式。 */
function parseHeader(text) {
  if (!text.endsWith('\n')) throw invalidHeader()
  let pos = 0
  const token = /\s*(?:('[^'\\\r\n]*'|"[^"\\\r\n]*")|(True|False)|(0|[1-9]\d*)(?:L)?|([{}():,]))/y
  function next() {
    token.lastIndex = pos
    const match = token.exec(text)
    if (!match) throw invalidHeader()
    pos = token.lastIndex
    return match[1] ?? match[2] ?? match[3] ?? match[4]
  }
  function requireToken(expected) {
    if (next() !== expected) throw invalidHeader()
  }
  function stringValue(raw) {
    if (!raw.startsWith("'") && !raw.startsWith('"')) throw invalidHeader()
    return raw.slice(1, -1)
  }
  function shapeValue() {
    requireToken('(')
    const result = []
    let value = next()
    while (value !== ')') {
      const axis = Number(value)
      if (!/^\d+$/.test(value) || !dimension(axis)) throw new Error('NPY 轴长须为非负安全整数。')
      result.push(axis)
      const separator = next()
      if (separator === ')' && result.length > 1) break
      if (separator !== ',') throw invalidHeader()
      value = next()
    }
    return result
  }
  requireToken('{')
  const header = {}
  const seen = new Set()
  let key = next()
  while (key !== '}') {
    const field = stringValue(key)
    if (seen.has(field)) throw invalidHeader()
    seen.add(field)
    requireToken(':')
    if (field === 'descr') header.dtype = stringValue(next())
    else if (field === 'fortran_order') {
      const order = next()
      if (order !== 'True' && order !== 'False') throw invalidHeader()
      header.fortranOrder = order === 'True'
    } else if (field === 'shape') header.shape = shapeValue()
    else throw invalidHeader()
    const separator = next()
    if (separator === '}') break
    if (separator !== ',') throw invalidHeader()
    key = next()
  }
  if (text.slice(pos).trim() || seen.size !== 3) throw invalidHeader()
  return { shape: header.shape, dtype: header.dtype, fortranOrder: header.fortranOrder }
}

/** 浏览器端只读取 NPY 1.0、2.0、3.0 的头部；数据区仅核对声明字节数。 */
export async function readNpyShape(file) {
  if (!file || typeof file.slice !== 'function' || !dimension(file.size)) throw new Error('请选择本地 .npy 数值数组。')
  async function bytes(start, end) {
    if (end > file.size) throw new Error('NPY 文件已截断，未读到完整文件头。')
    let data
    try { data = new Uint8Array(await file.slice(start, end).arrayBuffer()) }
    catch { throw new Error('无法读取 NPY 文件头。') }
    if (data.length !== end - start) throw new Error('未读到完整的 NPY 文件头。')
    return data
  }
  const prefix = await bytes(0, 8)
  if (!MAGIC.every((byte, i) => prefix[i] === byte)) throw new Error('文件缺少 NPY 标识，请选择单个 .npy 数组。')
  const major = prefix[6]
  if (![1, 2, 3].includes(major) || prefix[7] !== 0) throw new Error('只支持 NPY 1.0、2.0、3.0。')
  const lengthEnd = major === 1 ? 10 : 12
  const lengthField = await bytes(8, lengthEnd)
  const field = new DataView(lengthField.buffer)
  const length = major === 1 ? field.getUint16(0, true) : field.getUint32(0, true)
  if (!length || length > HEADER_LIMIT) throw new Error('NPY 文件头须在 1 字节至 64 KiB 之间。')
  const dataStart = lengthEnd + length
  const encoded = await bytes(lengthEnd, dataStart)
  let text
  try { text = new TextDecoder(major === 3 ? 'utf-8' : 'latin1', { fatal: true }).decode(encoded) }
  catch { throw new Error('NPY 文件头的文本编码无效。') }
  const header = parseHeader(text)
  const type = /^([<>=|]?)([buifc])([1-9]\d*)$/.exec(header.dtype)
  const width = type && Number(type[3])
  if (!type || !ITEM_WIDTHS[type[2]].includes(width) || (type[1] === '|' && width !== 1)) {
    throw new Error('需使用简单布尔、整数、浮点或复数 NPY 数组。')
  }

  const remaining = BigInt(file.size - dataStart)
  let expected = header.shape.includes(0) ? 0n : BigInt(width)
  if (expected) {
    for (const axis of header.shape) {
      expected *= BigInt(axis)
      if (expected > remaining) break
    }
  }
  if (expected !== remaining) throw new Error('NPY 数据长度与文件头声明的形状或 dtype 不符。')
  return header
}

/** 从一个输入对齐明确的符号轴；未知秩或未知轴不产生符号绑定。 */
export function bindInputShape(declared, actual) {
  if (!Array.isArray(actual) || !Array.from(actual).every(dimension)) throw new Error('实测形状的轴长须为非负安全整数。')
  const bindings = Object.create(null)
  if (declared === null) return bindings
  if (!Array.isArray(declared)) throw new Error('输入形状声明无效。')
  const open = declared[0] === '...'
  const dims = open ? declared.slice(1) : declared
  if (dims.includes('...')) throw new Error('形状声明中的省略号只能位于开头。')
  if ((!open && dims.length !== actual.length) || (open && dims.length > actual.length)) {
    throw new Error('实测维数与该输入的形状声明不符。')
  }
  const offset = actual.length - dims.length
  for (let i = 0; i < dims.length; i++) {
    const symbol = dims[i], axis = actual[offset + i], index = offset + i + 1
    if (symbol === '?') continue
    if (dimension(symbol)) {
      if (symbol !== axis) throw new Error('第 ' + index + ' 轴应为 ' + symbol + '，实测为 ' + axis + '。')
    } else if (typeof symbol === 'string' && /^[A-Za-z][A-Za-z_0-9]*$/.test(symbol)) {
      if (Object.hasOwn(bindings, symbol) && bindings[symbol] !== axis) throw new Error('符号 ' + symbol + ' 在同一输入的多个轴上不一致。')
      bindings[symbol] = axis
    } else {
      throw new Error('第 ' + index + ' 轴的声明不能用于直接绑定，不支持计算维度表达式。')
    }
  }
  return bindings
}
