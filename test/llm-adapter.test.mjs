import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRouterAdapter, interceptStream, prepareCandidateRequest, sanitizeChunk, shouldReroute, stripReplayState } from '../plugin/llm-adapter.js'

function textMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function finishOk() {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

describe('createRouterAdapter', () => {
  it('dispatches image generation to the image lane in user order', async () => {
    const seen = []
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'cliproxy-grok', model: 'grok-4.6' }) },
      logger: { warn() {} },
      llm: {
        async resolveModelInfo() { return {} },
        stream(options) {
          seen.push(`${options.provider}/${options.model}`)
          return finishOk()
        },
      },
    }
    const last = []
    const adapter = createRouterAdapter(ctx, {
      cooldowns: new Map(),
      getConfig: () => ({
        enabled: true,
        cooldownSeconds: 60,
        lanes: {
          text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }],
          image: [
            { provider: 'cliproxy-codex', model: 'gpt-image-2' },
            { provider: 'cliproxy-grok', model: 'grok-imagine-image' },
          ],
          video: [],
          audio: [],
        },
      }),
      setLastDispatch: value => last.push(value),
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'dshllm-api',
      model: 'auto',
      messages: [textMessage('画一张赛博朋克风格的海报')],
    })) chunks.push(chunk)

    assert.deepEqual(seen, ['cliproxy-codex/gpt-image-2'])
    assert.equal(last[0]?.lane, 'image')
    assert.equal(last[0]?.intent, 'generate')
    assert.equal(last[0]?.model, 'gpt-image-2')
    assert.equal(chunks.at(-1)?.type, 'finish')
  })

  it('falls back to the next candidate in the same lane after a failure', async () => {
    const seen = []
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'cliproxy-grok', model: 'grok-4.6' }) },
      logger: { warn() {} },
      llm: {
        async resolveModelInfo() { return {} },
        stream(options) {
          seen.push(options.model)
          if (options.model === 'grok-4.6') {
            return (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } }
            })()
          }
          return finishOk()
        },
      },
    }
    const adapter = createRouterAdapter(ctx, {
      cooldowns: new Map(),
      getConfig: () => ({
        enabled: true,
        cooldownSeconds: 60,
        lanes: {
          text: [
            { provider: 'cliproxy-grok', model: 'grok-4.6' },
            { provider: 'cliproxy-codex', model: 'gpt-5.6-luna' },
          ],
          image: [],
          video: [],
          audio: [],
        },
      }),
      setLastDispatch() {},
    })

    for await (const _chunk of adapter.stream({
      provider: 'dshllm-api',
      model: 'auto',
      messages: [textMessage('解释一下这段代码')],
    })) { /* drain */ }

    assert.deepEqual(seen, ['grok-4.6', 'gpt-5.6-luna'])
  })

  it('sends generators a prompt-only request and falls back to text after UNSUPPORTED_CONTENT', async () => {
    const seen = []
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'cliproxy-grok', model: 'grok-4.6' }) },
      logger: { warn() {} },
      llm: {
        async resolveModelInfo() { return {} },
        stream(options) {
          seen.push({
            model: options.model,
            tools: options.tools,
            system: options.system,
            messages: options.messages.length,
          })
          if (options.model === 'gpt-image-2') {
            return (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT', message: 'no tools' } } }
            })()
          }
          return finishOk()
        },
      },
    }
    const adapter = createRouterAdapter(ctx, {
      cooldowns: new Map(),
      getConfig: () => ({
        enabled: true,
        cooldownSeconds: 60,
        lanes: {
          text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }],
          image: [{ provider: 'cliproxy-codex', model: 'gpt-image-2' }],
          video: [],
          audio: [],
        },
      }),
      setLastDispatch() {},
    })

    for await (const _chunk of adapter.stream({
      provider: 'dshllm-api',
      model: 'auto',
      system: 'You can use read_image and generate images.',
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
      messages: [textMessage('画一张赛博朋克风格的海报')],
    })) { /* drain */ }

    assert.equal(seen[0]?.model, 'gpt-image-2')
    assert.equal(seen[0]?.tools, undefined)
    assert.equal(seen[0]?.system, undefined)
    assert.equal(seen[0]?.messages, 1)
    assert.equal(seen[1]?.model, 'grok-4.6')
    assert.ok(Array.isArray(seen[1]?.tools))
  })

  it('skips image generators when the latest turn is ordinary text', async () => {
    const seen = []
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'cliproxy-grok', model: 'grok-4.6' }) },
      logger: { warn() {} },
      llm: {
        async resolveModelInfo() { return {} },
        stream(options) {
          seen.push(options.model)
          return finishOk()
        },
      },
    }
    const adapter = createRouterAdapter(ctx, {
      cooldowns: new Map(),
      getConfig: () => ({
        enabled: true,
        cooldownSeconds: 60,
        lanes: {
          text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }],
          image: [{ provider: 'cliproxy-codex', model: 'gpt-image-2' }],
          video: [],
          audio: [],
        },
      }),
      setLastDispatch() {},
    })

    for await (const _chunk of adapter.stream({
      provider: 'dshllm-api',
      model: 'auto',
      messages: [
        textMessage('画一张海报'),
        { role: 'assistant', content: [{ type: 'text', text: '可以用 read_image 看图' }] },
        textMessage('解释一下这段代码'),
      ],
    })) { /* drain */ }

    assert.deepEqual(seen, ['grok-4.6'])
  })
})

