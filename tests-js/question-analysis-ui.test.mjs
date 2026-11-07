import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this._text = ''; this._html = ''; this.classList = { toggle: () => {} } }
  set id(value) { this._id = value; this.document.ids.set(value, this) }
  get id() { return this._id }
  set textContent(value) { this._text = String(value ?? ''); this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set innerHTML(value) {
    this._html = String(value)
    for (const match of this._html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const child = new Element(match[1], this.document); child.id = match[2]; this.children.push(child)
    }
  }
  get innerHTML() { return this._html }
  append(...values) { for (const value of values) this.children.push(typeof value === 'string' ? Object.assign(new Element('#text', this.document), { _text: value }) : value) }
  replaceChildren(...values) { this.children = []; this._text = ''; this.append(...values) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(name, fn) { this.listeners[name] = fn }
}

function documentFixture() {
  const document = { ids: new Map(), hidden: false, listeners: {}, createElement(tag) { return new Element(tag, this) }, getElementById(id) { return this.ids.get(id) }, addEventListener(name, fn) { this.listeners[name] = fn }, removeEventListener(name) { delete this.listeners[name] } }
  document.body = new Element('body', document)
  const tools = new Element('div', document); tools.id = 'paper-tools'; document.body.append(tools)
  return document
}

async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

test('question analysis UI renders partial answers and errors as text, never HTML', async () => {
  const document = documentFixture(), window = {}
  vm.runInNewContext(readFileSync(new URL('../web/paper-analysis.js', import.meta.url), 'utf8'), { window, document, setTimeout, clearTimeout, crypto: { randomUUID: () => 'synthetic' } })
  const malicious = '<img src=x onerror="alert(1)">'
  const job = {
    id: 'synthetic-paper', request_id: 'synthetic-job', status: 'partial', stage: 'partial review',
    question_summary: { answers: 3, valid_answers: 2, invalid_answers: 1 },
    coverage: { read_pages: [1], completed_pages: [1], requested_pages: [1, 2], page_count: 2, characters: 50, full_document: false, blank_pages: [], no_extractable_text_pages: [2] },
    question_coverage: { complete: false, by_question: { q1: { answered_batches: 0, expected_batches: 1, failed_batches: [0], unread_batches: [] } } },
    batch_answers: [{ question_id: 'q1', choice: 'method', valid: false, judgment: malicious,
      evidence: [{ page: 1, quote: malicious }], errors: [{ message: 'Synthetic quote validation failed.' }] },
      { question_id: 'q4_supports', choice: 'supports', valid: true, judgment: '有限练习中的判断理由。',
        target_claim: { page: 1, quote: `Target ${malicious}` }, evidence: [{ page: 2, quote: `Basis ${malicious}` }], errors: [] },
      { question_id: 'q6_reader_check', choice: 'reader_check', valid: true, judgment: '此练习是否包含长篇阅读，需要核查。',
        source_status: 'inferred', evidence: [{ page: 2, quote: 'The exercise used short passages.' }], errors: [] }],
    question_results: [{ question_ids: ['q1', 'q2'], errors: [{ code: 'MODEL_REQUEST_FAILED', message: 'Synthetic group failed.' }] }],
  }
  const ui = window.PaperAnalysis.create({
    state: { active: { id: job.id, pdf: true, title: 'Synthetic paper' } },
    api: async action => action === 'paper_analysis_get' ? job : {},
    persistence: { async get() { return {} }, async patch() {}, async flush() {} },
    toast() {}, prepareChat() {}, openKnowledge() {}, metadataChanged() {},
  })
  await ui.setAvailable(true); await settle()
  const result = document.getElementById('analysis-result')
  assert.match(result.textContent, /问题尚未全部完成/)
  assert.match(result.textContent, /已保存 3 项判断 · 2 项通过原文校验 · 1 项待修正/)
  assert.match(document.getElementById('analysis-status').textContent, /Synthetic group failed/)
  assert.match(result.textContent, /q1：0\/1 批已回答；失败批次 1/)
  assert.match(result.textContent, /引用或格式未通过/)
  assert.match(result.textContent, /Synthetic quote validation failed/)
  assert.match(result.textContent, /Synthetic group failed/)
  assert.match(result.textContent, /被评价主张 · PDF 第 1 页/)
  assert.match(result.textContent, /判断依据 · PDF 第 2 页/)
  assert.ok(result.textContent.includes(`Target ${malicious}`))
  assert.ok(result.textContent.includes(`Basis ${malicious}`))
  assert.match(result.textContent, /读者推断／待核对问题，尚未成为作者报告的事实/)
  assert.ok(result.textContent.includes(malicious), 'untrusted strings appear as literal text')
  const dynamicElements = []
  const walk = element => { dynamicElements.push(element); for (const child of element.children) walk(child) }
  walk(result)
  assert.ok(dynamicElements.every(element => element.innerHTML === ''), 'no answer or error content was assigned through innerHTML')
  ui.dispose()
})

test('graph entry starts explicit full-document analysis and refreshes the drawing from saved batches',async()=>{
  const document=documentFixture(),window={},calls=[],refreshed=[];
  vm.runInNewContext(readFileSync(new URL('../web/paper-analysis.js',import.meta.url),'utf8'),{window,document,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'synthetic-graph'}});
  const state={active:{id:'synthetic-paper',pdf:true,title:'Synthetic'}};
  let job={status:'idle'};
  const ui=window.PaperAnalysis.create({state,api:async(action,args)=>{calls.push({action,...args});if(action==='paper_analysis_start'){job={id:state.active.id,request_id:args.request_id,status:'queued'};}return job;},persistence:{get:async key=>key==='preferences'?{auto_analysis:false}:{pages:'1'},patch:async()=>{},flush:async()=>{}},toast(){},metadataChanged(){},graphChanged:async id=>refreshed.push(id)});
  await ui.setAvailable(true);await settle();document.getElementById('analysis-pages').value='1';await ui.startFullGraph();
  const start=calls.find(c=>c.action==='paper_analysis_start');assert.equal(start.mode,'full');assert.equal(start.pages,undefined);assert.equal(start.apply_metadata,false);assert.equal(start.notes,false);assert.equal(start.review,false);
  job={...job,status:'complete',batch_count:1,draft_id:'synthetic-draft',coverage:{read_pages:[1,2],full_document:true}};
  document.listeners.visibilitychange();await settle();assert.deepEqual(refreshed,['synthetic-paper']);ui.dispose();
});

