import {
  AUTO_MODEL,
  AUTO_PROVIDER,
  classifyTask,
  latestUserText,
  looksLikeGenerator,
  orderCandidates,
} from './llm-classify.js'

export const ROUTED = Symbol.for('dshllm-api.routed')
const CLIAPI_AUTO = new Set(['dsh-cliapi-auto-native', 'dsh-cliapi-auto'])
const CONTENT_FAILURES = new Set(['UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'UNKNOWN_MODEL', 'NO_ADAPTER'])

export function shouldReroute(classified, config) {
  if (config?.enabled === false) return false
  if (!classified || classified.lane === 'text' || classified.intent === 'reason') return false
  return Array.isArray(config?.lanes?.[classified.lane]) && config.lanes[classified.lane].length > 0
}

function commitsCandidate(chunk) {
  return chunk?.type === 'text-delta'
    || chunk?.type === 'reasoning-delta'
    || chunk?.type === 'tool-call-delta'
    || chunk?.type === 'block-end'
}

function candidateKey(candidate) {
  return `${candidate.provider}\u0000${candidate.model}`
}

function fallbackTextRoute(ctx) {
  const selection = ctx.agentDefaultModel.currentSelection()
  if (selection.provider !== AUTO_PROVIDER && !CLIAPI_AUTO.has(selection.provider)) {
    return { provider: selection.provider, model: selection.model }
  }
  return null
}

function uniqueCandidates(list) {
  const seen = new Set()
  const result = []
  for (const candidate of list) {
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function textFallback(config, ctx) {
  const ordered = [...(config.lanes.text ?? [])]
  const fallback = fallbackTextRoute(ctx)
  if (fallback) ordered.push(fallback)
  return uniqueCandidates(ordered)
}

function resolveLane(state, options) {
  const config = state.getConfig()
  const classified = classifyTask({ messages: options.messages ?? [] })
  const lane = config.lanes[classified.lane]?.length ? classified.lane : 'text'
  let ordered = orderCandidates(config.lanes[lane] ?? [], classified.intent)
  if (classified.intent === 'understand' || classified.intent === 'reason') {
    const chat = ordered.filter(candidate => !looksLikeGenerator(candidate.model))
    if (chat.length > 0) ordered = chat
  }
  if (lane === 'text' && ordered.length === 0) {
    ordered = textFallback(config, state.ctx)
  }
  return { classified: { ...classified, lane }, candidates: uniqueCandidates(ordered) }
}

function generationPrompt(options) {
  const text = latestUserText(options.messages ?? []).trim()
  if (text !== '') return text
  const last = [...(options.messages ?? [])].reverse().find(message => message?.role === 'user')
  const blocks = last?.content ?? []
  return blocks.map(block => block?.type === 'text' ? block.text : '').join('\n').trim()
}

/**
 * Cross-provider routing must not carry pi-ai replay metadata: the replay
 * state is bound to the exact provider/model that produced the message, and
 * the agent loop stores assistant history under the original request route.
 * Without this, the pi-ai adapter rejects the conversation with
 * "invalid pi-ai replay state: provider does not match assistant source".
 */
export function stripReplayState(messages) {
  return (messages ?? []).map((message) => {
    const source = message?.source
    if (source === undefined || source?.replayState === undefined) return message
    const copy = { ...message, source: { ...source } }
    delete copy.source.replayState
    return copy
  })
}

/** Drop replay metadata from finish chunks so history never binds to a routed candidate. */
export function sanitizeChunk(chunk) {
  if (chunk?.type === 'finish' && chunk?.replayState !== undefined) {
    const { replayState, ...rest } = chunk
    return rest
  }
  return chunk
}

export function prepareCandidateRequest(options, candidate, classified) {
  const request = { ...options, provider: candidate.provider, model: candidate.model, [ROUTED]: true }
  if (classified.intent !== 'generate' || !looksLikeGenerator(candidate.model)) {
    request.messages = stripReplayState(request.messages)
    return request
  }
  const prompt = generationPrompt(options)
  return {
    provider: candidate.provider,
    model: candidate.model,
    [ROUTED]: true,
    messages: stripReplayState([{
      role: 'user',
      content: [{ type: 'text', text: prompt || 'Generate an image for the latest user request.' }],
    }]),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  }
}

export function createRouterAdapter(ctx, state) {
  state.ctx = ctx
  return {
    providerInfo(provider) {
      return { id: provider, name: 'DSHLLM_API · Auto' }
    },
    providerRetryPolicy() {
      return undefined
    },
    listModels(provider) {
      return Promise.resolve([{
        provider,
        id: AUTO_MODEL,
        name: 'Auto · 按任务类型调度',
        description: '普通推理走文本模型；图片、视频、音频任务按你排好的优先级自动切换',
        inputModalities: ['text', 'image'],
      }])
    },
    async resolveModel(provider, model, signal) {
      const config = state.getConfig()
      const all = Object.values(config.lanes).flat()
      const contexts = []
      const outputCaps = []
      for (const candidate of all) {
        if (signal?.aborted) break
        try {
          const info = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model, signal)
          if (info.context?.contextWindow !== undefined) contexts.push(info.context.contextWindow)
          if (info.defaultMaxTokens !== undefined) outputCaps.push(info.defaultMaxTokens)
        } catch {
          // A stale candidate must not hide Auto from the selector.
        }
      }
      return {
        provider,
        id: model,
        name: 'Auto · 按任务类型调度',
        description: '普通推理走文本模型；图片、视频、音频任务按你排好的优先级自动切换',
        inputModalities: ['text', 'image'],
        ...(contexts.length === 0 ? {} : { context: { contextWindow: Math.min(...contexts) } }),
        ...(outputCaps.length === 0 ? {} : { defaultMaxTokens: Math.min(...outputCaps) }),
      }
    },
    async * stream(options) {
      const config = state.getConfig()
      let classified
      let candidates
      if (!config.enabled) {
        classified = { lane: 'text', intent: 'reason', reasons: ['disabled'] }
        candidates = textFallback(config, ctx)
        if (candidates.length === 0) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTO_DISABLED', message: 'DSHLLM_API is disabled' } } }
          return
        }
      } else {
        ({ classified, candidates } = resolveLane(state, options))
      }
      const queue = []
      const seen = new Set()
      const enqueue = (list) => {
        for (const candidate of list) {
          const key = candidateKey(candidate)
          if (seen.has(key)) continue
          seen.add(key)
          queue.push(candidate)
        }
      }
      enqueue(candidates)
      if (classified.lane !== 'text') enqueue(textFallback(config, ctx))
      if (queue.length === 0) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'AUTO_EMPTY_LANE',
              message: `DSHLLM_API has no candidates for ${classified.lane} tasks`,
            },
          },
        }
        return
      }
      const now = Date.now()
      const ready = queue.filter(candidate => (state.cooldowns.get(candidateKey(candidate)) ?? 0) <= now)
      const attempts = ready.length > 0 ? ready : queue
      const failures = []
      for (const candidate of attempts) {
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'DSHLLM_API was aborted' } } }
          return
        }
        const pending = []
        let committed = false
        let failed = null
        const request = prepareCandidateRequest(options, candidate, classified)
        try {
          for await (const rawChunk of ctx.llm.stream(request)) {
            const chunk = sanitizeChunk(rawChunk)
            if (!committed && chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
              if (chunk.reason.kind === 'aborted' && options.signal?.aborted) {
                yield chunk
                return
              }
              failed = chunk.reason.failure
              break
            }
            if (!committed) {
              pending.push(chunk)
              if (commitsCandidate(chunk) || chunk.type === 'finish') {
                committed = true
                state.setLastDispatch({
                  ...candidate,
                  lane: classified.lane,
                  intent: classified.intent,
                  reasons: classified.reasons,
                  at: new Date().toISOString(),
                  attempts: failures.length + 1,
                })
                yield* pending
              }
            } else {
              yield chunk
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
        const cooldownMs = CONTENT_FAILURES.has(failure.code) ? 5_000 : config.cooldownSeconds * 1000
        state.cooldowns.set(candidateKey(candidate), Date.now() + cooldownMs)
      }
      const summary = failures.map(item => `${item.provider}/${item.model} (${item.failure.code})`).join(', ')
      ctx.logger.warn('DSHLLM_API exhausted %s candidates: %s', classified.lane, summary)
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTO_EXHAUSTED', message: `${classified.lane} candidates failed: ${summary}` } } }
    },
  }
}

export function isLegacyAutoRoute(options) {
  return options?.provider === AUTO_PROVIDER
}

export function interceptStream(ctx, state, options, next) {
  if (options?.[ROUTED]) return next()
  const legacyAuto = isLegacyAutoRoute(options)
  if (!legacyAuto && (options?.purpose === 'compaction' || options?.purpose === 'session-title')) return next()
  const config = state.getConfig()
  if (!legacyAuto && config.enabled === false) return next()
  if (!legacyAuto) {
    const classified = classifyTask({ messages: options.messages ?? [] })
    if (!shouldReroute(classified, config)) return next()
  }
  const adapter = createRouterAdapter(ctx, state)
  return adapter.stream({
    ...options,
    provider: AUTO_PROVIDER,
    model: options?.model || AUTO_MODEL,
  })
}

export function installInterceptor(ctx, state) {
  return ctx.on('llm/stream', (options, next) => interceptStream(ctx, state, options, next))
}
