import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createDirectModelAgent } from '../src/direct-model.mjs'
import { validateAnalysisImages } from '../src/model-input-images.mjs'

function response(payload, status = 200, headers = {}) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers })
}

const glmResult = (content = '{"title":"A paper"}', finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4 },
})
const kimiResult = (text = '{"title":"A paper"}', stop_reason = 'end_turn') => ({
  content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 9, output_tokens: 3 },
})
function pngChunk(type,data) {
  const name=Buffer.from(type), length=Buffer.alloc(4), crc=Buffer.alloc(4); length.writeUInt32BE(data.length)
  const bytes=Buffer.concat([name,data]); crc.writeUInt32BE(crc32(bytes))
  return Buffer.concat([length,bytes,crc])
}
function crc32(bytes) {
  let crc=0xffffffff
  for(const byte of bytes) { crc^=byte; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^(crc&1?0xedb88320:0) }
  return (crc^0xffffffff)>>>0
}
function image(bytes,mime_type,width,height,page=1) { return {mime_type,data:bytes.toString('base64'),page,width,height,sha256:createHash('sha256').update(bytes).digest('hex')} }
function png(width=2,height=3) {
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4); ihdr[8]=8; ihdr[9]=6
  const scanline=Buffer.alloc(height*(1+width*4))
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(scanline)),pngChunk('IEND',Buffer.alloc(0))])
}
function jpeg(width=4,height=5) {
  const sof=Buffer.from([0xff,0xc0,0x00,0x0b,0x08,(height>>8)&255,height&255,(width>>8)&255,width&255,0x01,0x01,0x11,0x00])
  const sos=Buffer.from([0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00])
  return Buffer.concat([Buffer.from([0xff,0xd8]),sof,sos,Buffer.from([0x01,0xff,0xd9])])
}

test('GLM uses fixed OpenAI endpoint, disabled thinking and bounded JSON text', async () => {
  let request
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'GLM_KEY' }, {
    env: { GLM_KEY: 'secret' }, fetchImpl: async (url, init) => { request = { url, init }; return response(glmResult()) },
  })
  assert.equal(await agent({ prompt: 'Return JSON' }), '{"title":"A paper"}')
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.authorization, 'Bearer secret')
  assert.match(request.init.headers['user-agent'], /dsh-paper-library/)
  assert.deepEqual(JSON.parse(request.init.body).thinking, { type: 'disabled' })
  assert.equal(JSON.parse(request.init.body).messages[0].content, 'Return JSON')
  assert.deepEqual(agent.model, { provider: 'glm', model: 'glm-4.7-flash' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: 12, output_tokens: 4, failures: 0 })
})

test('Kimi uses fixed Anthropic endpoint and unwraps only a single answer object', async () => {
  let request
  const agent = await createDirectModelAgent({ provider: 'kimi', model: 'kimi-for-coding', keyEnv: 'KIMI_KEY' }, {
    env: { KIMI_KEY: 'secret' }, fetchImpl: async (url, init) => { request = { url, init }; return response(kimiResult('{"answer":{"title":"A paper"}}')) },
  })
  assert.equal(await agent({ prompt: 'Return JSON' }), '{"title":"A paper"}')
  assert.equal(request.url, 'https://api.kimi.com/coding/v1/messages')
  assert.equal(request.init.headers['x-api-key'], 'secret')
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01')
  assert.equal(JSON.parse(request.init.body).stream, false)
  assert.equal(JSON.parse(request.init.body).messages[0].content, 'Return JSON')
  assert.deepEqual(JSON.parse(request.init.body).thinking, { type: 'disabled' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: 9, output_tokens: 3, failures: 0 })
})

test('explicit thinking modes preserve defaults or serialize enabled reasoning for both APIs', async () => {
  for (const provider of ['glm', 'kimi']) for (const thinking of ['disabled', 'enabled', 'default']) {
    let body
    const agent = await createDirectModelAgent({ provider, model: 'synthetic-model', keyEnv: 'KEY', thinking }, {
      env: { KEY: 'private-key' }, fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body); return response(provider === 'glm' ? glmResult() : kimiResult())
      },
    })
    await agent({ prompt: 'Synthetic JSON' })
    if (thinking === 'default') assert.equal(Object.hasOwn(body, 'thinking'), false)
    else assert.deepEqual(body.thinking, { type: thinking })
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false)
  }
  for (const reasoningEffort of ['low', 'high', 'max']) for (const thinking of ['enabled', 'default']) {
    let body
    const agent = await createDirectModelAgent({ provider: 'glm', model: 'glm-5.3-flash', keyEnv: 'KEY', thinking, reasoningEffort }, {
      env: { KEY: 'private-key' }, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response(glmResult()) },
    })
    await agent({ prompt: 'Synthetic JSON' })
    assert.equal(body.reasoning_effort, reasoningEffort)
  }
})

