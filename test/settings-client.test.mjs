import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

test('package exposes a web settings client', async () => {
  const pkg = JSON.parse(await readFile(new URL('plugin/package.json', root), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.version, '0.5.0')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-settings'], '>=0.1.0-rc.8 <0.2.0')
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'))
})

test('client registers one unified settings section with two internal tabs', async () => {
  const client = await readFile(new URL('plugin/client.js', root), 'utf8')
  const host = await readFile(new URL('plugin/control.js', root), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /settings\.section/)
  assert.match(client, /id: 'dsh-cliapi'/)
  assert.match(client, /label: \(\) => '模型与授权'/)
  assert.match(client, /role: 'tab'/)
  assert.match(client, /label: '授权与 Auto'/)
  assert.match(client, /label: '多模态调度'/)
  assert.match(client, /\/dshllm-api\/api/)
  assert.doesNotMatch(client, /id: 'dshllm-api'/)
  assert.doesNotMatch(client, /settings\.plugins\.tab/)
  assert.doesNotMatch(client, /from ['"]node:/)
  assert.doesNotMatch(client, /require\(['"]node:/)
  assert.doesNotMatch(host, /tapIndex/)
  assert.doesNotMatch(host, /target="_blank"/)
})

test('host merges multimodal routing while preserving the legacy API and provider ids', async () => {
  const [index, control, classify] = await Promise.all([
    readFile(new URL('plugin/index.js', root), 'utf8'),
    readFile(new URL('plugin/llm-control.js', root), 'utf8'),
    readFile(new URL('plugin/llm-classify.js', root), 'utf8'),
  ])
  assert.match(index, /registerLlmControlPlane/)
  assert.match(index, /routerConfigPath/)
  assert.match(control, /PANEL_PATH = '\/dshllm-api'/)
  assert.match(classify, /AUTO_PROVIDER = 'dshllm-api'/)
})
