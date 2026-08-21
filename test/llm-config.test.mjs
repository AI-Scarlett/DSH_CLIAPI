import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildModelEntry, mergeModelEntry, migrateDefaultSelection, normalizeConfig } from '../plugin/llm-control.js'

describe('normalizeConfig', () => {
  it('accepts string model ids and drops the Auto route itself', () => {
    const config = normalizeConfig({
      enabled: true,
      lanes: {
        text: ['grok-4.6', { provider: 'cliproxy-codex', model: 'gpt-5.6-luna' }],
        image: ['gpt-image-2', 'dshllm-api/auto'],
        video: ['cliproxy-grok/grok-imagine-video'],
        audio: [{ provider: 'dsh-cliapi-auto-native', model: 'auto' }],
      },
    }, { text: [], image: [], video: [], audio: [] })
    assert.equal(config.enabled, true)
    assert.deepEqual(config.lanes.text, [
      { provider: 'cliproxy-grok', model: 'grok-4.6' },
      { provider: 'cliproxy-codex', model: 'gpt-5.6-luna' },
    ])
    assert.deepEqual(config.lanes.image, [{ provider: 'cliproxy-codex', model: 'gpt-image-2' }])
    assert.deepEqual(config.lanes.video, [{ provider: 'cliproxy-grok', model: 'grok-imagine-video' }])
    assert.deepEqual(config.lanes.audio, [])
  })

  it('defaults enabled to true unless explicitly disabled', () => {
    assert.equal(normalizeConfig({}, { text: [], image: [], video: [], audio: [] }).enabled, true)
    assert.equal(normalizeConfig({ enabled: false }, { text: [], image: [], video: [], audio: [] }).enabled, false)
  })
})

describe('migrateDefaultSelection', () => {
  it('moves dshllm-api/auto to the first text-lane candidate', () => {
    assert.deepEqual(migrateDefaultSelection(
      { provider: 'dshllm-api', model: 'auto' },
      { lanes: { text: [{ provider: 'cliproxy-grok', model: 'grok-4.6' }] } },
    ), { provider: 'cliproxy-grok', model: 'grok-4.6' })
  })

  it('leaves a real default model alone', () => {
    assert.equal(migrateDefaultSelection(
      { provider: 'cliproxy-grok', model: 'grok-4.6' },
      { lanes: { text: [{ provider: 'cliproxy-codex', model: 'gpt-5.6-luna' }] } },
    ), null)
  })
})

describe('buildModelEntry', () => {
  it('marks generators as text-only so image attachments are refused', () => {
    const entry = buildModelEntry('gpt-image-2', 'gpt-image-2')
    assert.deepEqual(entry, {
      id: 'gpt-image-2',
      name: 'gpt-image-2',
      input: ['text'],
    })
  })

  it('marks generators for video, audio, and tts as text-only', () => {
    assert.deepEqual(buildModelEntry('grok-imagine-image', 'grok-imagine-image').input, ['text'])
    assert.deepEqual(buildModelEntry('grok-imagine-video', 'grok-imagine-video').input, ['text'])
    assert.deepEqual(buildModelEntry('openai/tts-1', 'tts-1').input, ['text'])
  })

  it('defaults unknown chat models to text-only', () => {
    assert.deepEqual(buildModelEntry('grok-4.6', 'grok-4.6').input, ['text'])
    assert.deepEqual(buildModelEntry('future-reasoner', 'future-reasoner').input, ['text'])
  })

  it('declares image input only after explicit image-lane assignment', () => {
    assert.deepEqual(buildModelEntry('grok-4.6', 'grok-4.6', 'image').input, ['text', 'image'])
    assert.deepEqual(buildModelEntry('gpt-image-2', 'gpt-image-2', 'image').input, ['text'])
  })
})

describe('mergeModelEntry', () => {
  it('appends a new model when the id is missing from the declared list', () => {
    const declared = [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'] }]
    const merged = mergeModelEntry(declared, { id: 'gpt-image-2', name: 'gpt-image-2', input: ['text'] })
    assert.deepEqual(merged, [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'] },
      { id: 'gpt-image-2', name: 'gpt-image-2', input: ['text'] },
    ])
  })

  it('preserves a user-overridden input array on the matching entry', () => {
    const declared = [
      { id: 'grok-4.6', name: 'Grok 4.6', input: ['text'] }, // user explicitly pinned text-only
    ]
    const merged = mergeModelEntry(declared, {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      input: ['text', 'image'], // plugin default would have been multimodal
    })
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].input, ['text'])
  })

  it('replaces an empty input array with the plugin recommendation so image attachments flow', () => {
    // Older plugin revisions left settings with `input: []`; the harness
    // resolves that to the route default, so the plugin is free to apply
    // its role-based default here.
    const declared = [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: [] },
    ]
    const merged = mergeModelEntry(declared, {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      input: ['text', 'image'],
    })
    assert.deepEqual(merged[0].input, ['text', 'image'])
  })

  it('replaces an undefined input with the plugin recommendation', () => {
    const declared = [
      { id: 'grok-4.6', name: 'Grok 4.6' },
    ]
    const merged = mergeModelEntry(declared, {
      id: 'grok-4.6',
      name: 'Grok 4.6',
      input: ['text', 'image'],
    })
    assert.deepEqual(merged[0].input, ['text', 'image'])
  })

  it('preserves a custom display name and user-supplied compat block', () => {
    const declared = [
      { id: 'grok-4.6', name: 'Grok 4.6', compat: { thinkingFormat: 'openai' } },
    ]
    const merged = mergeModelEntry(declared, {
      id: 'grok-4.6',
      name: 'upstream-grok-4.6',
      input: ['text', 'image'],
    })
    assert.equal(merged[0].name, 'Grok 4.6')
    assert.deepEqual(merged[0].compat, { thinkingFormat: 'openai' })
  })

  it('returns the original array when the effective entry is unchanged', () => {
    const declared = [{ id: 'gpt-image-2', name: 'gpt-image-2', input: ['text'] }]
    assert.equal(
      mergeModelEntry(declared, { id: 'gpt-image-2', name: 'gpt-image-2', input: ['text'] }),
      declared,
    )
  })

  it('does not mutate the declared array when applying a change', () => {
    const declared = [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', input: [] }]
    const snapshot = JSON.parse(JSON.stringify(declared))
    mergeModelEntry(declared, { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', input: ['text', 'image'] })
    assert.deepEqual(declared, snapshot)
  })
})
