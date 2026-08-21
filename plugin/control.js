import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_FILE = fileURLToPath(new URL('./dashboard.html', import.meta.url))
const PANEL_PATH = '/dsh-cliapi'
const API_PATH = `${PANEL_PATH}/api`
const PROXY_PATH = `${PANEL_PATH}/v1`
const MAX_JSON_BYTES = 32 * 1024
const MAX_PROXY_BYTES = 24 * 1024 * 1024
const AUTO_PROVIDER = 'dsh-cliapi-auto-native'
const LEGACY_AUTO_PROVIDER = 'dsh-cliapi-auto'
const AUTO_MODEL = 'auto'
export const PROXY_CREDENTIAL_REF = 'DSH_CLIAPI_PROXY_API_KEY'
const RETRYABLE_STATUS = new Set([400, 401, 403, 404, 408, 409, 422, 425, 429, 500, 502, 503, 504])
const OAUTH_ENDPOINTS = Object.freeze({
  codex: 'codex-auth-url',
  claude: 'anthropic-auth-url',
  antigravity: 'antigravity-auth-url',
  kimi: 'kimi-auth-url',
  grok: 'xai-auth-url',
})

export function buildModelEntry(id, name, capabilities = {}) {
  const input = Array.isArray(capabilities.input) && capabilities.input.length > 0
    ? [...capabilities.input]
    : ['text']
  return { id, name, input }
}

export function mergeModelEntry(declared, addition) {
  const index = declared.findIndex(model => model?.id === addition.id)
  if (index < 0) return [...declared, addition]
  const existing = declared[index]
  const merged = { ...addition, ...existing }
  if (!Array.isArray(existing.input) || existing.input.length === 0) merged.input = addition.input
  const sameInput = Array.isArray(existing.input)
    && Array.isArray(merged.input)
    && existing.input.length === merged.input.length
    && existing.input.every((value, inputIndex) => value === merged.input[inputIndex])
  if (existing.name === merged.name && sameInput) return declared
  const next = declared.slice()
  next[index] = merged
  return next
}

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

function normalizeCandidate(value) {
  if (typeof value === 'string') {
    const model = value.trim()
    const provider = routeForModel(model)
    return model === '' || provider === '' ? null : { provider, model }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '' || provider === AUTO_PROVIDER || provider === LEGACY_AUTO_PROVIDER) return null
  return { provider, model }
}

function candidateKey(candidate) {
  return `${candidate.provider}\u0000${candidate.model}`
}

function normalizeAutoConfig(value, defaults) {
  const source = Array.isArray(value?.candidates) ? value.candidates : defaults
  const candidates = []
  const seen = new Set()
  for (const raw of source) {
    const candidate = normalizeCandidate(raw)
    if (candidate === null) continue
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
    if (candidates.length === 12) break
  }
  return {
    enabled: value?.enabled !== false,
    candidates,
    cooldownSeconds: Number.isSafeInteger(value?.cooldownSeconds)
      ? Math.min(600, Math.max(5, value.cooldownSeconds))
      : 60,
  }
}

function commitsCandidate(chunk) {
  return chunk?.type === 'text-delta'
    || chunk?.type === 'reasoning-delta'
    || chunk?.type === 'tool-call-delta'
    || chunk?.type === 'block-end'
}

/**
 * Drop adapter-private replay metadata from any assistant message in the
 * caller-supplied history. Each inner mutation is shallow: the message and
 * its `source` object are copied only when an entry needs trimming, so a
 * history that already carries no replay metadata reuses the originals.
 *
 * pi-ai binds the replay state to the exact provider/model that produced
 * the original assistant turn. The native Auto route records every turn
 * under `dsh-cliapi-auto-native/auto`, so any candidate-owned `replayState`
 * that leaked into history will fail the next call with
 * `invalid pi-ai replay state: provider does not match assistant source`.
 * Removing the metadata here keeps the cross-candidate path safe.
 *
 * @param {readonly unknown[]} messages - the original `messages` array.
 * @returns {unknown[]} a new array safe to forward to a candidate request.
 */
export function stripReplayStateFromHistory(messages) {
  const list = Array.isArray(messages) ? messages : []
  let result = list
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    const source = message?.source
    if (message?.role !== 'assistant' || source?.replayState === undefined) continue
    const copy = { ...message, source: { ...source } }
    delete copy.source.replayState
    if (result === list) result = list.slice()
    result[index] = copy
  }
  return result
}

