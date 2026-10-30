import type { CSSProperties } from 'react'
import { nodeKinds, nodeShape } from './core/nodeKinds.js'

const section: CSSProperties = { margin: '0 0 12px' }
const list: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 12px', margin: 0, padding: 0, listStyle: 'none' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }
const heading: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '0 0 7px' }

function Line({ color, dash }: { color: string; dash?: string }) {
  return <svg aria-hidden="true" width="48" height="20" viewBox="0 0 48 20" style={{ flex: 'none' }}><path d="M3 10H39" fill="none" stroke={color} strokeWidth="2" strokeDasharray={dash} /><path d="M39 6l6 4-6 4z" fill={color} /></svg>
}

/** The host supplies the surrounding dialog or popover. All shapes are static renderer output. */
export function FlowLegend() {
  return <div className="paper-flow-legend" style={{ color: 'var(--dsw-alias-label-primary, currentColor)', fontSize: 14, lineHeight: 1.6 }}>
    <section style={section} aria-label="节点形状">
      <h3 style={heading}>节点形状</h3>
      <ul style={list}>{nodeKinds.map(([kind, title]) => <li key={kind} style={row}>
        <svg aria-hidden="true" width="48" height="32" viewBox="0 0 48 32" style={{ flex: 'none', color: 'var(--dsw-alias-label-primary, #364e59)' }}><g stroke="currentColor" fill="var(--dsw-alias-bg-base, white)" strokeWidth="1.5" dangerouslySetInnerHTML={{ __html: nodeShape({ type: kind }, 4, 4, 40, 24) }} /></svg>
        <span>{title}</span>
      </li>)}</ul>
    </section>
    <section style={section} aria-label="对齐与连线">
      <h3 style={heading}>对齐与连线</h3>
      <ul style={list}>
        <li style={row}><Line color="#0072b2" dash="8 5" /><span>A 未配对</span></li>
        <li style={row}><Line color="#c23e4e" dash="8 5" /><span>B 未配对</span></li>
        <li style={row}><Line color="#9c6b06" /><span>已对齐</span></li>
        <li style={row}><Line color="var(--dsw-alias-label-secondary, #52616c)" dash="3 7" /><span>次要关系</span></li>
      </ul>
      <p style={{ margin: '6px 0 0' }}>对齐只依据已声明的比较字段；未比较内容仍需核对。箭头表示声明的关系，线型也可能由手动设置改变。</p>
    </section>
    <section style={{ ...section, marginBottom: 0 }} aria-label="其他标记">
      <h3 style={heading}>其他标记</h3>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>小桥表示连线交叉但不连接；依赖由箭头端点表示。</li>
        <li>浅金色为输入资源；浅紫色及文档图标为已声明的产物，不代表产物已经生成。</li>
        <li>临时草稿仅改变显示，不计入科学匹配。</li>
      </ul>
    </section>
  </div>
}
