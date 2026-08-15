import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_FILE = fileURLToPath(new URL('./dashboard.html', import.meta.url))
const PANEL_PATH = '/dsh-cliapi'
const API_PATH = `${PANEL_PATH}/api`
const PROXY_PATH = `${PANEL_PATH}/v1`
const MAX_JSON_BYTES = 32 * 1024
const MAX_PROXY_BYTES = 24 * 1024 * 1024
const AUTO_PROVIDER = 'dsh-cliapi-auto'
const AUTO_MODEL = 'auto'
const RETRYABLE_STATUS = new Set([400, 401, 403, 404, 408, 409, 422, 425, 429, 500, 502, 503, 504])
const OAUTH_ENDPOINTS = Object.freeze({
  codex: 'codex-auth-url',
  claude: 'anthropic-auth-url',
  antigravity: 'antigravity-auth-url',
  kimi: 'kimi-auth-url',
  grok: 'xai-auth-url',
})

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function errorJson(res, status, message) {
  json(res, status, { ok: false, error: message })
}

function loopbackRequest(req) {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function trustedHost(req) {
  const raw = String(req.headers.host ?? '')
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function trustedMutation(req) {
  if (!loopbackRequest(req) || !trustedHost(req)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
      && parsed.host === req.headers.host
  } catch {
    return false
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) throw new Error('request body is too large')
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  const body = await readBody(req, limit)
  if (body.length === 0) return {}
  const value = JSON.parse(body.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body must be an object')
  }
  return value
}

async function responseJson(response, maxBytes = 4 * 1024 * 1024) {
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error('upstream response is too large')
  let value
  try {
    value = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error(`upstream returned invalid JSON (HTTP ${String(response.status)})`)
  }
  if (!response.ok) {
    const detail = typeof value?.error === 'string'
      ? value.error
      : typeof value?.error?.message === 'string'
        ? value.error.message
        : `HTTP ${String(response.status)}`
    throw new Error(detail)
  }
  return value
}

function publicProvider(raw) {
  const provider = String(raw ?? '').trim().toLowerCase()
  if (provider === 'codex' || provider === 'openai') return 'codex'
  if (provider === 'claude' || provider === 'anthropic') return 'claude'
  if (provider === 'antigravity' || provider === 'anti-gravity') return 'antigravity'
  if (provider === 'kimi' || provider === 'moonshot') return 'kimi'
  if (provider === 'xai' || provider === 'grok') return 'grok'
  return provider || 'unknown'
}

function routeForModel(model, ownedBy = '') {
  const id = String(model).toLowerCase()
  const owner = String(ownedBy).toLowerCase()
  if (id.startsWith('grok-') || owner === 'xai') return 'cliproxy-grok'
  if (id.startsWith('gemini-') || owner === 'gemini' || owner === 'antigravity') return 'cliproxy-antigravity'
  if (id.startsWith('kimi-') || owner === 'kimi' || owner === 'moonshot') return 'cliproxy-kimi'
  if (id.startsWith('claude-') || owner === 'anthropic') return 'cliproxy-claude'
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || owner === 'openai') return 'cliproxy-codex'
  return ''
}

function sanitizeAuthFiles(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : []
  return files.map((entry) => ({
    provider: publicProvider(entry?.provider ?? entry?.type),
    label: String(entry?.email ?? entry?.label ?? entry?.account ?? '已授权账号'),
    status: String(entry?.status ?? (entry?.disabled ? 'disabled' : 'active')),
    disabled: entry?.disabled === true,
    unavailable: entry?.unavailable === true,
  })).filter(entry => ['codex', 'claude', 'antigravity', 'kimi', 'grok'].includes(entry.provider))
}

function sanitizeModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    if (/(?:^|[-_/])(image|video|imagine)(?:[-_/]|$)/i.test(id)) continue
    const ownedBy = typeof row?.owned_by === 'string' ? row.owned_by.trim() : ''
    const provider = routeForModel(id, ownedBy)
    if (provider === '') continue
    seen.add(id)
    models.push({ id, name: id, provider, ownedBy })
  }
  return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
}

function normalizeAutoConfig(value, defaults) {
  const candidates = Array.isArray(value?.candidates)
    ? [...new Set(value.candidates.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 8)
    : defaults
  return {
    enabled: value?.enabled !== false,
    candidates,
    cooldownSeconds: Number.isSafeInteger(value?.cooldownSeconds)
      ? Math.min(600, Math.max(5, value.cooldownSeconds))
      : 60,
  }
}

async function writeAutoConfig(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temp, path)
  await chmod(path, 0o600)
}

