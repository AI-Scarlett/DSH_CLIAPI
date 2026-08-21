/** Pure task classification and model-lane suggestion for DSHLLM_API. */

export const LANES = Object.freeze(['text', 'image', 'video', 'audio'])
export const AUTO_PROVIDER = 'dshllm-api'
export const AUTO_MODEL = 'auto'

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|bmp|heic|heif|avif|tif{1,2}|svg)(?:\b|$)/i
const VIDEO_EXT = /\.(?:mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|wmv|flv)(?:\b|$)/i
const AUDIO_EXT = /\.(?:mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff?)(?:\b|$)/i

const VIDEO_GENERATE = /生成\s*视频|做[一条]视频|视频生成|text\s*to\s*video|t2v|runway|pika|kling|可灵|即梦视频|sora|veo|imagine[-\s]?video|generate(?:\s+an?)?\s+video|make(?:\s+an?)?\s+video|create(?:\s+an?)?\s+video/i
const VIDEO_UNDERSTAND = /看[看下]?[这支条]?视频|分析[这支条]?视频|视频[里中的]|转写视频|视频理解|describe(?:\s+the)?\s+video|watch(?:\s+this)?\s+video|transcribe(?:\s+the)?\s+video/i
const AUDIO_GENERATE = /配音|语音合成|text\s*to\s*speech|\btts\b|生成[一段]?音频|生成[一段]?语音|朗读这段|clone(?:\s+my)?\s+voice/i
const AUDIO_UNDERSTAND = /转写|听写|语音识别|这段录音|这段音频|whisper|speech\s*to\s*text|\bstt\b|transcribe|audio\s+to\s+text/i
const IMAGE_GENERATE = /画[一几]?张|生成[一几张幅]?图|生图|出一张图|做一张海报|text\s*to\s*image|\bt2i\b|dall[-.]?e|stable\s*diffusion|\bflux\b|\bimagen\b|generate(?:\s+an?)?\s+image|draw(?:\s+me)?(?:\s+an?)?\s+(?:image|picture|poster)|create(?:\s+an?)?\s+image/i
const IMAGE_UNDERSTAND = /看[看下]?[这张幅]?图|识图|这张图|截图里|图片[里中的]|图像[里中的]|分析[这张幅]?图|describe(?:\s+the)?\s+image|what(?:'s| is) in (?:this|the) (?:image|photo|picture)|\bocr\b/i

const GEN_MODEL = /(?:^|[-_/])(?:image|imagine|imagen|dall-?e|flux|midjourney|ideogram|firefly|video|veo|sora|runway|pika|kling|tts|speech|voice|audio)(?:[-_/]|$)/i
const VIDEO_MODEL = /(?:^|[-_/])(?:video|veo|sora|runway|pika|kling|luma)(?:[-_/]|$)|imagine-video/i
const AUDIO_MODEL = /(?:^|[-_/])(?:audio|tts|stt|whisper|speech|voice|sound)(?:[-_/]|$)/i
const IMAGE_MODEL = /(?:^|[-_/])(?:image|imagine|imagen|vision|dall-?e|flux|midjourney|ideogram)(?:[-_/]|$)/i

/**
 * @param {unknown} block
 * @returns {boolean}
 */
function isImageBlock(block) {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'image') return true
  if (block.type === 'tool-result' && Array.isArray(block.content)) {
    return block.content.some(isImageBlock)
  }
  return false
}

/**
 * Flatten model-visible text from typed messages.
 * @param {readonly { content?: readonly unknown[] }[]} messages
 */
export function extractText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (!block || typeof block !== 'object') continue
      if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
        parts.push(block.text)
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner?.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
        }
      }
    }
  }
  return parts.join('\n')
}

function isHumanUser(message) {
  return message?.role === 'user' && message?.source?.kind !== 'plugin'
}

/**
 * Latest human turn only. System-prompt injections, tool docs, and older
 * image turns must not keep later coding questions on a media lane.
 * @param {readonly { role?: string, source?: { kind?: string }, content?: readonly unknown[] }[]} messages
 */
export function latestTurnMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isHumanUser(list[index])) {
      start = index
      break
    }
  }
  return list.slice(start)
}

