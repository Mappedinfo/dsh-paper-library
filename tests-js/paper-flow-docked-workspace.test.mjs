import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createWorkspace, draftKey } from '../vendor/paper-flow/document.js'
import { prepareGraph } from '../vendor/paper-flow/comparison.js'
import engine from '../vendor/paper-flow/core/graph.js'

const require = createRequire(import.meta.url)
let JSDOM
try { ({JSDOM} = require(process.env.JSDOM_MODULE || 'jsdom')) } catch {}

function originalWorkspace() {
  const documents = ['A','B','C'].map(id => ({
    schemaVersion:1,kind:'paper-flow-document',paper:{id,title:'Synthetic ' + id},
    flows:[{id:'test',name:'Flow ' + id,edges:[],nodes:[
      {id:'step',label:'Step ' + id,type:'method',ports:{in:{},out:{}}},
    ]}],
  }))
  const left = {documentId:'A',flowId:'test'}
  const work = createWorkspace(documents,{left,right:{documentId:'B',flowId:'test'}})
  const [step] = engine.layout(prepareGraph(documents[0].flows[0],work.view)).nodes
  work.drafts[draftKey(left,work.view)] = {nodes:{[step.id]:{x:step.x,y:step.y,fixed:true}},edges:{},relations:[]}
  return work
}

function tokenFile() {
  const prefix = Buffer.alloc(128,32), size = 118
  prefix.set([0x93,78,85,77,80,89,1,0])
  prefix.writeUInt16LE(size,8)
  prefix.write("{'descr': '|u1', 'fortran_order': False, 'shape': (3, 7), }",10,'ascii')
  prefix[127] = 10
  return new File([prefix,Buffer.alloc(21)],'batch-tokens.npy')
}

let compiled
async function fixture(t, initial, generate) {
  compiled ??= build({
    entryPoints:[fileURLToPath(new URL('../src/paper-flow/main.tsx',import.meta.url))],
    bundle:true, write:false, platform:'browser', format:'iife', target:'es2022', jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"'}, loader:{'.css':'text'}, logLevel:'silent',
  })
  const [bundle, nativeToolbar] = await Promise.all([
    compiled, readFile(new URL('../web/board-flow.js', import.meta.url),'utf8'),
  ])
  const dom = new JSDOM('<div id="paper-tools"></div><main id="flow"></main>',
    {url:'http://synthetic.invalid/',runScripts:'outside-only',pretendToBeVisual:true})
  const w=dom.window, doc=w.document, root=doc.getElementById('flow'), events=[], saves=[], errors=[]
  w.structuredClone=structuredClone; w.TextEncoder=TextEncoder; w.TextDecoder=TextDecoder
  w.ResizeObserver=class { observe() {} disconnect() {} }
  w.eval(nativeToolbar)
  w.eval(bundle.outputFiles[0].text)
  doc.addEventListener('paper-flow-panels-state', e => events.push({open:e.detail.open,panel:e.detail.panel}))
  let saved=structuredClone(initial),closed=0
  const host=w.PaperBoardFlow.create({root,canGenerateEqTrace:true,
    async api(action,args) {
      if (action==='board_flow_eqtrace' && generate) return generate(args)
      if (action==='board_flow_save') { saved=structuredClone(args.workspace); saves.push(saved) }
      else assert.equal(action,'board_flow_get')
      return {id:args.id,revision:saves.length,workspace:structuredClone(saved)}
    },toast:(message,error)=>{if(error) errors.push(message)},onClose:()=>{closed++},
  })
  t.after(()=>{host.dispose();w.close()})

  function waitFor(pred, description) {
    if (pred()) return Promise.resolve()
    return new Promise((resolve,reject)=>{
      const observer=new w.MutationObserver(()=>{if(pred()) stop()})
      const timer=setTimeout(()=>stop(Error('No update for '+description+'; '+errors.join('; '))),3500)
      function stop(error){observer.disconnect();clearTimeout(timer);error?reject(error):resolve()}
      observer.observe(doc.body,{childList:true,attributes:true,subtree:true,characterData:true})
    })
  }
  function button(container,text) {
    const result=[...container.querySelectorAll('button')].find(b=>b.textContent === text)
    assert.ok(result,'Missing '+text);return result
  }
  async function toggle(panel, open) {
    doc.getElementById('paper-flow-'+panel+'-toggle').click()
    await waitFor(()=>doc.getElementById('paper-flow-'+panel+'-panel').hidden===!open, panel+' toggle')
    assert.equal(doc.getElementById('paper-flow-'+panel+'-toggle').getAttribute('aria-expanded'),String(open))
    if(open) assert.equal(doc.getElementById('paper-flow-'+(panel==='code'?'compare':'code')+'-panel').hidden,true)
  }
  return {host,doc,w,root,button,waitFor,toggle,events,saves,errors,get closed(){return closed}}
}