function authHeaderMatches(req, apiKey) {
  return String(req.headers.authorization ?? '') === `Bearer ${apiKey}`
}

function safeState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{8,256}$/.test(value)
}

function copyResponseHeaders(upstream, res, extra = {}) {
  const omitted = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade'])
  for (const [key, value] of upstream.headers) {
    if (!omitted.has(key.toLowerCase())) res.setHeader(key, value)
  }
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value)
}

async function pipeWebBody(upstream, res) {
  if (upstream.body === null) {
    res.end()
    return
  }
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once('drain', resolve))
    }
    res.end()
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function registerControlPlane(ctx, options) {
  const upstreamBase = `http://${options.host}:${String(options.port)}`
  const managementBase = `${upstreamBase}/v0/management`
  const defaults = [...new Set(options.defaultAutoCandidates)].slice(0, 8)
  let dashboardHtml = await readFile(DASHBOARD_FILE, 'utf8')
  let autoConfig
  try {
    autoConfig = normalizeAutoConfig(JSON.parse(await readFile(options.autoConfigPath, 'utf8')), defaults)
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger.warn(error)
    autoConfig = normalizeAutoConfig(undefined, defaults)
    await writeAutoConfig(options.autoConfigPath, autoConfig)
  }
  const cooldowns = new Map()
  let lastDispatch = null

  const ensureProviderRoute = async (provider, models) => {
    const current = ctx.settings.get('llm-pi-ai')
    if (current?.providers?.[provider] !== undefined) return
    if (provider === AUTO_PROVIDER) {
      await ctx.settings.update('llm-pi-ai', {
        providers: {
          [AUTO_PROVIDER]: {
            displayName: 'DSH_CLIAPI · Auto',
            apiKeyEnv: 'CLIPROXY_API_KEY',
            api: 'openai-completions',
            baseURL: `http://${ctx.webServer.host}:${String(ctx.webServer.port)}${PROXY_PATH}`,
            models: [{ id: AUTO_MODEL, name: 'Auto · 自动故障切换', contextWindow: 200000, maxTokens: 32768 }],
          },
        },
      })
      return
    }
    const route = {
      'cliproxy-claude': { displayName: 'DSH_CLIAPI · Claude', api: 'anthropic-messages' },
      'cliproxy-antigravity': { displayName: 'DSH_CLIAPI · Antigravity', api: 'openai-completions' },
      'cliproxy-kimi': { displayName: 'DSH_CLIAPI · Kimi', api: 'openai-completions' },
      'cliproxy-codex': { displayName: 'DSH_CLIAPI · Codex', api: 'openai-completions' },
      'cliproxy-grok': { displayName: 'DSH_CLIAPI · Grok', api: 'openai-completions' },
    }[provider]
    if (route !== undefined) {
      const providerModels = models.filter(entry => entry.provider === provider).map(entry => ({ id: entry.id, name: entry.name }))
      if (providerModels.length === 0) throw new Error(`${route.displayName} models are not available yet`)
      await ctx.settings.update('llm-pi-ai', {
        providers: {
          [provider]: {
            displayName: route.displayName,
            apiKeyEnv: 'CLIPROXY_API_KEY',
            api: route.api,
            baseURL: upstreamBase,
            models: providerModels,
          },
        },
      })
      return
    }
    throw new Error('unsupported DSH_CLIAPI provider route')
  }

  const managementFetch = async (path, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(`${managementBase}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.managementKey}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      })
      return await responseJson(response)
    } finally {
      clearTimeout(timer)
    }
  }

  const listModels = async () => {
    const response = await fetch(`${upstreamBase}/v1/models`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
    })
    const models = sanitizeModels(await responseJson(response))
    return models
  }

  const status = async () => {
    const [authPayload, models] = await Promise.all([managementFetch('/auth-files'), listModels()])
    return {
      ok: true,
      product: 'DSH_CLIAPI',
      version: '0.3.0',
      accounts: sanitizeAuthFiles(authPayload),
      models,
      defaultModel: ctx.agentDefaultModel.currentSelection(),
      auto: { ...autoConfig, provider: AUTO_PROVIDER, model: AUTO_MODEL, lastDispatch },
      providers: [
        { id: 'codex', name: 'Codex', supported: true },
        { id: 'claude', name: 'Claude', supported: true },
        { id: 'antigravity', name: 'Antigravity', supported: true },
        { id: 'kimi', name: 'Kimi', supported: true },
        { id: 'grok', name: 'Grok / xAI', supported: true },
        { id: 'cursor', name: 'Cursor', supported: false, note: 'Cursor 是客户端；可把 DSH_CLIAPI 地址配置给 Cursor，但 CLIProxyAPI 当前没有 Cursor OAuth 导入器。' },
      ],
    }
  }

  const handleApi = async (req, res) => {
    if (!loopbackRequest(req) || !trustedHost(req)) {
      errorJson(res, 403, 'loopback access only')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(API_PATH.length)
    try {
      if (req.method === 'GET' && action === '/status') {
        json(res, 200, await status())
        return
      }
      if (!trustedMutation(req)) {
        errorJson(res, 403, 'untrusted mutation origin')
        return
      }
      if (req.method === 'POST' && action === '/oauth/start') {
        const body = await readJson(req)
        const provider = String(body.provider ?? '')
        const endpoint = OAUTH_ENDPOINTS[provider]
        if (endpoint === undefined) {
          errorJson(res, 400, 'unsupported OAuth provider')
          return
        }
        const payload = await managementFetch(`/${endpoint}?is_webui=true`)
        const authUrl = typeof payload?.url === 'string' ? payload.url : ''
        const protocol = authUrl === '' ? '' : new URL(authUrl).protocol
        if (protocol !== 'https:' && protocol !== 'http:') throw new Error('provider returned an unsafe authorization URL')
        json(res, 200, {
          ok: true,
          provider,
          url: authUrl,
          state: payload.state,
          flow: payload.flow ?? 'browser',
          userCode: payload.user_code,
          expiresIn: payload.expires_in,
        })
        return
      }
      if (req.method === 'GET' && action === '/oauth/status') {
        const state = url.searchParams.get('state')
        if (!safeState(state)) {
          errorJson(res, 400, 'invalid OAuth state')
          return
        }
        const payload = await managementFetch(`/get-auth-status?state=${encodeURIComponent(state)}`)
        json(res, 200, { ok: true, status: payload.status, error: payload.error })
        return
      }
      if (req.method === 'POST' && action === '/oauth/cancel') {
        const body = await readJson(req)
        if (!safeState(body.state)) {
          errorJson(res, 400, 'invalid OAuth state')
          return
        }
        await managementFetch(`/oauth-session?state=${encodeURIComponent(body.state)}`, { method: 'DELETE' })
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'POST' && action === '/default-model') {
        const body = await readJson(req)
        const provider = String(body.provider ?? '')
        const model = String(body.model ?? '')
        if (provider === AUTO_PROVIDER && model === AUTO_MODEL) {
          if (!autoConfig.enabled || autoConfig.candidates.length === 0) throw new Error('Auto must be enabled with at least one candidate')
          await ensureProviderRoute(AUTO_PROVIDER, [])
        } else {
          const models = await listModels()
          if (!models.some(entry => entry.provider === provider && entry.id === model)) throw new Error('selected model is not currently available')
          await ensureProviderRoute(provider, models)
        }
        await ctx.agentDefaultModel.saveSelection({ provider, model })
        json(res, 200, { ok: true, defaultModel: ctx.agentDefaultModel.currentSelection() })
        return
      }
      if (req.method === 'PUT' && action === '/auto') {
        const body = await readJson(req)
        const models = await listModels()
        const available = new Set(models.map(entry => entry.id))
        const next = normalizeAutoConfig(body, defaults)
        if (next.candidates.length === 0) throw new Error('Auto needs at least one candidate model')
        if (next.candidates.some(model => !available.has(model))) throw new Error('Auto candidate is not currently available')
        await writeAutoConfig(options.autoConfigPath, next)
        autoConfig = next
        cooldowns.clear()
        await ensureProviderRoute(AUTO_PROVIDER, [])
        json(res, 200, { ok: true, auto: autoConfig })
        return
      }
      errorJson(res, 404, 'unknown DSH_CLIAPI API route')
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      errorJson(res, 400, error instanceof Error ? error.message : String(error))
    }
  }

  const handleProxy = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(PROXY_PATH.length)
    if (!loopbackRequest(req) || !authHeaderMatches(req, options.apiKey)) {
      errorJson(res, 401, 'invalid DSH_CLIAPI key')
      return
    }
    if (req.method === 'GET' && action === '/models') {
      json(res, 200, { object: 'list', data: [{ id: AUTO_MODEL, object: 'model', owned_by: 'dsh-cliapi' }] })
      return
    }
    if (req.method !== 'POST' || action !== '/chat/completions') {
      errorJson(res, 404, 'Auto currently serves OpenAI chat completions')
      return
    }
    if (!autoConfig.enabled || autoConfig.candidates.length === 0) {
      errorJson(res, 503, 'DSH_CLIAPI Auto is disabled or has no candidates')
      return
    }
    let body
    try {
      body = JSON.parse((await readBody(req, MAX_PROXY_BYTES)).toString('utf8'))
    } catch (error) {
      errorJson(res, 400, error instanceof Error ? error.message : 'invalid request body')
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      errorJson(res, 400, 'JSON body must be an object')
      return
    }
    const now = Date.now()
    const ready = autoConfig.candidates.filter(model => (cooldowns.get(model) ?? 0) <= now)
    const candidates = ready.length > 0 ? ready : autoConfig.candidates
    const failures = []
    for (const model of candidates) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      req.once('aborted', abort)
      res.once('close', abort)
      try {
        const upstream = await fetch(`${upstreamBase}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            accept: String(req.headers.accept ?? 'application/json'),
            'x-dsh-cliapi-auto': '1',
          },
          body: JSON.stringify({ ...body, model }),
          signal: controller.signal,
        })
        if (!upstream.ok && RETRYABLE_STATUS.has(upstream.status)) {
          const detail = (await upstream.text()).slice(0, 512)
          failures.push({ model, status: upstream.status, detail })
          cooldowns.set(model, Date.now() + autoConfig.cooldownSeconds * 1000)
          continue
        }
        lastDispatch = { model, at: new Date().toISOString(), attempts: failures.length + 1 }
        res.statusCode = upstream.status
        copyResponseHeaders(upstream, res, {
          'x-dsh-cliapi-model': model,
          'x-dsh-cliapi-attempts': String(failures.length + 1),
        })
        await pipeWebBody(upstream, res)
        return
      } catch (error) {
        if (req.destroyed || res.destroyed) return
        failures.push({ model, status: 0, detail: error instanceof Error ? error.message : String(error) })
        cooldowns.set(model, Date.now() + autoConfig.cooldownSeconds * 1000)
      } finally {
        req.off('aborted', abort)
        res.off('close', abort)
      }
    }
    ctx.logger.warn('DSH_CLIAPI Auto exhausted candidates: %s', JSON.stringify(failures.map(({ model, status }) => ({ model, status }))))
    errorJson(res, 502, `Auto candidates failed: ${failures.map(item => `${item.model} (${String(item.status || 'network')})`).join(', ')}`)
  }

  const handlePanel = (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(dashboardHtml),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
    })
    res.end(dashboardHtml)
  }

  const disposePanel = ctx.webServer.register({ kind: 'exact', path: PANEL_PATH, handler: handlePanel })
  const disposeApi = ctx.webServer.register({ kind: 'prefix', path: API_PATH, handler: handleApi })
  const disposeProxy = ctx.webServer.register({ kind: 'prefix', path: PROXY_PATH, handler: handleProxy })
  const disposeEntry = ctx.webServer.tapIndex((html) => {
    if (html.includes('data-dsh-cliapi-entry')) return html
    const entry = '<a data-dsh-cliapi-entry href="/dsh-cliapi" target="_blank" rel="noopener" title="配置授权、默认模型和 Auto 调度" style="position:fixed;right:18px;bottom:18px;z-index:2147483640;padding:9px 13px;border-radius:12px;background:#111827;color:#fff;text-decoration:none;font:600 13px/1.2 system-ui;box-shadow:0 8px 28px #0004">DSH_CLIAPI</a>'
    return html.includes('</body>') ? html.replace('</body>', `${entry}</body>`) : `${html}${entry}`
  })

  return async () => {
    disposeEntry()
    disposeProxy()
    disposeApi()
    disposePanel()
    dashboardHtml = ''
  }
}
