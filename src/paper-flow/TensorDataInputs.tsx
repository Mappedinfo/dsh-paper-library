import { useEffect, useRef, useState } from 'react'
import type { FlowGraph } from '../../vendor/paper-flow/types'
import { nodeTensorPreview } from './tensor-preview.mjs'
import { bindInputShape, readNpyShape } from './tensor-data.mjs'

export type ObservedDimensions = Record<string, { value: number; source: string }>
type InputPort = { id: string; name: string; shape: (string | number)[] }
type InputFile = { name: string; shape: number[]; dimensions: Record<string, number> }
type Props = { onChange: (dimensions: ObservedDimensions) => void }

function collectDimensions(files: Map<string, InputFile>): ObservedDimensions {
  const result: ObservedDimensions = Object.create(null)
  for (const file of files.values()) {
    for (const [symbol, value] of Object.entries(file.dimensions)) {
      const previous = result[symbol]
      if (previous && previous.value !== value) {
        throw Error(`${symbol} 的大小不一致：${previous.source} 为 ${previous.value}，${file.name} 为 ${value}。请选择同一次模型调用的输入。`)
      }
      if (!previous) result[symbol] = { value, source: file.name }
    }
  }
  return result
}

function InputPicker({ inputs, onChange }: { inputs: InputPort[] } & Props) {
  const [files, setFiles] = useState(new Map<string, InputFile>())
  const current = useRef(files)
  const requests = useRef(new Map<string, number>())
  const [messages, setMessages] = useState<Record<string, string>>({})
  useEffect(() => {
    onChange(Object.create(null))
    const pending = requests.current
    return () => pending.clear()
  }, [onChange])

  function update(id: string, file?: InputFile) {
    const next = new Map(current.current)
    if (file) next.set(id, file)
    else next.delete(id)
    const dimensions = collectDimensions(next)
    current.current = next
    setFiles(next)
    onChange(dimensions)
  }
  async function choose(input: InputPort, file?: File) {
    const id = input.id
    const ticket = (requests.current.get(id) || 0) + 1
    requests.current.set(id, ticket)
    setMessages(old => ({ ...old, [id]: file ? '正在读取形状…' : '' }))
    if (!file) { update(id); return }
    try {
      const { shape } = await readNpyShape(file)
      if (requests.current.get(id) !== ticket) return
      const dimensions = bindInputShape(input.shape, shape)
      update(id, { name: file.name, shape, dimensions })
      setMessages(old => ({ ...old, [id]: '' }))
    } catch (error) {
      if (requests.current.get(id) === ticket) {
        setMessages(old => ({ ...old, [id]: error instanceof Error ? error.message : '无法读取张量形状。' }))
      }
    }
  }

  return <details className="eqtrace-data-inputs">
    <summary>关联实际输入{files.size > 0 ? `（${files.size}）` : ''}</summary>
    <p>选择同一次模型调用中各输入的 .npy 文件，含批次轴。仅读取本地文件头，关联用于当前预览。</p>
    {inputs.map(input => {
      const file = files.get(input.id)
      return <div key={input.id} className="eqtrace-data-input">
        <label>{input.name} <code>{input.shape.join(' × ')}</code>
          <input aria-label={`${input.name} 的实际输入文件`} type="file" accept=".npy" onChange={event => {
            const selected = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (selected) void choose(input, selected)
          }}/>
        </label>
        {file && <span>{file.name} · {file.shape.join(' × ')} <button type="button" onClick={() => void choose(input)}>移除</button></span>}
        {messages[input.id] && <span role="status">{messages[input.id]}</span>}
      </div>
    })}
  </details>
}

export function TensorDataInputs({ flow, onChange }: { flow: FlowGraph } & Props) {
  const inputs: InputPort[] = []
  for (const node of flow.nodes) {
    if (node.op !== 'input') continue
    const outputs = nodeTensorPreview(node).outputs
    for (const [index, row] of outputs.entries()) {
      if (Array.isArray(row.shape) && row.shape.some(d => typeof d === 'string' && /^[A-Za-z]\w*$/.test(d))) {
        inputs.push({ id: `${node.id}.${index}`, name: row.name, shape: row.shape })
      }
    }
  }
  return inputs.length ? <InputPicker key={JSON.stringify(inputs)} inputs={inputs} onChange={onChange} /> : null
}
