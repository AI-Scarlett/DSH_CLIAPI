import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyTask, orderCandidates, suggestLane } from '../plugin/llm-classify.js'

const user = (...content) => ({ role: 'user', content })

describe('classifyTask', () => {
  it('keeps ordinary reasoning on the text lane', () => {
    assert.deepEqual(classifyTask({
      messages: [user({ type: 'text', text: '帮我看看这段 TypeScript 为什么编译失败' })],
    }), { lane: 'text', intent: 'reason', reasons: [] })
  })

  it('routes image blocks to image understanding', () => {
    const result = classifyTask({
      messages: [user(
        { type: 'text', text: '这是什么' },
        { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 12, width: 1, height: 1 } },
      )],
    })
    assert.equal(result.lane, 'image')
    assert.equal(result.intent, 'understand')
    assert.ok(result.reasons.includes('image-block'))
  })

  it('routes nested tool-result images', () => {
    const result = classifyTask({
      messages: [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
        }],
      }],
    })
    assert.equal(result.lane, 'image')
    assert.ok(result.reasons.includes('image-block'))
  })

  it('routes image generation prompts', () => {
    const result = classifyTask({ messages: [user({ type: 'text', text: '画一张赛博朋克风格的海报' })] })
    assert.equal(result.lane, 'image')
    assert.equal(result.intent, 'generate')
  })

  it('routes video files and generation separately', () => {
    const watch = classifyTask({ messages: [user({ type: 'text', text: '看看 demo.mp4 里发生了什么' })] })
    assert.equal(watch.lane, 'video')
    assert.equal(watch.intent, 'understand')
    const make = classifyTask({ messages: [user({ type: 'text', text: '用 Sora 生成一段产品宣传视频' })] })
    assert.equal(make.lane, 'video')
    assert.equal(make.intent, 'generate')
  })

  it('routes audio transcription and TTS', () => {
    const stt = classifyTask({ messages: [user({ type: 'text', text: '把这段录音 meeting.wav 转写成文字' })] })
    assert.equal(stt.lane, 'audio')
    assert.equal(stt.intent, 'understand')
    const tts = classifyTask({ messages: [user({ type: 'text', text: '给这段文案配音' })] })
    assert.equal(tts.lane, 'audio')
    assert.equal(tts.intent, 'generate')
  })

  it('ignores older image turns and tool docs when the latest ask is text', () => {
    const result = classifyTask({
      messages: [
        user({ type: 'text', text: '画一张海报' }),
        { role: 'assistant', content: [{ type: 'text', text: '可以用 read_image 看图，也可以生成图片' }] },
        user({ type: 'text', text: '这段 TypeScript 为什么编译失败' }),
      ],
    })
    assert.equal(result.lane, 'text')
    assert.equal(result.intent, 'reason')
  })
})

describe('suggestLane', () => {
  it('classifies catalog names', () => {
    assert.equal(suggestLane({ id: 'grok-imagine-video-1.5' }), 'video')
    assert.equal(suggestLane({ id: 'gpt-image-2' }), 'image')
    assert.equal(suggestLane({ id: 'whisper-1' }), 'audio')
    assert.equal(suggestLane({ id: 'grok-4.6', inputModalities: ['text'] }), 'text')
    assert.equal(suggestLane({ id: 'gpt-5.6-sol', inputModalities: ['text', 'image'] }), 'image')
  })
})

describe('orderCandidates', () => {
  it('tries generators first for generate intent, keep user order inside groups', () => {
    const candidates = [
      { provider: 'cliproxy-grok', model: 'grok-4.6' },
      { provider: 'cliproxy-grok', model: 'grok-imagine-image' },
      { provider: 'cliproxy-codex', model: 'gpt-image-2' },
    ]
    assert.deepEqual(orderCandidates(candidates, 'generate').map(item => item.model), [
      'grok-imagine-image',
      'gpt-image-2',
      'grok-4.6',
    ])
    assert.deepEqual(orderCandidates(candidates, 'understand').map(item => item.model), [
      'grok-4.6',
      'grok-imagine-image',
      'gpt-image-2',
    ])
  })
})