export function latestUserText(messages) {
  return extractText(latestTurnMessages(messages).filter(isHumanUser))
}

/**
 * Suggest a lane for a catalog model.
 * @param {{ id?: string, name?: string, inputModalities?: readonly string[] }} model
 * @returns {'text' | 'image' | 'video' | 'audio'}
 */
export function suggestLane(model) {
  const id = String(model?.id ?? '')
  const name = String(model?.name ?? '')
  const hay = `${id} ${name}`
  if (VIDEO_MODEL.test(hay)) return 'video'
  if (AUDIO_MODEL.test(hay)) return 'audio'
  if (IMAGE_MODEL.test(hay)) return 'image'
  if (Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')) return 'image'
  return 'text'
}

/**
 * Whether a model id looks like a media generator rather than a reasoner.
 * @param {string} modelId
 */
export function looksLikeGenerator(modelId) {
  return GEN_MODEL.test(String(modelId ?? ''))
}

/**
 * Classify the current request into a modality lane.
 * @param {{
 *   messages?: readonly { role?: string, content?: readonly unknown[] }[],
 *   extraText?: string,
 * }} input
 * @returns {{
 *   lane: 'text' | 'image' | 'video' | 'audio',
 *   intent: 'understand' | 'generate' | 'reason',
 *   reasons: string[],
 * }}
 */
export function classifyTask(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : []
  const turn = latestTurnMessages(messages)
  const text = `${latestUserText(messages)}\n${input.extraText ?? ''}`
  const reasons = []
  const hasImage = turn.some(message => (message?.content ?? []).some(isImageBlock))
  if (hasImage) reasons.push('image-block')

  const hasVideoFile = VIDEO_EXT.test(text)
  const hasAudioFile = AUDIO_EXT.test(text)
  const hasImageFile = IMAGE_EXT.test(text)
  if (hasVideoFile) reasons.push('video-file')
  if (hasAudioFile) reasons.push('audio-file')
  if (hasImageFile) reasons.push('image-file')

  const videoGenerate = VIDEO_GENERATE.test(text)
  const videoUnderstand = VIDEO_UNDERSTAND.test(text) || hasVideoFile
  const audioGenerate = AUDIO_GENERATE.test(text)
  const audioUnderstand = AUDIO_UNDERSTAND.test(text) || hasAudioFile
  const imageGenerate = IMAGE_GENERATE.test(text)
  const imageUnderstand = IMAGE_UNDERSTAND.test(text) || hasImage || hasImageFile

  if (videoGenerate || videoUnderstand) {
    if (videoGenerate) reasons.push('video-generate')
    if (videoUnderstand && !hasVideoFile) reasons.push('video-understand')
    return { lane: 'video', intent: videoGenerate && !hasVideoFile ? 'generate' : 'understand', reasons }
  }
  if (audioGenerate || audioUnderstand) {
    if (audioGenerate) reasons.push('audio-generate')
    if (audioUnderstand && !hasAudioFile) reasons.push('audio-understand')
    return { lane: 'audio', intent: audioGenerate && !hasAudioFile ? 'generate' : 'understand', reasons }
  }
  if (imageGenerate || imageUnderstand) {
    if (imageGenerate) reasons.push('image-generate')
    if (imageUnderstand && !hasImage && !hasImageFile) reasons.push('image-understand')
    return { lane: 'image', intent: imageGenerate && !hasImage && !hasImageFile ? 'generate' : 'understand', reasons }
  }
  return { lane: 'text', intent: 'reason', reasons }
}

/**
 * Order a lane's candidates so the matching intent is tried first, preserving
 * the user's relative priority inside each group.
 * @param {readonly { provider: string, model: string }[]} candidates
 * @param {'understand' | 'generate' | 'reason'} intent
 */
export function orderCandidates(candidates, intent) {
  const list = Array.isArray(candidates) ? [...candidates] : []
  if (intent === 'reason' || list.length <= 1) return list
  const preferred = []
  const rest = []
  for (const candidate of list) {
    const generator = looksLikeGenerator(candidate.model)
    const match = intent === 'generate' ? generator : !generator
    ;(match ? preferred : rest).push(candidate)
  }
  return preferred.length > 0 ? [...preferred, ...rest] : list
}
