import assert from 'node:assert/strict'
import { createAutoAdapter } from '../plugin/control.js'

const calls = []
let lastDispatch = null
const candidates = [
  { provider: 'deepseek-official', model: 'deepseek-chat' },
  { provider: 'cliproxy-grok', model: 'grok-4.6' },
  { provider: 'minimax-custom', model: 'MiniMax-M2.5' },
]

const ctx = {
  logger: { warn() {} },
  llm: {
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        context: { contextWindow: provider === 'minimax-custom' ? 204_800 : 128_000 },
        defaultMaxTokens: provider === 'minimax-custom' ? 32_768 : 8_192,
      }
    },
    async * stream(options) {
      calls.push({
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      })
      if (options.provider === 'deepseek-official') {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'simulated limit' } },
        }
        return
      }
      if (options.provider === 'cliproxy-grok') {
        const error = new Error('simulated transport failure')
        error.code = 'TRANSPORT_ERROR'
        throw error
      }
      yield { type: 'text-delta', index: 0, text: 'HARNESS_AUTO_OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

const state = {
  cooldowns: new Map(),
  getConfig: () => ({ enabled: true, candidates, cooldownSeconds: 60 }),
  setLastDispatch: value => { lastDispatch = value },
}
const adapter = createAutoAdapter(ctx, state)

const model = await adapter.resolveModel('dsh-cliapi-auto-native', 'auto')
assert.equal(model.context.contextWindow, 128_000)
assert.equal(model.defaultMaxTokens, 8_192)

const chunks = []
for await (const chunk of adapter.stream({
  provider: 'dsh-cliapi-auto-native',
  model: 'auto',
  messages: [{ role: 'user', content: 'test' }],
  reasoningEffort: 'high',
})) {
  chunks.push(chunk)
}

assert.deepEqual(calls, [
  { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
  { provider: 'cliproxy-grok', model: 'grok-4.6', reasoningEffort: 'high' },
  { provider: 'minimax-custom', model: 'MiniMax-M2.5', reasoningEffort: 'high' },
])
assert.equal(chunks[0].type, 'text-delta')
assert.equal(chunks[0].text, 'HARNESS_AUTO_OK')
assert.equal(chunks.at(-1).reason.kind, 'stop')
assert.equal(lastDispatch.provider, 'minimax-custom')
assert.equal(lastDispatch.model, 'MiniMax-M2.5')
assert.equal(lastDispatch.attempts, 3)
assert.equal(state.cooldowns.size, 2)

console.log('HARNESS_AUTO_FAILOVER_OK')