describe('shouldReroute', () => {
  const config = {
    enabled: true,
    lanes: {
      text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }],
      image: [{ provider: 'cliproxy-codex', model: 'gpt-image-2' }],
      video: [],
      audio: [],
    },
  }

  it('leaves ordinary text on the current model', () => {
    assert.equal(shouldReroute({ lane: 'text', intent: 'reason' }, config), false)
  })

  it('reroutes image tasks and skips empty media lanes', () => {
    assert.equal(shouldReroute({ lane: 'image', intent: 'generate' }, config), true)
    assert.equal(shouldReroute({ lane: 'video', intent: 'generate' }, config), false)
  })
})

describe('interceptStream', () => {
  it('does not touch ordinary text requests', () => {
    let nextCalls = 0
    const result = interceptStream(
      { logger: { warn() {} } },
      { getConfig: () => ({ enabled: true, lanes: { image: [{ provider: 'p', model: 'm' }] } }) },
      { provider: 'cliproxy-grok', model: 'grok-4.6', messages: [textMessage('解释一下这段代码')] },
      () => {
        nextCalls += 1
        return 'passthrough'
      },
    )
    assert.equal(result, 'passthrough')
    assert.equal(nextCalls, 1)
  })

  it('still routes a leftover dshllm-api session through the internal router', async () => {
    const seen = []
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'dshllm-api', model: 'auto' }) },
      logger: { warn() {} },
      llm: {
        async resolveModelInfo() { return {} },
        stream(options) {
          seen.push(`${options.provider}/${options.model}`)
          return finishOk()
        },
      },
    }
    const stream = interceptStream(
      ctx,
      {
        ctx,
        cooldowns: new Map(),
        getConfig: () => ({
          enabled: true,
          cooldownSeconds: 60,
          lanes: {
            text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }],
            image: [],
            video: [],
            audio: [],
          },
        }),
        setLastDispatch() {},
      },
      { provider: 'dshllm-api', model: 'auto', messages: [textMessage('解释一下这段代码')] },
      () => {
        throw new Error('legacy dshllm-api requests must not fall through to NO_ADAPTER')
      },
    )
    for await (const _chunk of stream) { /* drain */ }
    assert.deepEqual(seen, ['cliproxy-grok/grok-4.6'])
  })

  it('leaves current-model requests alone when the switch is off', () => {
    let nextCalls = 0
    const result = interceptStream(
      { logger: { warn() {} } },
      { getConfig: () => ({ enabled: false, lanes: { image: [{ provider: 'p', model: 'm' }] } }) },
      { provider: 'cliproxy-grok', model: 'grok-4.6', messages: [textMessage('画一张海报')] },
      () => {
        nextCalls += 1
        return 'passthrough'
      },
    )
    assert.equal(result, 'passthrough')
    assert.equal(nextCalls, 1)
  })
})

describe('prepareCandidateRequest', () => {
  it('strips tools and history for image generators', () => {
    const request = prepareCandidateRequest({
      provider: 'dshllm-api',
      model: 'auto',
      system: 'agent system',
      tools: [{ name: 'bash', description: 'run', parameters: {} }],
      messages: [textMessage('画一张赛博朋克风格的海报')],
    }, { provider: 'cliproxy-codex', model: 'gpt-image-2' }, { intent: 'generate' })
    assert.equal(request.provider, 'cliproxy-codex')
    assert.equal(request.model, 'gpt-image-2')
    assert.equal(request.system, undefined)
    assert.equal(request.tools, undefined)
    assert.equal(request.messages.length, 1)
    assert.equal(request.messages[0].content[0].text, '画一张赛博朋克风格的海报')
  })

  it('strips pi-ai replay state from history when routing cross-provider', () => {
    const history = [
      textMessage('画一张海报'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
        source: {
          kind: 'model',
          provider: 'cliproxy-grok',
          model: 'grok-4.6',
          replayState: { kind: 'pi-ai', version: 1, api: 'grok', provider: 'cliproxy-grok', model: 'grok-4.6' },
        },
      },
    ]
    const request = prepareCandidateRequest({
      provider: 'dshllm-api',
      model: 'auto',
      messages: history,
    }, { provider: 'cliproxy-codex', model: 'gpt-5.6-luna' }, { intent: 'understand' })
    assert.equal(request.messages[1].source.provider, 'cliproxy-grok')
    assert.equal(request.messages[1].source.replayState, undefined)
  })
})

describe('stripReplayState / sanitizeChunk', () => {
  it('sanitizeChunk drops replayState from finish chunks', () => {
    const chunk = sanitizeChunk({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { kind: 'pi-ai', version: 1, api: 'grok', provider: 'cliproxy-grok', model: 'grok-4.6' },
    })
    assert.equal(chunk.replayState, undefined)
    assert.equal(chunk.type, 'finish')
  })

  it('leaves chunks without replayState untouched', () => {
    const chunk = sanitizeChunk({ type: 'finish', reason: { kind: 'stop' } })
    assert.equal(chunk.replayState, undefined)
  })
})
