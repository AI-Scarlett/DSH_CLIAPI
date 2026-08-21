import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installInterceptor } from './llm-adapter.js'
import { AUTO_PROVIDER, LANES, looksLikeGenerator, suggestLane } from './llm-classify.js'

export const PLUGIN_VERSION = '0.5.1'

export function migrateDefaultSelection(selection, config) {
  if (selection?.provider !== AUTO_PROVIDER) return null
  const first = config?.lanes?.text?.[0]
  if (!first?.provider || !first?.model) return null
  return { provider: first.provider, model: first.model }
}

const DASHBOARD_FILE = fileURLToPath(new URL('./llm-dashboard.html', import.meta.url))
const PANEL_PATH = '/dshllm-api'
const API_PATH = `${PANEL_PATH}/api`
const MAX_JSON_BYTES = 32 * 1024
const CLIAPI_AUTO = new Set(['dsh-cliapi-auto-native', 'dsh-cliapi-auto'])

/**
 * True when the existing entry has an explicit, non-empty `input` array that
 * the user intentionally set. The harness treats `[]` exactly like an absent
 * field (it resolves to "inherit the route default"), so the plugin can
 * safely overwrite an empty array — that is the bug being fixed.
 */
function hasUserInputOverride(existing) {
  return Array.isArray(existing?.input) && existing.input.length > 0
}

/**
 * Build the `llm-pi-ai` `models` entry that the harness should register for a
 * catalog model id. Generators (image / video / audio / tts) only consume a
 * text prompt, so we declare `input: ['text']` to match the upstream. Chat
 * and reasoning models are assumed multimodal; the harness then lets the
 * fallback chat model accept an attached screenshot when the dedicated
 * media-lane model rejects it.
 */
export function buildModelEntry(id, name, lane = 'text') {
  return {
    id,
    name,
    input: looksLikeGenerator(id) || lane !== 'image' ? ['text'] : ['text', 'image'],
  }
}

/**
 * Merge one freshly-discovered model into an existing `models` list while
 * preserving any fields the user has already pinned for the same id (e.g. a
 * custom `input` array or `compat` overrides). Returns a new array so the
 * original `declared` slice stays untouched; this also avoids mutating the
 * frozen objects that the harness stores.
 */