test('incompatible reasoning fails before credential access or network use', async () => {
  let reads = 0, calls = 0
  const env = new Proxy({}, { get() { reads++; throw new Error('Credential access is forbidden') } })
  const fetchImpl = async () => { calls++; throw new Error('Network use is forbidden') }
  const base = { provider: 'glm', model: 'synthetic-model', keyEnv: 'KEY' }
  for (const change of [{ thinking: null }, { thinking: true }, { thinking: 'automatic' }, { reasoningEffort: 'low' },
    { thinking: 'disabled', reasoningEffort: 'high' }, { thinking: 'default', reasoningEffort: 'medium' }, { thinking: 'enabled', reasoningEffort: null }]) {
    await assert.rejects(createDirectModelAgent({ ...base, ...change }, { env, fetchImpl }), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
  }
  for (const [provider, model] of [['glm', 'glm-5.3-flash'], ['glm', 'glm-5.3-flashx'], ['kimi', 'k3'], ['kimi', 'k3-256k']]) {
    for (const mode of [{}, { thinking: 'disabled' }]) {
      await assert.rejects(createDirectModelAgent({ ...base, provider, model, ...mode }, { env, fetchImpl }), { code: 'DIRECT_MODEL_CONFIG_INVALID' })
    }
    for (const thinking of ['enabled', 'default']) {
      const agent = await createDirectModelAgent({ ...base, provider, model, thinking }, { env: { KEY: 'private-key' }, fetchImpl })
      assert.deepEqual(agent.model, { provider, model })
    }
  }
  assert.equal(reads, 0); assert.equal(calls, 0)
})

test('Kimi discards thinking and redacted thinking blocks while retaining only the final text', async () => {
  const data = { ...kimiResult(), content: [
    { type: 'thinking', thinking: 'private-key and synthetic hidden reasoning', signature: 'synthetic-signature' },
    { type: 'text', text: '{"title":' }, { type: 'redacted_thinking', data: 'synthetic-redacted-data' },
    { type: 'text', text: '"A paper"}' },
  ] }
  const agent = await createDirectModelAgent({ provider: 'kimi', model: 'k3-256k', keyEnv: 'KEY', thinking: 'default' }, {
    env: { KEY: 'private-key' }, fetchImpl: async () => response(data),
  })
  assert.equal(await agent({ prompt: 'Synthetic JSON' }), '{"title":"A paper"}')
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: 9, output_tokens: 3, failures: 0 })
  assert.equal(JSON.stringify({ model: agent.model, usage: agent.usage(), ...agent }).includes('synthetic hidden reasoning'), false)
})

test('Kimi still refuses tool blocks, unknown blocks, truncation and malformed final text', async () => {
  const cases = [
    [{ ...kimiResult(), content: [...kimiResult().content, { type: 'tool_use', name: 'synthetic' }] }, 'DIRECT_MODEL_INCOMPLETE'],
    [{ ...kimiResult(), content: [...kimiResult().content, { type: 'unknown' }] }, 'DIRECT_MODEL_INCOMPLETE'],
    [{ ...kimiResult(), content: [...kimiResult().content, null] }, 'DIRECT_MODEL_INCOMPLETE'],
    [kimiResult('{"title":"A paper"}', 'max_tokens'), 'DIRECT_MODEL_INCOMPLETE'],
    [{ ...kimiResult(), content: [{ type: 'thinking', thinking: 'not a final answer' }] }, 'DIRECT_MODEL_INVALID_OUTPUT'],
    [{ ...kimiResult(), content: [{ type: 'text', text: 7 }] }, 'DIRECT_MODEL_INVALID_OUTPUT'],
  ]
  for (const [data, code] of cases) {
    const agent = await createDirectModelAgent({ provider: 'kimi', model: 'k3', keyEnv: 'KEY', thinking: 'enabled' }, {
      env: { KEY: 'private-key' }, fetchImpl: async () => response(data),
    })
    await assert.rejects(agent({ prompt: 'Synthetic JSON' }), { code })
  }
})

test('explicit env file takes precedence and accepts export/quoted comment syntax', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-model-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '.env')
  await fs.writeFile(file, 'OTHER_KEY=ignored\nexport WANTED=\'only-this\' # selected value\nCOMMAND=$(not-evaluated)\n')
  let authorization
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'WANTED', envFile: file }, {
    env: { WANTED: 'stale-environment-value' }, fetchImpl: async (_url, init) => { authorization = init.headers.authorization; return response(glmResult()) },
  })
  await agent({ prompt: 'ok' })
  assert.equal(authorization, 'Bearer only-this')
})