/**
 * Strip adapter-private replay metadata from a terminal finish chunk so the
 * outer `dsh-cliapi-auto-native/auto` assistant source can never be paired
 * with replay state that belongs to a routed candidate. Non-finish chunks
 * (and finish chunks without `replayState`) are returned unchanged so the
 * caller can pipe them through without an extra allocation.
 *
 * @param {unknown} chunk
 * @returns {unknown}
 */
export function stripReplayStateFromChunk(chunk) {
  if (chunk?.type !== 'finish' || chunk?.replayState === undefined) return chunk
  const { replayState, ...rest } = chunk
  void replayState
  return rest
}

/** Build the native Harness Auto adapter. Exported for the failover test. */
export function createAutoAdapter(ctx, state) {
  return {
    providerInfo(provider) {
      return { id: provider, name: 'DSH_CLIAPI · Auto' }
    },
    providerRetryPolicy() {
      return undefined
    },
    listModels(provider) {
      return Promise.resolve([{
        provider,
        id: AUTO_MODEL,
        name: 'Auto · Harness + CLIProxyAPI',
        description: '按候选顺序在 Harness 与 CLIProxyAPI 模型之间自动故障切换',
      }])
    },
    async resolveModel(provider, model, signal) {
      const contexts = []
      const outputCaps = []
      for (const candidate of state.getConfig().candidates) {
        if (signal?.aborted) break
        try {
          const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model, signal)
          if (info.context?.contextWindow !== undefined) contexts.push(info.context.contextWindow)
          if (info.defaultMaxTokens !== undefined) outputCaps.push(info.defaultMaxTokens)
        } catch {
          // One stale candidate must not hide Auto from the selector. Dispatch
          // will record and skip it if the user actually invokes Auto.
        }
      }
      return {
        provider,
        id: model,
        name: 'Auto · Harness + CLIProxyAPI',
        description: '按候选顺序在 Harness 与 CLIProxyAPI 模型之间自动故障切换',
        ...(contexts.length === 0 ? {} : { context: { contextWindow: Math.min(...contexts) } }),
        ...(outputCaps.length === 0 ? {} : { defaultMaxTokens: Math.min(...outputCaps) }),
      }
    },
    async * stream(options) {
      const config = state.getConfig()
      if (!config.enabled || config.candidates.length === 0) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTO_DISABLED', message: 'DSH_CLIAPI Auto is disabled or has no candidates' } } }
        return
      }
      const now = Date.now()
      const ready = config.candidates.filter(candidate => (state.cooldowns.get(candidateKey(candidate)) ?? 0) <= now)
      const candidates = ready.length > 0 ? ready : config.candidates
      // The history that ships in the agent's outer request may carry
      // replay metadata from a previous turn's candidate provider. Removing
      // it once per call lets every candidate start from a clean slate
      // without leaking candidate-owned replay state back into the outer
      // `dsh-cliapi-auto-native/auto` assistant source.
      const sanitizedMessages = stripReplayStateFromHistory(options?.messages)
      const baseRequest = { ...options, messages: sanitizedMessages }
      const failures = []
      for (const candidate of candidates) {
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'DSH_CLIAPI Auto was aborted' } } }
          return
        }
        const pending = []
        let committed = false
        let failed = null
        try {
          for await (const chunk of ctx.llm.stream({ ...baseRequest, provider: candidate.provider, model: candidate.model })) {
            const sanitized = stripReplayStateFromChunk(chunk)
            if (!committed && sanitized.type === 'finish' && (sanitized.reason.kind === 'error' || sanitized.reason.kind === 'aborted')) {
              if (sanitized.reason.kind === 'aborted' && options.signal?.aborted) {
                yield sanitized
                return
              }
              failed = sanitized.reason.failure
              break
            }
            if (!committed) {
              pending.push(sanitized)
              if (commitsCandidate(sanitized) || sanitized.type === 'finish') {
                committed = true
                state.setLastDispatch({ ...candidate, at: new Date().toISOString(), attempts: failures.length + 1 })
                yield* pending
              }
            } else {
              yield sanitized
            }
          }
        } catch (error) {
          failed = {
            code: typeof error?.code === 'string' ? error.code : 'PROVIDER_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }
        }
        if (committed) return
        const failure = failed ?? { code: 'EMPTY_RESPONSE', message: 'candidate ended without a terminal response' }
        failures.push({ ...candidate, failure })
        state.cooldowns.set(candidateKey(candidate), Date.now() + config.cooldownSeconds * 1000)
      }
      const summary = failures.map(item => `${item.provider}/${item.model} (${item.failure.code})`).join(', ')
      ctx.logger.warn('DSH_CLIAPI Auto exhausted Harness candidates: %s', summary)
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTO_EXHAUSTED', message: `Auto candidates failed: ${summary}` } } }
    },
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
  const capabilityFor = (provider, model) => options.modelCapabilities?.[`${provider}/${model}`] ?? {}
  const defaults = normalizeAutoConfig({ candidates: options.defaultAutoCandidates }, []).candidates
  let dashboardHtml = await readFile(DASHBOARD_FILE, 'utf8')
  let autoConfig
  let storedAutoConfig
  try {
    storedAutoConfig = JSON.parse(await readFile(options.autoConfigPath, 'utf8'))
    autoConfig = normalizeAutoConfig(storedAutoConfig, defaults)
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger.warn(error)
    autoConfig = normalizeAutoConfig(undefined, defaults)
  }
  if (JSON.stringify(storedAutoConfig) !== JSON.stringify(autoConfig)) {
    await writeAutoConfig(options.autoConfigPath, autoConfig)
  }
  const cooldowns = new Map()
  let lastDispatch = null

  const autoState = {
    cooldowns,
    getConfig: () => autoConfig,
    setLastDispatch: value => { lastDispatch = value },
  }
  const disposeAutoAdapter = ctx.llm.registerAdapter([AUTO_PROVIDER], createAutoAdapter(ctx, autoState))

  // v0.3 represented Auto as an llm-pi-ai HTTP route. The settings namespace
  // can register after this inserted plugin, so migrate in the background.
  // A distinct native route prevents either startup order from colliding.
  let stopLegacyMigration = false
  const legacyMigration = (async () => {
    for (let attempt = 0; attempt < 300 && !stopLegacyMigration; attempt += 1) {
      const piSettings = ctx.settings.get('llm-pi-ai')
      if (piSettings !== undefined) {
        if (piSettings?.providers?.[LEGACY_AUTO_PROVIDER] !== undefined) {
          await ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', LEGACY_AUTO_PROVIDER] }])
        }
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const selection = ctx.agentDefaultModel.currentSelection()
    if (selection.provider === LEGACY_AUTO_PROVIDER && selection.model === AUTO_MODEL) {
      await ctx.agentDefaultModel.saveSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })
    }
  })().catch(error => {
    ctx.logger.warn('DSH_CLIAPI could not migrate the v0.3 Auto route: %s', error instanceof Error ? error.message : String(error))
  })

  const updatePiSettings = async (patch) => {
    const descriptor = ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')
    await ctx.settings.update('llm-pi-ai', patch, descriptor?.revision)
  }

  const refreshProviderInputs = (provider, freshModels) => {
    const current = ctx.settings.get('llm-pi-ai')
    const existing = current?.providers?.[provider]
    if (existing === undefined) return false
    const declared = Array.isArray(existing.models) ? existing.models : []
    let merged = declared
    for (const currentModel of declared) {
      const fresh = freshModels.find(entry => entry.id === currentModel?.id)
      if (fresh === undefined) continue
      merged = mergeModelEntry(merged, fresh)
    }
    return merged === declared ? false : merged
  }

  const ensureProviderRoute = async (provider, models, requiredModel) => {
    const current = ctx.settings.get('llm-pi-ai')
    const route = {
      'cliproxy-claude': { displayName: 'DSH_CLIAPI · Claude', api: 'anthropic-messages' },
      'cliproxy-antigravity': { displayName: 'DSH_CLIAPI · Antigravity', api: 'openai-completions' },
      'cliproxy-kimi': { displayName: 'DSH_CLIAPI · Kimi', api: 'openai-completions' },
      'cliproxy-codex': { displayName: 'DSH_CLIAPI · Codex', api: 'openai-completions' },
      'cliproxy-grok': { displayName: 'DSH_CLIAPI · Grok', api: 'openai-completions' },
    }[provider]
    if (route !== undefined) {
      const providerModels = models
        .filter(entry => entry.provider === provider)
        .map(entry => buildModelEntry(entry.id, entry.name, capabilityFor(provider, entry.id)))
      if (providerModels.length === 0) throw new Error(`${route.displayName} models are not available yet`)
      const existing = current?.providers?.[provider]
      if (existing !== undefined) {
        const declared = Array.isArray(existing.models) ? existing.models : []
        let nextModels = refreshProviderInputs(provider, providerModels) || declared
        if (requiredModel !== undefined && !nextModels.some(model => model?.id === requiredModel)) {
          const addition = providerModels.find(model => model.id === requiredModel)
          if (addition === undefined) throw new Error(`${route.displayName} model ${requiredModel} is not available yet`)
          nextModels = mergeModelEntry(nextModels, addition)
        }
        if (existing.apiKeyEnv !== PROXY_CREDENTIAL_REF || nextModels !== declared) {
          await updatePiSettings( {
            providers: {
              [provider]: {
                apiKeyEnv: PROXY_CREDENTIAL_REF,
                ...(nextModels === declared ? {} : { models: nextModels }),
              },
            },
          })
        }
        return
      }
      await updatePiSettings( {
        providers: {
          [provider]: {
            displayName: route.displayName,
            apiKeyEnv: PROXY_CREDENTIAL_REF,
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

  const listCLIProxyModels = async () => {
    const response = await fetch(`${upstreamBase}/v1/models`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
    })
    return sanitizeModels(await responseJson(response)).map(model => ({
      ...model,
      providerName: ({
        'cliproxy-codex': 'DSH_CLIAPI · Codex',
        'cliproxy-claude': 'DSH_CLIAPI · Claude',
        'cliproxy-antigravity': 'DSH_CLIAPI · Antigravity',
        'cliproxy-kimi': 'DSH_CLIAPI · Kimi',
        'cliproxy-grok': 'DSH_CLIAPI · Grok',
      })[model.provider] ?? model.provider,
      source: 'cliproxy',
      input: buildModelEntry(model.id, model.name, capabilityFor(model.provider, model.id)).input,
    }))
  }

  const inputMigration = (async () => {
    for (let attempt = 0; attempt < 300 && !stopLegacyMigration; attempt += 1) {
      if (ctx.settings.get('llm-pi-ai') !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (stopLegacyMigration || ctx.settings.get('llm-pi-ai') === undefined) return
    const models = await listCLIProxyModels()
    for (const provider of new Set(models.map(model => model.provider))) {
      const fresh = models
        .filter(model => model.provider === provider)
        .map(model => buildModelEntry(model.id, model.name, capabilityFor(provider, model.id)))
      const merged = refreshProviderInputs(provider, fresh)
      if (merged === false) continue
      await updatePiSettings( { providers: { [provider]: { models: merged } } })
    }
  })().catch(error => {
    ctx.logger.warn('DSH_CLIAPI could not migrate model input modalities: %s', error instanceof Error ? error.message : String(error))
  })

  const listHarnessModels = async () => {
    const groups = await Promise.all(ctx.llm.listProviders()
      .filter(provider => provider.id !== AUTO_PROVIDER && provider.id !== LEGACY_AUTO_PROVIDER)
      .map(async (provider) => {
        try {
          const models = await ctx.llm.listModels(provider.id)
          return models.map(model => ({
            id: model.id,
            name: model.name,
            provider: provider.id,
            providerName: provider.name,
            source: provider.id.startsWith('cliproxy-') ? 'cliproxy' : 'harness',
          }))
        } catch (error) {
          ctx.logger.warn('DSH_CLIAPI could not list Harness provider %s: %s', provider.id, error instanceof Error ? error.message : String(error))
          return []
        }
      }))
    return groups.flat()
  }

  const listModels = async () => {
    const [harness, cliProxy] = await Promise.all([listHarnessModels(), listCLIProxyModels()])
    const merged = new Map()
    for (const model of [...harness, ...cliProxy]) {
      const key = candidateKey({ provider: model.provider, model: model.id })
      if (!merged.has(key)) merged.set(key, model)
    }
    const sourceRank = { harness: 0, cliproxy: 1 }
    return [...merged.values()].sort((a, b) =>
      sourceRank[a.source] - sourceRank[b.source]
      || a.providerName.localeCompare(b.providerName)
      || a.name.localeCompare(b.name))
  }

  const status = async () => {
    const [authPayload, models] = await Promise.all([managementFetch('/auth-files'), listModels()])
    return {
      ok: true,
      product: 'DSH_CLIAPI',
      version: '0.5.0',
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
        } else {
          const models = await listModels()
          if (!models.some(entry => entry.provider === provider && entry.id === model)) throw new Error('selected model is not currently available')
          if (provider.startsWith('cliproxy-')) {
            await ensureProviderRoute(provider, await listCLIProxyModels(), model)
          }
        }
        await ctx.agentDefaultModel.saveSelection({ provider, model })
        json(res, 200, { ok: true, defaultModel: ctx.agentDefaultModel.currentSelection() })
        return
      }
      if (req.method === 'PUT' && action === '/auto') {
        const body = await readJson(req)
        const models = await listModels()
        const available = new Set(models.map(entry => candidateKey({ provider: entry.provider, model: entry.id })))
        const next = normalizeAutoConfig(body, defaults)
        if (next.candidates.length === 0) throw new Error('Auto needs at least one candidate model')
        if (next.candidates.some(candidate => !available.has(candidateKey(candidate)))) throw new Error('Auto candidate is not currently available')
        const cliProxyModels = await listCLIProxyModels()
        for (const candidate of next.candidates) {
          if (candidate.provider.startsWith('cliproxy-')) {
            await ensureProviderRoute(candidate.provider, cliProxyModels, candidate.model)
          }
        }
        await writeAutoConfig(options.autoConfigPath, next)
        autoConfig = next
        cooldowns.clear()
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
    const cliProxyCandidates = autoConfig.candidates.filter(candidate => candidate.provider.startsWith('cliproxy-'))
    const ready = cliProxyCandidates.filter(candidate => (cooldowns.get(candidateKey(candidate)) ?? 0) <= now)
    const candidates = ready.length > 0 ? ready : cliProxyCandidates
    const failures = []
    for (const candidate of candidates) {
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
          body: JSON.stringify({ ...body, model: candidate.model }),
          signal: controller.signal,
        })
        if (!upstream.ok && RETRYABLE_STATUS.has(upstream.status)) {
          const detail = (await upstream.text()).slice(0, 512)
          failures.push({ ...candidate, status: upstream.status, detail })
          cooldowns.set(candidateKey(candidate), Date.now() + autoConfig.cooldownSeconds * 1000)
          continue
        }
        lastDispatch = { ...candidate, at: new Date().toISOString(), attempts: failures.length + 1 }
        res.statusCode = upstream.status
        copyResponseHeaders(upstream, res, {
          'x-dsh-cliapi-model': candidate.model,
          'x-dsh-cliapi-attempts': String(failures.length + 1),
        })
        await pipeWebBody(upstream, res)
        return
      } catch (error) {
        if (req.destroyed || res.destroyed) return
        failures.push({ ...candidate, status: 0, detail: error instanceof Error ? error.message : String(error) })
        cooldowns.set(candidateKey(candidate), Date.now() + autoConfig.cooldownSeconds * 1000)
      } finally {
        req.off('aborted', abort)
        res.off('close', abort)
      }
    }
    ctx.logger.warn('DSH_CLIAPI legacy HTTP Auto exhausted CLIProxyAPI candidates: %s', JSON.stringify(failures.map(({ provider, model, status }) => ({ provider, model, status }))))
    const detail = failures.length === 0
      ? 'This compatibility endpoint can only dispatch CLIProxyAPI candidates; use Auto inside DeepSeek Harness for native Harness providers.'
      : failures.map(item => `${item.provider}/${item.model} (${String(item.status || 'network')})`).join(', ')
    errorJson(res, 502, `Auto candidates failed: ${detail}`)
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

  return async () => {
    stopLegacyMigration = true
    await Promise.all([legacyMigration, inputMigration])
    disposeProxy()
    disposeApi()
    disposePanel()
    disposeAutoAdapter()
    dashboardHtml = ''
  }
}
