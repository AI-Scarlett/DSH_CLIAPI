import assert from 'node:assert/strict'
import {
  buildModelEntry,
  createAutoAdapter,
  mergeModelEntry,
  stripReplayStateFromChunk,
  stripReplayStateFromHistory,
} from '../plugin/control.js'

// ---------- Pure helpers ----------
{
  assert.deepEqual(buildModelEntry('grok-4.6', 'Grok 4.6').input, ['text'])
  assert.deepEqual(buildModelEntry('future-reasoner', 'Future Reasoner').input, ['text'])
  assert.deepEqual(
    buildModelEntry('grok-4.6', 'Grok 4.6', { input: ['text', 'image'] }).input,
    ['text', 'image'],
  )

  const declared = [{ id: 'grok-4.6', name: 'Custom Grok', input: [] }]
  const migrated = mergeModelEntry(declared, buildModelEntry('grok-4.6', 'Upstream Grok'))
  assert.deepEqual(migrated[0].input, ['text'])
  assert.equal(migrated[0].name, 'Custom Grok')
  assert.deepEqual(declared[0].input, [])
  assert.equal(mergeModelEntry(migrated, buildModelEntry('grok-4.6', 'Grok 4.6')), migrated)

  const overridden = [{ id: 'grok-4.6', name: 'Grok 4.6', input: ['text'] }]
  assert.equal(mergeModelEntry(overridden, buildModelEntry('grok-4.6', 'Grok 4.6')), overridden)
  console.log('HARNESS_MODEL_INPUT_MODALITIES_OK')
}
{
  const replayState = { kind: 'pi-ai', version: 1, provider: 'cliproxy-grok', model: 'grok-4.6' }
  const original = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'older turn' }],
      source: { kind: 'model', provider: 'cliproxy-grok', model: 'grok-4.6', replayState },
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'plain turn' }],
      source: { kind: 'model', provider: 'cliproxy-grok', model: 'grok-4.6' },
    },
  ]
  const snapshot = JSON.parse(JSON.stringify(original))
  const sanitized = stripReplayStateFromHistory(original)

  // User and non-replay assistant messages are reused by reference.
  assert.equal(sanitized[0], original[0])
  assert.equal(sanitized[2], original[2])
  // The replay-bearing assistant message is replaced with a copy that omits replayState.
  assert.notEqual(sanitized[1], original[1])
  assert.equal(sanitized[1].source.replayState, undefined)
  assert.equal(sanitized[1].source.provider, 'cliproxy-grok')
  // The caller's array stays intact.
  assert.deepEqual(original, snapshot)
}

// ---------- Auto failover ----------
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

// ---------- Replay-state sanitisation during failover ----------
{
  // Real-looking pi-ai replay metadata that would otherwise fail the next
  // turn with `invalid pi-ai replay state: provider does not match assistant
  // source` because the agent loop records assistant sources under
  // `dsh-cliapi-auto-native/auto`, not the candidate that produced them.
  const replayState = {
    kind: 'pi-ai',
    version: 1,
    api: 'openai-completions',
    provider: 'cliproxy-grok',
    model: 'grok-4.6',
    stopReason: 'stop',
    blocks: [{ type: 'text' }],
  }
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'first reply' }],
      source: { kind: 'model', provider: 'cliproxy-grok', model: 'grok-4.6', replayState },
    },
  ]
  const historySnapshot = JSON.parse(JSON.stringify(history))

  const receivedRequests = []
  const replayCtx = {
    logger: { warn() {} },
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192 }
      },
      async * stream(options) {
        receivedRequests.push({
          provider: options.provider,
          model: options.model,
          messages: options.messages,
        })
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          replayState: {
            kind: 'pi-ai',
            version: 1,
            provider: options.provider,
            model: options.model,
            stopReason: 'stop',
            blocks: [],
          },
        }
      },
    },
  }
  const replayState_ = {
    cooldowns: new Map(),
    getConfig: () => ({ enabled: true, candidates: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }], cooldownSeconds: 60 }),
    setLastDispatch() {},
  }
  const replayAdapter = createAutoAdapter(replayCtx, replayState_)

  const forwarded = []
  for await (const chunk of replayAdapter.stream({
    provider: 'dsh-cliapi-auto-native',
    model: 'auto',
    messages: history,
  })) {
    forwarded.push(chunk)
  }

  // The candidate received a sanitized copy: the assistant message still
  // names the historical provider (the harness keeps `source.provider` so
  // the durable log stays accurate), but its `replayState` is gone.
  assert.equal(receivedRequests.length, 1)
  const candidateMessages = receivedRequests[0].messages
  assert.equal(candidateMessages.length, 2)
  assert.equal(candidateMessages[0], history[0])
  assert.notEqual(candidateMessages[1], history[1])
  assert.equal(candidateMessages[1].source.replayState, undefined)
  assert.equal(candidateMessages[1].source.provider, 'cliproxy-grok')

  // The outer history that the harness keeps is untouched.
  assert.deepEqual(history, historySnapshot)

  // The successful finish chunk's `replayState` was stripped before reaching
  // the harness, so the agent loop can never pair it with the
  // `dsh-cliapi-auto-native/auto` assistant source it is about to record.
  const finish = forwarded.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.replayState, undefined)
}