test('env file rejects duplicate assignments, expansion syntax, whitespace and oversized files', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-model-invalid-env-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '.env')
  for (const contents of [
    'WANTED=one\nexport WANTED=two\n',
    'WANTED=$(command)\n',
    'WANTED=${OTHER}\n',
    'WANTED=two words\n',
  ]) {
    await fs.writeFile(file, contents)
    await assert.rejects(createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'WANTED', envFile: file }, { env: { WANTED: 'must-not-win' }, fetchImpl: async () => response(glmResult()) }), { code: 'DIRECT_MODEL_ENV_FILE_INVALID' })
  }
  await fs.writeFile(file, 'WANTED=x'.padEnd(1024 * 1024 + 1, 'z'))
  await assert.rejects(createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'WANTED', envFile: file }, { env: {}, fetchImpl: async () => response(glmResult()) }), { code: 'DIRECT_MODEL_ENV_FILE_INVALID' })
})

test('effective provider, model and key source cannot change after construction begins', async () => {
  const config = { provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'KEY' }
  let request
  const creating = createDirectModelAgent(config, { env: { KEY: 'original-key' }, fetchImpl: async (url, init) => { request = { url, init }; return response(glmResult()) } })
  config.provider = 'kimi'
  config.model = 'other-model'
  config.keyEnv = 'OTHER_KEY'
  const agent = await creating
  assert.deepEqual(agent.model, { provider: 'glm', model: 'glm-4.7-flash' })
  await agent({ prompt: 'ok' })
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(request.init.headers.authorization, 'Bearer original-key')
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, 'glm-4.7-flash')
  assert.deepEqual(body.response_format, { type: 'json_object' })
})

test('maxCalls is atomic across concurrent calls and every attempt consumes budget', async () => {
  let entered = 0
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K', maxCalls: 2 }, {
    env: { K: 'x' }, fetchImpl: async () => { entered++; await new Promise(resolve => setTimeout(resolve, 5)); return response(glmResult()) },
  })
  const results = await Promise.allSettled([agent({ prompt: '1' }), agent({ prompt: '2' }), agent({ prompt: '3' })])
  assert.equal(entered, 2)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DIRECT_MODEL_BUDGET_EXHAUSTED')
  assert.deepEqual(agent.usage(), { calls: 2, input_tokens: 24, output_tokens: 8, failures: 0 })
})

test('HTTP, redirect, incomplete and malformed output errors are sanitized', async () => {
  for (const [mock, code, status] of [
    [async () => response('private body with secret', 429), 'DIRECT_MODEL_HTTP_ERROR', 429],
    [async () => response('', 302, { location: 'https://elsewhere.invalid' }), 'DIRECT_MODEL_REDIRECT_REFUSED', 302],
    [async () => response(glmResult('{"x":1}', 'length')), 'DIRECT_MODEL_INCOMPLETE', 502],
    [async () => response(glmResult('not json')), 'DIRECT_MODEL_INVALID_OUTPUT', 502],
  ]) {
    const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, { env: { K: 'sensitive-key' }, fetchImpl: mock })
    await assert.rejects(agent({ prompt: 'ok' }), error => error.code === code && error.status === status && !error.message.includes('private') && !error.message.includes('sensitive-key'))
    assert.equal(agent.usage().failures, 1)
  }
})

test('route mismatch and oversized prompts reject before consuming call budget', async () => {
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K', maxCalls: 1 }, { env: { K: 'x' }, fetchImpl: async () => response(glmResult()) })
  await assert.rejects(agent({ prompt: 'ok', model: 'other' }), { code: 'DIRECT_MODEL_ROUTE_MISMATCH' })
  await assert.rejects(agent({ prompt: 'x'.repeat(128 * 1024 + 1) }), { code: 'DIRECT_MODEL_PROMPT_INVALID' })
  assert.equal(agent.usage().calls, 0)
})

