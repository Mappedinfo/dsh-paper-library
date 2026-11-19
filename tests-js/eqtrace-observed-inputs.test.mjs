import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
let JSDOM
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')) } catch {}

function npy(name, shape) {
  // NPY 1.0, a 64-byte aligned little-endian int32 header, and a complete zero-filled array.
  const metadata = `{'descr': '<i4', 'fortran_order': False, 'shape': (${shape.join(', ')},), }`
  const size = Math.ceil((10 + metadata.length + 1) / 64) * 64 - 10
  const header = Buffer.alloc(10 + size, 0x20)
  header.set([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59, 1, 0])
  header.writeUInt16LE(size, 8)
  header.write(metadata, 10, 'ascii')
  header[header.length - 1] = 10
  return new File([header, Buffer.alloc(shape.reduce((n, d) => n * d, 4))], name)
}

let bundlePromise
async function environment(t) {
  const bundle = await (bundlePromise ??= build({
    stdin: {
      contents: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
        import {flushSync} from 'react-dom'; import {Figure,EqTraceSourceForm} from './src/paper-flow/EqTracePanel.tsx';
        export function mount(el, flow, documentId) {
          const root = createRoot(el);
          const render = (dataHost,controlsHost) => flushSync(() => root.render(createElement(Figure,{flow,documentId,dataHost,controlsHost})));
          render();
          return {render,unmount:() => root.unmount()};
        }
        export function mountSource(el,options) {
          const root = createRoot(el);
          flushSync(() => root.render(createElement(EqTraceSourceForm,options)));
          return () => root.unmount();
        }`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    format: 'iife', globalName: 'ObservedInputTest', platform: 'browser', bundle: true,
    jsx: 'automatic', write: false, define: {'process.env.NODE_ENV':'"production"'}, logLevel: 'silent',
  }))
  const dom = new JSDOM('<header></header><aside></aside><main></main>', {runScripts:'outside-only', url:'http://synthetic.invalid/'})
  const w = dom.window, doc = w.document
  const cleanups = []
  t.after(() => { for (const fn of cleanups.reverse()) fn(); w.close() })
  w.TextDecoder = TextDecoder
  // Only layout observation is stubbed. The file reader, rendered SVG, focus and tooltip are real.
  w.ResizeObserver = class { observe() {} disconnect() {} }
  w.eval(bundle.outputFiles[0].text)

  function changed(check, label) {
    if (check()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const observer = new w.MutationObserver(() => { if (check()) finish() })
      const timer = setTimeout(() => finish(new Error('UI did not update: ' + label)), 3000)
      function finish(error) {
        observer.disconnect()
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      observer.observe(doc.body, {subtree:true, childList:true, characterData:true, attributes:true})
    })
  }
  return {w, doc, changed, cleanups}
}

async function mount(t, document) {
  const {w, doc, changed, cleanups} = await environment(t)
  const flow = document.flows.find(f => f.id === 'network')
  const figure = w.ObservedInputTest.mount(doc.querySelector('main'), flow, document.paper.id)
  cleanups.push(figure.unmount)
  const select = doc.querySelector('.eqtrace-projection select')
  if (select) { select.value = 'full'; select.dispatchEvent(new w.Event('change', {bubbles:true})) }
  const panel = doc.querySelector('.eqtrace-data-inputs')
  panel.open = true

  function picker(name) {
    const input = doc.querySelector(`input[type="file"][aria-label="${name} 的实际输入文件"]`)
    assert.ok(input, 'Missing file chooser for ' + name)
    return input
  }
  function choose(name, file) {
    const input = picker(name)
    Object.defineProperty(input, 'files', {value: [file], configurable:true})
    input.dispatchEvent(new w.Event('change', {bubbles:true}))
  }
  function remove(name) {
    const button = picker(name).closest('.eqtrace-data-input').querySelector('button')
    assert.ok(button, 'Missing remove button for ' + name)
    button.click()
  }
  async function inspect(attribute) {
    const id = flow.nodes.find(n => n.config?.attribute === attribute)?.id
    assert.ok(id, 'Missing model layer ' + attribute)
    const selector = `g[data-node="${id}"]`
    await changed(() => doc.querySelector(selector), attribute + ' in full figure')
    doc.querySelector(selector).focus()
    const tip = () => doc.querySelector(`[role="tooltip"][data-tensor-node="${id}"]`)
    await changed(tip, attribute + ' tooltip')
    return tip()
  }
  return {changed, choose, remove, inspect, picker, doc, figure}
}

function bindings(tip) {
  const section = tip.querySelector('[aria-label="本节点的维度符号"]')
  assert.ok(section)
  return Object.fromEntries([...section.querySelectorAll('li')].map(row => {
    const [symbol,value] = row.querySelector('code').textContent.split(' = ')
    return [symbol,{value,source:row.querySelector('small')?.textContent}]
  }))
}

function item(tip, section, name) {
  const group = tip.querySelector(`section[aria-label="${section}"]`)
  const row = [...group.querySelectorAll('li')].find(li =>
    li.querySelector('.eqtrace-tensor-item-heading span')?.textContent === name)
  assert.ok(row, section + ': ' + name)
  return row
}

test('NPY selections update real LayerNorm and cross-attention previews, reject conflicting batches and restore examples', {skip:!JSDOM}, async t => {
  const document = JSON.parse(await readFile(new URL('../examples/eqtrace-attention.json', import.meta.url), 'utf8'))
  const ui = await mount(t, document)
  const norm = await ui.inspect('encoder.attention_norm')
  assert.equal(bindings(norm).S.value, '8')

  ui.choose('source', npy('source.npy',[3,11]))
  await ui.changed(() => bindings(norm).S.source === 'source.npy', 'source dimensions')
  assert.deepEqual(bindings(norm).B, {value:'3',source:'source.npy'})
  assert.equal(bindings(norm).S.value, '11')
  assert.match(item(norm,'输出','output').textContent, /3 × 11 × 32/)
  assert.match(item(norm,'输出','output').querySelector('.eqtrace-tensor-sketch').textContent, /S = 11/)

  const cross = await ui.inspect('decoder.cross_attention')
  const dataHost = ui.doc.querySelector('aside'), controlsHost = ui.doc.querySelector('header')
  ui.figure.render(dataHost, controlsHost)
  assert.equal(dataHost.contains(ui.picker('source')), true)
  assert.ok(controlsHost.querySelector('.eqtrace-projection select'))
  assert.match(controlsHost.textContent, /下载论文 SVG/)
  assert.equal(ui.doc.querySelector('main .eqtrace-data-inputs'), null)
  assert.equal(ui.doc.querySelector('[role="tooltip"]'), cross)
  assert.equal(bindings(cross).S.source, 'source.npy')
  assert.deepEqual(bindings(cross).T, {value:'未指定',source:undefined})
  assert.match(item(cross,'输入','query').textContent, /3 × T × 32/)
  assert.match(item(cross,'输入','key').textContent, /3 × 11 × 32/)
  ui.choose('target', npy('target.npy',[3,7]))
  await ui.changed(() => bindings(cross).T.source === 'target.npy', 'target dimensions')
  assert.equal(bindings(cross).T.value, '7')
  assert.match(item(cross,'输出','attn_output').textContent, /3 × 7 × 32/)
  assert.match(item(cross,'输入','value').textContent, /3 × 11 × 32/)

  ui.choose('target', npy('conflict.npy',[4,9]))
  const targetRow = ui.picker('target').closest('.eqtrace-data-input')
  await ui.changed(() => targetRow.querySelector('[role="status"]')?.textContent.includes('不一致'), 'conflict diagnosis')
  assert.match(targetRow.textContent, /conflict\.npy/)
  assert.deepEqual(bindings(cross).T, {value:'7',source:'target.npy'})
  assert.match(item(cross,'输入','query').textContent, /3 × 7 × 32/)

  ui.remove('source')
  await ui.changed(() => bindings(cross).S.value === '未指定', 'remove source')
  assert.deepEqual(bindings(cross).B, {value:'3',source:'target.npy'})
  ui.remove('target')
  await ui.changed(() => bindings(cross).B.value === '2', 'restore example')
  assert.deepEqual(bindings(cross), {
    B:{value:'2',source:undefined}, T:{value:'5',source:undefined}, S:{value:'8',source:undefined},
  })
  assert.match(item(cross,'输出','attn_output').textContent, /示例输入.*2 × 5 × 32/)
})


test('the inline source form delegates selection to its host, retains files for retry and ignores stale completion', {skip:!JSDOM,timeout:5000}, async t => {
  const {w, doc, changed, cleanups} = await environment(t)
  const host = doc.querySelector('aside'), generated = [], reads = []
  let attempt = 0, complete, activeSource, started
  const parsing = new Promise(resolve => { started = resolve })
  const unmount = w.ObservedInputTest.mountSource(host, {
    async generate(read, active) {
      activeSource = active
      reads.push(await read())
      if (++attempt === 1) throw new Error('synthetic failure')
      if (attempt === 3) await new Promise(resolve => { complete = resolve; started() })
      return 'eqtrace-generated'
    },
    onGenerated(id) { generated.push(id) },
  })
  let mounted = true
  cleanups.push(() => { if (mounted) unmount() })
  assert.equal(doc.querySelector('[role="dialog"]'), null)
  const form = host.querySelector('form'), submit = form.querySelector('[type="submit"]')
  const model = form.querySelectorAll('input[type="file"]')[1]
  function choose() {
    Object.defineProperty(model, 'files', {value:[new File(['# synthetic model'], 'sample.py')],configurable:true})
    model.dispatchEvent(new w.Event('change',{bubbles:true}))
  }
  choose()
  await changed(() => !submit.disabled,'source selection')
  submit.click()
  await changed(() => form.querySelector('[role="alert"]')?.textContent.includes('synthetic failure'),'generation error')
  assert.deepEqual(generated, [])
  submit.click()
  await changed(() => generated.length===1 && submit.disabled,'host callback and form reset')
  assert.equal(reads[1].model.name,'sample.py')
  assert.equal(reads[1].model.text,'# synthetic model')
  assert.deepEqual(generated,['eqtrace-generated'])

  choose()
  await changed(() => !submit.disabled, 'new source selection')
  submit.click()
  await changed(() => submit.textContent.includes('正在解析'),'pending generation')
  // Wait until the fake parser has consumed the files, exactly as the real host would.
  await parsing
  unmount(); mounted = false
  assert.equal(activeSource(),false)
  complete()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(generated,['eqtrace-generated'])
})