test('native toggles dock the actual A/B and input tools; the canvas example leaves a saved workspace draft intact',
  {skip:!JSDOM,timeout:16000}, async t => {
    const original=originalWorkspace(), f=await fixture(t,original)
    assert.equal(await f.host.open({id:'synthetic-board',title:'Synthetic board'}),true)
    await f.waitFor(()=>f.root.querySelector('.paper-flow-controls-toolbar'),'workbench controls')
    assert.deepEqual(f.events.at(-1),{open:true,panel:null})
    const header=f.root.querySelector('.board-flow-header'), canvas=f.root.querySelector('.board-flow-content')
    const compare=f.doc.getElementById('paper-flow-compare-panel'), code=f.doc.getElementById('paper-flow-code-panel')
    assert.ok(header.contains(f.root.querySelector('.paper-flow-controls-toolbar')))
    assert.equal(canvas.contains(f.root.querySelector('.paper-flow-controls-toolbar')),false)
    assert.equal(compare.hidden,true); assert.equal(code.hidden,true)

    await f.toggle('compare',true)
    const sideA=compare.querySelector('select[aria-label="论文与流程 A"]'),sideB=compare.querySelector('select[aria-label="论文与流程 B"]')
    assert.match(sideA.selectedOptions[0].textContent,/Synthetic A/)
    assert.match(sideB.selectedOptions[0].textContent,/Synthetic B/)
    const chooseC=[...sideB.options].find(option=>option.textContent.includes('Synthetic C'))
    sideB.value=chooseC.value
    sideB.dispatchEvent(new f.w.Event('change',{bubbles:true}))
    await f.waitFor(()=>canvas.textContent.includes('Flow C')||f.saves.length,'A/B edit')
    await f.toggle('code',true)
    assert.ok(code.querySelector('.eqtrace-form input[type="file"]'))
    f.button(header,'编码器–解码器示例').click()
    await f.waitFor(()=>code.querySelector('input[accept=".npy"]'),'example data picker')
    assert.ok(canvas.querySelector('.eqtrace-figure-surface svg'))
    assert.equal(f.root.querySelector('[role="dialog"]'),null)
    assert.ok(header.querySelector('.eqtrace-figure-tools button'))
    assert.equal(canvas.querySelector('input[accept=".npy"]'),null)
    const input=code.querySelector('input[aria-label="source 的实际输入文件"]')
    Object.defineProperty(input,'files',{value:[tokenFile()]})
    input.dispatchEvent(new f.w.Event('change',{bubbles:true}))
    await f.waitFor(()=>code.textContent.includes('batch-tokens.npy'),'real example input')
    await f.toggle('code',false)
    assert.deepEqual(f.events.at(-1),{open:true,panel:null})
    await f.toggle('compare',true)
    await f.toggle('code',true)
    assert.match(code.textContent,/batch-tokens\.npy/)
    assert.equal(sideB.selectedOptions[0].textContent,chooseC.textContent)
    f.button(header,'返回原流程').click()
    await f.waitFor(()=>!canvas.querySelector('.eqtrace-main'),'restore original canvas')
    assert.equal(f.doc.querySelector('[role="dialog"]'),null)
    assert.equal(await f.host.close(),true)
    assert.equal(f.closed,1)
    assert.equal(f.root.hidden,true)
    assert.deepEqual(f.events.at(-1),{open:false,panel:null})
    assert.equal(f.doc.querySelector('.paper-flow-native-panels').hidden,true)
    assert.equal(f.saves.at(-1).selection.right.documentId,'C')
    assert.deepEqual(f.saves.at(-1).drafts,original.drafts)
    assert.deepEqual(f.saves.at(-1).documents,original.documents)
    assert.deepEqual(f.errors,[])
  })


test('previewing the inline example on an empty board writes only when explicitly added',
  {skip:!JSDOM,timeout:12000}, async t => {
    const f=await fixture(t,null)
    assert.equal(await f.host.open({id:'empty-board',title:'Synthetic empty board'}),true)
    await f.waitFor(()=>f.root.querySelector('.board-flow-empty'),'empty board')
    const header=f.root.querySelector('.board-flow-header'),canvas=f.root.querySelector('.board-flow-content')
    f.button(header,'编码器–解码器示例').click()
    await f.waitFor(()=>canvas.querySelector('.eqtrace-figure-surface svg'),'embedded example')
    assert.equal(f.root.querySelector('[role="dialog"]'),null)
    f.button(header,'返回原流程').click()
    await f.waitFor(()=>canvas.querySelector('.board-flow-empty'),'return to empty board')
    assert.deepEqual(f.saves,[])
    f.button(header,'编码器–解码器示例').click()
    await f.waitFor(()=>canvas.querySelector('.eqtrace-main'),'explicit add action')
    f.button(header,'将示例加入空画板').click()
    await f.waitFor(()=>!header.textContent.includes('将示例加入空画板'),'example becomes workspace')
    assert.equal(await f.host.close(),true)
    assert.ok(f.saves.at(-1).documents[0].flows.some(flow=>flow.id==='network'))
    assert.deepEqual(f.errors,[])
  })


