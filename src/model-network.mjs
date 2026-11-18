/** 资料库辅助模型的独立网络通路。只在调用作用域内选路，不切换进程代理环境。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Agent, Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

export const MODEL_NETWORK_DEFAULTS = Object.freeze({
  network_opencode_go: 'proxy', network_deepseek: 'direct', network_glm: 'direct', network_kimi: 'direct', network_proxy_url: '',
})
export const MODEL_NETWORK_PROVIDERS = Object.freeze([
  { id: 'opencode_go', name: 'OpenCode Go', hosts: ['opencode.ai'], url: 'https://opencode.ai/zen/go/v1/models' },
  { id: 'deepseek', name: 'DeepSeek 官方', hosts: ['api.deepseek.com'], url: 'https://api.deepseek.com/anthropic/v1/messages' },
  { id: 'glm', name: 'GLM 官方', hosts: ['open.bigmodel.cn', 'api.z.ai'], url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  { id: 'kimi', name: 'Kimi 官方', hosts: ['api.kimi.com', 'api.moonshot.cn', 'api.moonshot.ai'], url: 'https://api.kimi.com/coding/v1/messages' },
])
const fail = (message, code = 'MODEL_NETWORK_INVALID', status = 400) => Object.assign(new Error(message), { code, status })
export function validateNetworkSetting(key, value) {
  if (key === 'network_proxy_url') {
    if (typeof value !== 'string' || value.length > 500) throw fail('代理地址需要 HTTP 或 HTTPS URL。')
    if (!value) return value
    let url
    try { url = new URL(value) } catch { throw fail('代理地址需要完整 URL，例如 http://127.0.0.1:7890。') }
    if (/[\s\x00-\x1f\x7f]/.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('请填写不含账号、密码或路径的 HTTP／HTTPS 代理地址；SOCKS 和 PAC 不受支持。')
    return value
  }
  if (!Object.hasOwn(MODEL_NETWORK_DEFAULTS, key) || !['direct', 'proxy', 'system'].includes(value)) throw fail('网络请求方式应为直连、代理或跟随 DSH。')
  return value
}

const execute = promisify(execFile)
export async function detectModelProxy({ env = process.env, platform = process.platform, exec = execute } = {}) {
  if (platform === 'darwin') {
    try {
      const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 1500, maxBuffer: 65536 })
      const get = key => stdout.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1].trim()
      for (const scheme of ['HTTPS', 'HTTP']) {
        const host = get(scheme + 'Proxy'), port = get(scheme + 'Port')
        if (get(scheme + 'Enable') !== '1' || !host || !/^\d{1,5}$/.test(port || '')) continue
        const url = validateNetworkSetting('network_proxy_url', `http://${host.includes(':') ? `[${host}]` : host}:${port}`)
        return { url, source: 'macOS 系统代理' }
      }
    } catch { /* 检测不成功也不能把强制代理降为直连。 */ }
  }
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    if (!env[name]?.trim()) continue
    try { return { url: validateNetworkSetting('network_proxy_url', env[name].trim()), source: '环境变量' } }
    catch { return { url: '', source: '环境变量', warning: '环境中的代理格式不受支持，请填写 HTTP／HTTPS 代理地址。' } }
  }
  return { url: '', source: '未检测到代理', warning: '请启动代理并填写 HTTP／HTTPS 监听地址。' }
}

export function modelNetworkProvider(origin) {
  const url = new URL(String(origin))
  if (url.protocol !== 'https:') return undefined
  return MODEL_NETWORK_PROVIDERS.find(provider => provider.hosts.includes(url.hostname))?.id
}

/**
 * 一个稳定的 dispatcher 包装器读取异步调用作用域；并发直连／代理互不串线。
 * 未在 run 中发出的请求和其他域名始终交还原宿主 dispatcher。
 * 凭据、SDK、消息及流协议仍由宿主负责。
 */
