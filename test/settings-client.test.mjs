import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

test('package exposes a web settings client', async () => {
  const pkg = JSON.parse(await readFile(new URL('plugin/package.json', root), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
})

test('client registers a settings section and does not open a homepage browser FAB', async () => {
  const client = await readFile(new URL('plugin/client.js', root), 'utf8')
  const host = await readFile(new URL('plugin/control.js', root), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /settings\.section/)
  assert.match(client, /id: 'dsh-cliapi'/)
  assert.doesNotMatch(client, /settings\.plugins\.tab/)
  assert.doesNotMatch(client, /from ['"]node:/)
  assert.doesNotMatch(client, /require\(['"]node:/)
  assert.doesNotMatch(host, /tapIndex/)
  assert.doesNotMatch(host, /target="_blank"/)
})