test('switching papers during graph-start preparation never starts analysis on the new paper',async()=>{
  const document=documentFixture(),window={},calls=[];let release,block=false;
  vm.runInNewContext(readFileSync(new URL('../web/paper-analysis.js',import.meta.url),'utf8'),{window,document,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'synthetic-graph'}});
  const state={active:{id:'a',pdf:true,title:'A'}};
  const ui=window.PaperAnalysis.create({state,api:async(action,args)=>{calls.push({action,...args});if(block&&args.id==='a')await new Promise(resolve=>{release=resolve;});return {status:'idle'};},persistence:{get:async()=>({auto_analysis:false}),patch:async()=>{},flush:async()=>{}},toast(){}});
  await ui.setAvailable(true);await settle();block=true;const start=ui.startFullGraph();await settle();state.active={id:'b',pdf:true,title:'B'};ui.sync();release();await start;await settle();
  assert.equal(calls.filter(c=>c.action==='paper_analysis_start').length,0);ui.dispose();
});

test('stopped analysis exposes an explicit resume action with the saved request identity',async()=>{
  const document=documentFixture(),window={},calls=[];
  vm.runInNewContext(readFileSync(new URL('../web/paper-analysis.js',import.meta.url),'utf8'),{window,document,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'next-run'}});
  const state={active:{id:'paper-a',pdf:true,title:'Synthetic'}};
  const ui=window.PaperAnalysis.create({state,api:async(action,args)=>{calls.push({action,...args});return action==='paper_analysis_resume'?{status:'queued',request_id:'next-run'}:{status:'cancelled',request_id:'old-run',questionnaire:{version:'synthetic'}};},persistence:{get:async()=>({auto_analysis:false}),patch:async()=>{},flush:async()=>{}},toast(){}});
  await ui.setAvailable(true);await settle();
  const button=document.getElementById('analysis-resume');assert.ok(button);button.listeners.click();await settle();
  assert.deepEqual(calls.find(c=>c.action==='paper_analysis_resume'),{action:'paper_analysis_resume',id:'paper-a',request_id:'old-run',new_request_id:'next-run'});
  assert.equal(calls.some(c=>c.action==='paper_analysis_start'),false);ui.dispose();
});
