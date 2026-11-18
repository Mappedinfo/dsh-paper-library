import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { createModelNetwork, detectModelProxy, modelNetworkProvider, MODEL_NETWORK_DEFAULTS, validateNetworkSetting } from '../src/model-network.mjs'
import { createHarnessAI } from '../src/harness/ai.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
async function fixture(t, hostProxy = false) {
  const sockets = new Set(), seen = []
  const origin = createServer((req, res) => { res.end('synthetic reply') })
  const proxy = createServer((req, res) => {
    seen.push(req.url)
    const upstream = request(req.url,{method:req.method,headers:req.headers}, response => { res.writeHead(response.statusCode,response.headers);response.pipe(res) })
    upstream.on('error',()=>res.destroy());req.pipe(upstream)
  })
  proxy.on('connect', (req, socket, head) => {
    seen.push(req.url)
    const [host, port] = req.url.split(':')
    const upstream = connect(Number(port), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
    sockets.add(socket); sockets.add(upstream)
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
  })
  const url = await listen(origin), proxyURL = await listen(proxy)
  let value = { ...MODEL_NETWORK_DEFAULTS, network_proxy_url: proxyURL }
  const previous = getGlobalDispatcher(), fallback = hostProxy ? new ProxyAgent(proxyURL) : new Agent()
  setGlobalDispatcher(fallback)
  const network = createModelNetwork({ settings: { get: async () => ({ value: { ...value } }) }, identify: actual => String(actual) === url ? 'deepseek' : undefined })
  t.after(async () => {
    await network.dispose(); setGlobalDispatcher(previous); await fallback.close()
    for (const socket of sockets) socket.destroy()
    origin.closeAllConnections(); proxy.closeAllConnections()
    await Promise.all([new Promise(resolve => origin.close(resolve)), new Promise(resolve => proxy.close(resolve))])
  })
  return { url, proxyURL, seen, network, fallback, set: patch => { value = { ...value, ...patch } } }
}

test('official APIs are matched by exact HTTPS destination, including Go models named DeepSeek/GLM/Kimi', () => {
  assert.equal(modelNetworkProvider('https://opencode.ai'), 'opencode_go')
  assert.equal(modelNetworkProvider('https://api.deepseek.com'), 'deepseek')
  assert.equal(modelNetworkProvider('https://api.kimi.com'), 'kimi')
  assert.equal(modelNetworkProvider('https://open.bigmodel.cn'), 'glm')
  assert.equal(modelNetworkProvider('https://api.z.ai'), 'glm')
  for (const origin of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://other.test']) assert.equal(modelNetworkProvider(origin), undefined)
})

test('concurrent direct/proxy calls remain isolated; saved changes affect new calls only and host is restored', async t => {
  const f = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.set({ network_deepseek: 'proxy' })
  const viaProxy = f.network.run(async () => { await gate; return (await fetch(f.url)).text() })
  await new Promise(resolve => setImmediate(resolve))
  f.set({ network_deepseek: 'direct' })
  const viaDirect = f.network.run(async () => { release(); return (await fetch(f.url)).text() })
  assert.deepEqual(await Promise.all([viaProxy, viaDirect]), ['synthetic reply', 'synthetic reply'])
  assert.equal(f.seen.length, 1)
  // Unscoped host calls stay on their pre-existing dispatcher.
  await (await fetch(f.url)).text(); assert.equal(f.seen.length, 1)
  f.set({ network_deepseek: 'system' })
  await f.network.run(async () => (await fetch(f.url)).text()); assert.equal(f.seen.length, 1)
  await f.network.dispose(); assert.equal(getGlobalDispatcher(), f.fallback)
  await assert.rejects(f.network.run(() => fetch(f.url)), { code: 'MODEL_NETWORK_CLOSED' })
})

test('real host feedback collection executes transport inside the selected scope', async t => {
  const f = await fixture(t); f.set({ network_deepseek: 'proxy' })
  const llm = { resolveModelInfo: async () => ({}), async *stream() {
    const text = await (await fetch(f.url)).text()
    yield { type: 'block-end', block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const ai = createHarnessAI(llm, input => input, { provider: 'fixture', model: 'synthetic' }, { network: f.network })
  assert.equal(await ai({ prompt: 'synthetic test only' }), 'synthetic reply'); assert.equal(f.seen.length, 1)
})

test('forced proxy never silently falls back to direct if missing; direct still works', async t => {
  const f = await fixture(t)
  // Replace detection by a separate router; no ambient proxy state is changed.
  const network = createModelNetwork({ settings: { get: async () => ({ value: { network_deepseek: 'proxy' } }) }, detectProxy: async () => ({url:'',source:'missing'}), identify: () => 'deepseek' })
  try { await assert.rejects(network.run(() => fetch(f.url)), error => error.cause?.code === 'MODEL_PROXY_REQUIRED' || error.code === 'MODEL_PROXY_REQUIRED') }
  finally { await network.dispose() }
  assert.equal(f.seen.length, 0)
  f.set({network_deepseek:'direct'}); assert.equal(await f.network.run(async ()=>(await fetch(f.url)).text()),'synthetic reply')
})

test('proxy detection honors explicit environment and macOS HTTP setting without printing credentials', async () => {
  assert.deepEqual(await detectModelProxy({ env: {HTTPS_PROXY:'http://127.0.0.1:9999'},platform:'linux' }),{url:'http://127.0.0.1:9999',source:'环境变量'})
  assert.equal((await detectModelProxy({env:{HTTPS_PROXY:'socks5://127.0.0.1:9999'},platform:'linux'})).url,'')
  assert.deepEqual(await detectModelProxy({env:{},platform:'darwin',exec:async()=>({stdout:'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 12450\n'})}),{url:'http://127.0.0.1:12450',source:'macOS 系统代理'})
  for(const value of ['socks5://127.0.0.1:9999','http://user:password@proxy.test','http://proxy.test/path','http://proxy.test?key=secret','http://proxy.test/#secret','x',null]) assert.throws(()=>validateNetworkSetting('network_proxy_url',value))
  assert.throws(()=>validateNetworkSetting('network_deepseek','automatic'))
})

test('macOS current proxy takes precedence over an inherited proxy from an older VPN',async()=>{
  const result=await detectModelProxy({env:{HTTPS_PROXY:'http://127.0.0.1:7897'},platform:'darwin',exec:async()=>({stdout:'HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 12450\n'})})
  assert.equal(result.url,'http://127.0.0.1:12450');assert.equal(result.source,'macOS 系统代理')
})


test('direct mode bypasses the host proxy while unrelated host calls keep using it',async t=>{
 const f=await fixture(t,true);f.set({network_deepseek:'direct'});
 assert.equal(await f.network.run(async ()=>(await fetch(f.url)).text()),'synthetic reply');assert.equal(f.seen.length,0);
 assert.equal(await(await fetch(f.url)).text(),'synthetic reply');assert.equal(f.seen.length,1);
});