export function createModelNetwork({ settings, detectProxy = detectModelProxy, identify = modelNetworkProvider } = {}) {
  const scope = new AsyncLocalStorage(), previous = getGlobalDispatcher()
  const direct = new Agent({ connect: { timeout: 10000 } }), proxies = new Map()
  let disposed = false, detection, detectedAt = 0
  async function snapshot(refresh = false) {
    const record = await settings.get(), value = { ...MODEL_NETWORK_DEFAULTS, ...record.value }
    if (!detection || refresh || Date.now() - detectedAt > 30000) { detection = Promise.resolve().then(detectProxy); detectedAt = Date.now() }
    const proxy = value.network_proxy_url ? { url: value.network_proxy_url, source: '手动配置' } : await detection
    return { value, proxy }
  }
  function dispatcherFor(route, provider) {
    const mode = route.value[`network_${provider}`]
    if (mode === 'system') return previous
    if (mode === 'direct') return direct
    if (!route.proxy.url) throw fail('此服务已设为代理，但没有可用的 HTTP／HTTPS 代理地址。请在设置 → 模型、网络与存储 → 模型网络中配置。', 'MODEL_PROXY_REQUIRED', 503)
    if (!proxies.has(route.proxy.url)) {
      proxies.set(route.proxy.url, new ProxyAgent({ uri: route.proxy.url, connect: { timeout: 10000 } }))
      if (proxies.size > 8) {
        const [key, old] = proxies.entries().next().value
        proxies.delete(key); void old.close().catch(() => {})
      }
    }
    return proxies.get(route.proxy.url)
  }
  class ScopedDispatcher extends Dispatcher {
    dispatch(options, handler) {
      const route = scope.getStore(), provider = identify(options.origin)
      return (route && provider ? dispatcherFor(route, provider) : previous).dispatch(options, handler)
    }
  }
  const router = new ScopedDispatcher()
  setGlobalDispatcher(router)
  async function run(callback) {
    if (disposed) throw fail('模型网络服务已关闭，请重新打开资料库。', 'MODEL_NETWORK_CLOSED', 503)
    const route = await snapshot()
    return scope.run(route, callback)
  }
  async function describe() {
    const { value, proxy } = await snapshot(true)
    return { available: !disposed, proxy_url: proxy.url, proxy_source: proxy.source, warning: proxy.warning || '',
      providers: MODEL_NETWORK_PROVIDERS.map(({ id, name, hosts }) => ({ id, name, hosts, mode: value[`network_${id}`] })) }
  }
  async function probe(id, signal) {
    const provider = MODEL_NETWORK_PROVIDERS.find(item => item.id === id)
    if (!provider) throw fail('未知模型服务。')
    const route = await snapshot(true), mode = route.value[`network_${id}`], started = Date.now()
    // 固定公开地址、无 API key、无用户文献内容；HTTP 回应仅证明链路，不证明鉴权或模型生成。
    try {
      const response = await scope.run(route, () => fetch(provider.url, { redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]) }))
      await response.body?.cancel()
      return { provider: id, mode, reachable: true, http_status: response.status, elapsed_ms: Date.now() - started,
        message: `已收到 HTTP ${response.status} 响应；连接可达，尚未验证密钥与模型生成。` }
    } catch (error) {
      signal?.throwIfAborted()
      const code = error?.cause?.code || error?.code
      const detail = code === 'ECONNREFUSED' ? '连接被拒绝，请检查代理是否启动及端口是否正确。'
        : error?.name === 'TimeoutError' || /TIMEOUT/.test(code || '') ? '连接超时，请检查当前网络、DNS 与代理。'
        : /ENOTFOUND|EAI_AGAIN/.test(code || '') ? '域名解析失败，请检查当前 DNS。'
        : code === 'MODEL_PROXY_REQUIRED' ? (error.cause?.message || error.message) : '连接失败，请检查网络与代理服务。'
      return { provider: id, mode, reachable: false, elapsed_ms: Date.now() - started, message: detail }
    }
  }
  return { run, describe, probe, async dispose() {
    if (disposed) return
    disposed = true
    if (getGlobalDispatcher() === router) setGlobalDispatcher(previous)
    await Promise.allSettled([direct.close(), ...Array.from(proxies.values(), proxy => proxy.close())])
  } }
}