test('generating from a file kept in the code dock opens the new figure and preserves the original A/B comparison',
  {skip:!JSDOM,timeout:12000}, async t => {
    const document=JSON.parse(await readFile(new URL('../examples/eqtrace-training.json',import.meta.url),'utf8'))
    const requests=[], original=originalWorkspace()
    const f=await fixture(t,original,args=>{requests.push(args);return structuredClone(document)})
    assert.equal(await f.host.open({id:'generation-board',title:'Synthetic generation'}),true)
    await f.waitFor(()=>f.root.querySelector('.paper-flow-controls-toolbar'),'original comparison')
    const header=f.root.querySelector('.board-flow-header'),canvas=f.root.querySelector('.board-flow-content')
    const code=f.doc.getElementById('paper-flow-code-panel'),compare=f.doc.getElementById('paper-flow-compare-panel')
    await f.toggle('code',true)
    const input=code.querySelector('.eqtrace-form').querySelectorAll('input[type="file"]')[1]
    const source='# synthetic model file'
    Object.defineProperty(input,'files',{value:[new File([source],'network.py')]})
    input.dispatchEvent(new f.w.Event('change',{bubbles:true}))
    const submit=f.button(code,'生成流程')
    await f.waitFor(()=>!submit.disabled,'source file selected')
    await f.toggle('compare',true)
    await f.toggle('code',true)
    assert.equal(submit.disabled,false)
    submit.click()

    await f.waitFor(()=>canvas.querySelector('.eqtrace-main .eqtrace-figure-surface svg'),'generated figure on canvas')
    assert.equal(requests.length,1)
    assert.deepEqual([requests[0].id,requests[0].model.name,requests[0].model.text],['generation-board','network.py',source])
    assert.match(header.querySelector('.eqtrace-nav').textContent,new RegExp(document.paper.title))
    assert.equal(code.querySelector('select[aria-label="选择 EqTrace 文档"]').value,document.paper.id)
    assert.equal(f.root.querySelector('[role="dialog"]'),null)
    f.button(header,'返回原流程').click()
    await f.waitFor(()=>!canvas.querySelector('.eqtrace-main'),'original A/B canvas restored')
    await f.toggle('compare',true)
    for(const side of ['A','B']){
      assert.match(compare.querySelector(`select[aria-label="论文与流程 ${side}"]`).selectedOptions[0].textContent,
        new RegExp('Synthetic '+side))
    }
    assert.equal(await f.host.close(),true)
    assert.deepEqual(f.saves.at(-1).selection,original.selection)
    assert.deepEqual(f.saves.at(-1).drafts,original.drafts)
    assert.ok(f.saves.at(-1).documents.some(doc=>doc.paper.id===document.paper.id))
    assert.deepEqual(f.errors,[])
  })

test('an inline example has its own input bindings and restores the saved figure’s all-nodes view',
  {skip:!JSDOM,timeout:12000}, async t => {
    // The example and the persisted document intentionally have identical paper/flow IDs.
    const attention=JSON.parse(await readFile(new URL('../examples/eqtrace-attention.json',import.meta.url),'utf8'))
    const f=await fixture(t,createWorkspace([attention]))
    assert.equal(await f.host.open({id:'saved-network',title:'Saved network'}),true)
    const select=()=>f.root.querySelector('.board-flow-header .eqtrace-projection select')
    await f.waitFor(select,'saved figure controls')
    const header=f.root.querySelector('.board-flow-header'), canvas=f.root.querySelector('.board-flow-content')
    const code=f.doc.getElementById('paper-flow-code-panel')
    const source=()=>code.querySelector('input[aria-label="source 的实际输入文件"]')
    await f.toggle('code',true)
    Object.defineProperty(source(),'files',{value:[tokenFile()]})
    source().dispatchEvent(new f.w.Event('change',{bubbles:true}))
    await f.waitFor(()=>code.textContent.includes('batch-tokens.npy'),'saved figure input')
    select().value='full'
    select().dispatchEvent(new f.w.Event('change',{bubbles:true}))
    const layerId=attention.flows[0].nodes.find(node=>node.config?.attribute==='encoder.attention_norm').id
    const normalizationInVisibleCanvas=()=>canvas.querySelector(`.eqtrace-main:not([hidden]) g[data-node="${layerId}"]`)
    await f.waitFor(normalizationInVisibleCanvas,'all original nodes')

    f.button(header,'编码器–解码器示例').click()
    await f.waitFor(()=>canvas.querySelector('.eqtrace-main[aria-label="编码器–解码器示例"]:not([hidden])')&&select()?.value==='overview','independent example')
    assert.ok(source())
    assert.doesNotMatch(code.textContent,/batch-tokens\.npy/)
    assert.equal(code.querySelector('.eqtrace-data-input button'),null)
    f.button(header,'返回原流程').click()
    await f.waitFor(()=>select()?.value==='full'&&normalizationInVisibleCanvas()&&code.textContent.includes('batch-tokens.npy'),'restore full saved figure and file')
    assert.match(source().closest('.eqtrace-data-input').textContent,/batch-tokens\.npy · 3 × 7/)
    assert.equal(canvas.querySelector('.eqtrace-main[aria-label="编码器–解码器示例"]'),null)
    assert.deepEqual(f.errors,[])
  })