console.log('HARNESS_AUTO_REPLAY_STATE_OK')

// ---------- Tool-call commit must also strip replayState ----------
// Regression for `invalid pi-ai replay state: provider does not match
// assistant source`. The agent loop commits a candidate the moment any
// block-end (text or tool-call) lands, so the chunk-strip path taken via
// `commitsCandidate(sanitized)` on a tool-call block has to be covered
// independently of the text-only success path above. If a tool-call
// candidate leaks its `replayState`, the harness pairs it with the
// outer `dsh-cliapi-auto-native/auto` assistant source and the next
// turn explodes with INVALID_REPLAY_STATE — which is exactly what the
// user observed mid-session after a successful tool call.
{
  const toolCalls = [
    {
      type: 'tool-call',
      id: 'call-failing-bug-1',
      name: 'read_file',
      arguments: '{"path":"/Users/zhouxiaoming/Documents/DSH_api/plugin/control.js"}',
    },
    {
      type: 'tool-call',
      id: 'call-failing-bug-2',
      name: 'read_file',
      arguments: '{"path":"/Users/zhouxiaoming/deepseek-harness/packages/host/apiproxy/src/api-proxy.ts"}',
    },
  ]
  const replayCtx = {
    logger: { warn() {} },
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192 }
      },
      async * stream(options) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: toolCalls[0] }
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'block-end', index: 1, block: toolCalls[1] }
        yield {
          type: 'finish',
          reason: { kind: 'tool-calls' },
          replayState: {
            kind: 'pi-ai',
            version: 1,
            api: 'openai-completions',
            provider: options.provider,
            model: options.model,
            stopReason: 'toolUse',
            blocks: [
              { type: 'tool-call', thoughtSignature: 'sig-a' },
              { type: 'tool-call', thoughtSignature: 'sig-b' },
            ],
          },
        }
      },
    },
  }
  const replayState_ = {
    cooldowns: new Map(),
    getConfig: () => ({
      enabled: true,
      candidates: [{ provider: 'cliproxy-codex', model: 'gpt-5.6-sol-wm' }],
      cooldownSeconds: 60,
    }),
    setLastDispatch() {},
  }
  const toolCallAdapter = createAutoAdapter(replayCtx, replayState_)

  const forwarded = []
  for await (const chunk of toolCallAdapter.stream({
    provider: 'dsh-cliapi-auto-native',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: '分析原因 暂时不要改代码' }] }],
  })) {
    forwarded.push(chunk)
  }

  // Both tool-call blocks must come through untouched (only finish chunks
  // get the replayState strip; the harness still needs the structured
  // tool-call content to plan the next step).
  const forwardedBlocks = forwarded.filter(chunk => chunk.type === 'block-end')
  assert.equal(forwardedBlocks.length, 2)
  assert.equal(forwardedBlocks[0].block.id, 'call-failing-bug-1')
  assert.equal(forwardedBlocks[1].block.id, 'call-failing-bug-2')

  // The terminal chunk still identifies a tool-call stop, and the
  // candidate-owned replayState that named `cliproxy-codex/gpt-5.6-sol-wm`
  // is gone — the harness is about to record this turn's assistant source
  // as `dsh-cliapi-auto-native/auto`, so any candidate replayState that
  // survived would trip INVALID_REPLAY_STATE on the very next turn.
  const finish = forwarded.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(finish.replayState, undefined)

  // No candidate was put in cooldown: the first attempt committed.
  assert.equal(replayState_.cooldowns.size, 0)
}

console.log('HARNESS_AUTO_TOOLCALL_REPLAY_STATE_OK')

// ---------- stripReplayStateFromChunk contract ----------
{
  const finishWithReplay = {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: { kind: 'pi-ai', version: 1, provider: 'x', model: 'y' },
  }
  const stripped = stripReplayStateFromChunk(finishWithReplay)
  assert.equal(stripped.type, 'finish')
  assert.equal(stripped.reason.kind, 'stop')
  assert.equal(stripped.replayState, undefined)
  // The original chunk stays untouched; stripping returns a new object.
  assert.equal(finishWithReplay.replayState.provider, 'x')

  // Non-finish chunks pass through by reference.
  const text = { type: 'text-delta', index: 0, text: 'hi' }
  assert.equal(stripReplayStateFromChunk(text), text)

  // Finish chunks without replayState also pass through.
  const plainFinish = { type: 'finish', reason: { kind: 'stop' } }
  assert.equal(stripReplayStateFromChunk(plainFinish), plainFinish)
}

console.log('HARNESS_AUTO_CHUNK_STRIP_OK')