export function mergeModelEntry(declared, addition) {
  const index = declared.findIndex(model => model?.id === addition.id)
  if (index < 0) return [...declared, addition]
  const existing = declared[index]
  const merged = { ...addition, ...existing }
  // Preserve every existing model-level field. Only fill an absent/empty
  // modality declaration; a non-empty declaration always wins.
  if (!hasUserInputOverride(existing)) merged.input = addition.input
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

function candidateKey(candidate) {
  return `${candidate.provider}\u0000${candidate.model}`
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

function normalizeCandidate(value) {
  if (typeof value === 'string') {
    const raw = value.trim()
    if (raw.includes('/')) {
      const slash = raw.indexOf('/')
      return normalizeCandidate({ provider: raw.slice(0, slash), model: raw.slice(slash + 1) })
    }
    const provider = routeForModel(raw)
    return raw === '' || provider === '' ? null : { provider, model: raw }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '' || provider === AUTO_PROVIDER || CLIAPI_AUTO.has(provider)) return null
  return { provider, model }
}

function normalizeLane(source) {
  const candidates = []
  const seen = new Set()
  for (const raw of Array.isArray(source) ? source : []) {
    const candidate = normalizeCandidate(raw)
    if (candidate === null) continue
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
    if (candidates.length === 12) break
  }
  return candidates
}

export function normalizeConfig(value, defaults) {
  const lanes = {}
  for (const lane of LANES) {
    const source = value?.lanes?.[lane] ?? defaults?.[lane]
    lanes[lane] = normalizeLane(source)
  }
  return {
    enabled: value?.enabled !== false,
    lanes,
    cooldownSeconds: Number.isSafeInteger(value?.cooldownSeconds)
      ? Math.min(600, Math.max(5, value.cooldownSeconds))
      : 60,
  }
}

async function writeConfig(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temp, path)
  await chmod(path, 0o600)
}

export async function registerControlPlane(ctx, options) {
  const defaults = normalizeConfig({ lanes: options.defaultLanes }, { text: [], image: [], video: [], audio: [] }).lanes
  let dashboardHtml = await readFile(DASHBOARD_FILE, 'utf8')
  let stored
  let config
  try {
    stored = JSON.parse(await readFile(options.configPath, 'utf8'))
    config = normalizeConfig(stored, defaults)
  } catch (error) {
    if (error?.code !== 'ENOENT') ctx.logger.warn(error)
    config = normalizeConfig(undefined, defaults)
  }
  if (JSON.stringify(stored) !== JSON.stringify(config)) {
    await writeConfig(options.configPath, config)
  }

  const cooldowns = new Map()
  let lastDispatch = null
  const autoState = {
    ctx,
    cooldowns,
    getConfig: () => config,
    setLastDispatch: value => { lastDispatch = value },
  }
  const disposeInterceptor = installInterceptor(ctx, autoState)

  const migrateLegacyDefault = async () => {
    const next = migrateDefaultSelection(ctx.agentDefaultModel.currentSelection(), config)
    if (next === null) return
    try {
      await ctx.agentDefaultModel.saveSelection(next)
      ctx.logger.info('DSHLLM_API migrated default model from dshllm-api/auto to %s/%s', next.provider, next.model)
    } catch (error) {
      ctx.logger.warn('DSHLLM_API could not migrate default model: %s', error instanceof Error ? error.message : String(error))
    }
  }
  await migrateLegacyDefault()

  const PROVIDER_META = {
    'cliproxy-claude': { displayName: 'DSH_CLIAPI · Claude', api: 'anthropic-messages' },
    'cliproxy-antigravity': { displayName: 'DSH_CLIAPI · Antigravity', api: 'openai-completions' },
    'cliproxy-kimi': { displayName: 'DSH_CLIAPI · Kimi', api: 'openai-completions' },
    'cliproxy-codex': { displayName: 'DSH_CLIAPI · Codex', api: 'openai-completions' },
    'cliproxy-grok': { displayName: 'DSH_CLIAPI · Grok', api: 'openai-completions' },
  }

  const updatePiSettings = async (patch) => {
    const descriptor = ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')
    await ctx.settings.update('llm-pi-ai', patch, descriptor?.revision)
  }

  /**
 * Walk the existing `llm-pi-ai` route for `provider` and rewrite the `input`
 * of declared models whose modalities are missing or empty (which the harness
 * resolves to "inherit the route default"). Missing catalog models are not
 * appended here: the user's declared model set remains stable, while
 * `ensureProviderRoute` can still add a model explicitly selected in a lane.
 * Returns the updated array, or false when no entry changed.
 */
function refreshProviderInputs(provider, freshModels) {
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

  const ensureProviderRoute = async (provider, models, requiredModel, lane = 'text') => {
    const route = PROVIDER_META[provider]
    if (route === undefined) return
    const current = ctx.settings.get('llm-pi-ai')
    // CLIProxyAPI does not surface input modalities, so the harness would
    // register every model with an empty `input` and refuse image attachments
    // with UNSUPPORTED_CONTENT. `buildModelEntry` declares a sensible default
    // per role; users who need a stricter setup can override `input` in the
    // saved `llm-pi-ai` settings block, and `mergeModelEntry` below
    // preserves any explicit value already written there.
    const providerModels = models
      .filter(entry => entry.provider === provider)
      .map(entry => buildModelEntry(entry.id, entry.name, entry.id === requiredModel ? lane : 'text'))
    if (providerModels.length === 0) throw new Error(`${route.displayName} models are not available yet`)
    const existing = current?.providers?.[provider]
    if (existing !== undefined) {
      const declared = Array.isArray(existing.models) ? existing.models : []
      if (requiredModel === undefined || declared.some(model => model?.id === requiredModel)) return
      const addition = providerModels.find(model => model.id === requiredModel)
      if (addition === undefined) throw new Error(`${route.displayName} model ${requiredModel} is not available yet`)
      const merged = mergeModelEntry(declared, addition)
      await updatePiSettings( { providers: { [provider]: { models: merged } } })
      return
    }
    if (options.cliProxyBaseURL === undefined) throw new Error(`${route.displayName} is not configured`)
    await updatePiSettings( {
      providers: {
        [provider]: {
          displayName: route.displayName,
          apiKeyEnv: 'CLIPROXY_API_KEY',
          api: route.api,
          baseURL: options.cliProxyBaseURL,
          models: providerModels,
        },
      },
    })
  }

  const listCLIProxyModels = async () => {
    if (!options.cliProxyBaseURL || !options.cliProxyApiKey) return []
    try {
      const response = await fetch(`${options.cliProxyBaseURL.replace(/\/$/, '')}/v1/models`, {
        headers: { authorization: `Bearer ${options.cliProxyApiKey}`, accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const payload = await response.json()
      const rows = Array.isArray(payload?.data) ? payload.data : []
      const seen = new Set()
      const models = []
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id.trim() : ''
        if (id === '' || seen.has(id)) continue
        const ownedBy = typeof row?.owned_by === 'string' ? row.owned_by.trim() : ''
        const provider = routeForModel(id, ownedBy)
        if (provider === '') continue
        seen.add(id)
        const suggestedLane = suggestLane({ id, name: id })
        models.push({
          id,
          name: id,
          provider,
          providerName: PROVIDER_META[provider]?.displayName ?? provider,
          source: 'cliproxy',
          suggestedLane,
        })
      }
      return models
    } catch (error) {
      ctx.logger.warn('DSHLLM_API could not list CLIProxyAPI models: %s', error instanceof Error ? error.message : String(error))
      return []
    }
  }

  const listHarnessModels = async () => {
    const groups = await Promise.all(ctx.llm.listProviders()
      .filter(provider => provider.id !== AUTO_PROVIDER && !CLIAPI_AUTO.has(provider.id))
      .map(async (provider) => {
        try {
          const models = await ctx.llm.listModels(provider.id)
          return await Promise.all(models.map(async (model) => {
            let inputModalities
            try {
              const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
              inputModalities = info.inputModalities
            } catch {
              inputModalities = model.inputModalities
            }
            return {
              id: model.id,
              name: model.name ?? model.id,
              provider: provider.id,
              providerName: provider.name,
              source: provider.id.startsWith('cliproxy-') ? 'cliproxy' : 'harness',
              inputModalities,
              suggestedLane: suggestLane({ id: model.id, name: model.name, inputModalities }),
            }
          }))
        } catch (error) {
          ctx.logger.warn('DSHLLM_API could not list provider %s: %s', provider.id, error instanceof Error ? error.message : String(error))
          return []
        }
      }))
    const harness = groups.flat()
    const cliproxy = await listCLIProxyModels()
    const merged = new Map()
    for (const model of [...harness, ...cliproxy]) {
      const key = candidateKey({ provider: model.provider, model: model.id })
      if (!merged.has(key)) merged.set(key, model)
    }
    return [...merged.values()].sort((a, b) =>
      a.suggestedLane.localeCompare(b.suggestedLane)
      || a.providerName.localeCompare(b.providerName)
      || a.name.localeCompare(b.name))
  }

  const status = async () => {
    const models = await listHarnessModels()
    return {
      ok: true,
      product: 'DSHLLM_API',
      version: PLUGIN_VERSION,
      mode: 'transparent',
      models,
      defaultModel: ctx.agentDefaultModel.currentSelection(),
      router: {
        ...config,
        lastDispatch,
      },
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
      if (req.method === 'POST' && action === '/default-model') {
        const body = await readJson(req)
        const provider = String(body.provider ?? '')
        const model = String(body.model ?? '')
        if (provider === AUTO_PROVIDER) {
          throw new Error('DSHLLM_API 不再作为可选模型；普通对话请选择具体推理模型')
        }
        const models = await listHarnessModels()
        if (!models.some(entry => entry.provider === provider && entry.id === model)) {
          throw new Error('selected model is not currently available')
        }
        await ctx.agentDefaultModel.saveSelection({ provider, model })
        json(res, 200, { ok: true, defaultModel: ctx.agentDefaultModel.currentSelection() })
        return
      }
      if (req.method === 'PUT' && action === '/router') {
        const body = await readJson(req)
        const models = await listHarnessModels()
        const available = new Set(models.map(entry => candidateKey({ provider: entry.provider, model: entry.id })))
        const next = normalizeConfig(body, defaults)
        if (next.lanes.image.length === 0 && next.lanes.video.length === 0 && next.lanes.audio.length === 0) {
          throw new Error('至少配置一个图片、视频或音频模型')
        }
        for (const lane of LANES) {
          if (next.lanes[lane].some(candidate => !available.has(candidateKey(candidate)))) {
            throw new Error(`${lane} 候选模型当前不可用`)
          }
        }
        const cliproxyModels = await listCLIProxyModels()
        // Refresh the role-based `input` modalities on every cliproxy route
        // before validating the lane candidates. Settings that still carry
        // `input: []` (left over from older plugin versions) get the
        // recommended modalities here, so users can also trigger the fix by
        // resaving the dashboard.
        for (const provider of Object.keys(PROVIDER_META)) {
          const fresh = cliproxyModels
            .filter(entry => entry.provider === provider)
            .map((entry) => {
              const lane = LANES.find(candidateLane => next.lanes[candidateLane]
                .some(candidate => candidate.provider === provider && candidate.model === entry.id)) ?? 'text'
              return buildModelEntry(entry.id, entry.name, lane)
            })
          const merged = refreshProviderInputs(provider, fresh)
          if (merged === false) continue
          try {
            await updatePiSettings( { providers: { [provider]: { models: merged } } })
          } catch (error) {
            ctx.logger.warn('DSHLLM_API could not refresh %s modalities: %s', provider, error instanceof Error ? error.message : String(error))
          }
        }
        for (const lane of LANES) {
          for (const candidate of next.lanes[lane]) {
            if (candidate.provider.startsWith('cliproxy-')) {
              await ensureProviderRoute(candidate.provider, cliproxyModels, candidate.model, lane)
            }
          }
        }
        await writeConfig(options.configPath, next)
        config = next
        cooldowns.clear()
        json(res, 200, { ok: true, router: config })
        return
      }
      errorJson(res, 404, 'unknown DSHLLM_API route')
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      errorJson(res, 400, error instanceof Error ? error.message : String(error))
    }
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

  const syncConfiguredRoutes = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (ctx.settings.get('llm-pi-ai') !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const cliproxyModels = await listCLIProxyModels()
    if (cliproxyModels.length === 0) return
    // First pass: refresh the input modalities of every existing route so
    // older settings that left `input: []` get rewritten with the plugin's
    // role-based defaults. This is a one-shot migration; subsequent edits
    // that pin a non-empty `input` win via `mergeModelEntry`.
    for (const provider of Object.keys(PROVIDER_META)) {
      const providerFresh = cliproxyModels
        .filter(entry => entry.provider === provider)
        .map((entry) => {
          const lane = LANES.find(candidateLane => config.lanes[candidateLane]
            .some(candidate => candidate.provider === provider && candidate.model === entry.id)) ?? 'text'
          return buildModelEntry(entry.id, entry.name, lane)
        })
      const merged = refreshProviderInputs(provider, providerFresh)
      if (merged === false) continue
      try {
        await updatePiSettings( { providers: { [provider]: { models: merged } } })
      } catch (error) {
        ctx.logger.warn('DSHLLM_API could not refresh %s modalities: %s', provider, error instanceof Error ? error.message : String(error))
      }
    }
    for (const lane of LANES) {
      for (const candidate of config.lanes[lane]) {
        if (!candidate.provider.startsWith('cliproxy-')) continue
        try {
          await ensureProviderRoute(candidate.provider, cliproxyModels, candidate.model, lane)
        } catch (error) {
          ctx.logger.warn('DSHLLM_API could not register %s/%s: %s', candidate.provider, candidate.model, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }
  const ready = syncConfiguredRoutes().catch(error => {
    ctx.logger.warn('DSHLLM_API could not sync configured routes: %s', error instanceof Error ? error.message : String(error))
  })

  return async () => {
    await ready
    disposeApi()
    disposePanel()
    disposeInterceptor()
    dashboardHtml = ''
  }
}