test('sends bounded image parts as native GLM data URLs and Kimi Anthropic base64 blocks', async () => {
  const images=[image(png(),'image/png',2,3,2),image(jpeg(),'image/jpeg',4,5,7)]
  for(const provider of ['glm','kimi']) {
    let payload
    const agent=await createDirectModelAgent({provider,model:'vision-model',keyEnv:'KEY'}, {env:{KEY:'synthetic-key'},fetchImpl:async(_url,init)=>{payload=JSON.parse(init.body);return response(provider==='glm'?glmResult():kimiResult())}})
    assert.equal(agent.supportsImages,true)
    assert.equal(await agent({prompt:'Read the figures',images}),'{"title":"A paper"}')
    const content=payload.messages[0].content
    assert.deepEqual(content[0],{type:'text',text:'Read the figures'})
    if(provider==='glm') {
      assert.deepEqual(content.slice(1),images.flatMap(row=>[
        {type:'text',text:`PDF page ${row.page} rendered image:`},
        {type:'image_url',image_url:{url:`data:${row.mime_type};base64,${row.data}`}},
      ]))
    } else {
      assert.deepEqual(content.slice(1),images.flatMap(row=>[
        {type:'text',text:`PDF page ${row.page} rendered image:`},
        {type:'image',source:{type:'base64',media_type:row.mime_type,data:row.data}},
      ]))
    }
  }
  assert.deepEqual(validateAnalysisImages(),[])
  assert.deepEqual(validateAnalysisImages([]),[])
  assert.deepEqual(validateAnalysisImages(images).map(row=>row.page),[2,7])
})

test('explicit empty images preserves legacy text-only payload and duplicate pages are refused', async () => {
  let body, calls=0
  const agent=await createDirectModelAgent({provider:'glm',model:'m',keyEnv:'KEY'}, {env:{KEY:'synthetic-key'},fetchImpl:async(_url,init)=>{calls++;body=JSON.parse(init.body);return response(glmResult())}})
  await agent({prompt:'text only',images:[]})
  assert.equal(body.messages[0].content,'text only')
  const duplicate=[image(png(),'image/png',2,3,4),image(jpeg(),'image/jpeg',4,5,4)]
  await assert.rejects(agent({prompt:'bad pages',images:duplicate}),{code:'DIRECT_MODEL_IMAGES_INVALID'})
  assert.equal(calls,1)
  assert.equal(agent.usage().calls,1)
})

test('rejects malformed, remote, oversized, mismatched and excessive images before budget or network use', async () => {
  let calls=0
  const agent=await createDirectModelAgent({provider:'glm',model:'vision-model',keyEnv:'KEY',maxCalls:1},{env:{KEY:'synthetic-key'},fetchImpl:async()=>{calls++;return response(glmResult())}})
  const valid=image(png(),'image/png',2,3)
  const broken={...valid,data:'https://example.invalid/paper.png'}
  const dataUrl={...valid,data:`data:image/png;base64,${valid.data}`}
  const wrongHash={...valid,sha256:'0'.repeat(64)}
  const wrongDimensions={...valid,width:3}
  const wrongMime={...valid,mime_type:'image/webp'}
  const badPng=image(Buffer.from('not an image'),'image/png',2,3)
  const tooLarge={...valid,data:'A'.repeat(1_398_104)}
  const failures=[broken,dataUrl,wrongHash,wrongDimensions,wrongMime,badPng,tooLarge]
  for(const item of failures) await assert.rejects(agent({prompt:'synthetic',images:[item]}),{code:'DIRECT_MODEL_IMAGES_INVALID'})
  await assert.rejects(agent({prompt:'synthetic',images:[valid,valid,valid]}),{code:'DIRECT_MODEL_IMAGES_INVALID'})
  await assert.rejects(agent({prompt:'synthetic',images:[{...valid,width:1601}]}),{code:'DIRECT_MODEL_IMAGES_INVALID'})
  assert.equal(calls,0)
  assert.equal(agent.usage().calls,0)
  await agent({prompt:'synthetic',images:[valid]})
  assert.equal(calls,1)
  assert.equal(agent.usage().calls,1)
})

test('unknown token usage stays null and tool calls are refused', async () => {
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'x' }, fetchImpl: async () => response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{}] } }] }),
  })
  await assert.rejects(agent({ prompt: 'ok' }), { code: 'DIRECT_MODEL_INCOMPLETE' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: null, output_tokens: null, failures: 1 })
})

test('accepts one JSON code fence, refuses key disclosure, and honors cancellation before success', async () => {
  const fenced = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('```json\n{"title":"A paper"}\n```')),
  })
  assert.equal(await fenced({ prompt: 'ok' }), '{"title":"A paper"}')
  const leak = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('{"title":"private-key"}')),
  })
  await assert.rejects(leak({ prompt: 'ok' }), { code: 'DIRECT_MODEL_OUTPUT_CONTAINS_SECRET' })
  const escapedLeak = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('{"title":"\\u0070rivate-key"}')),
  })
  await assert.rejects(escapedLeak({ prompt: 'ok' }), { code: 'DIRECT_MODEL_OUTPUT_CONTAINS_SECRET' })
  const controller = new AbortController()
  const cancelled = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'x' }, fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return response(glmResult()) },
  })
  const pending = cancelled({ prompt: 'ok', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'DIRECT_MODEL_ABORTED' })
})
