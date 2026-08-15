import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerControlPlane } from '../plugin/control.js'

const apiKey = 'test-loopback-key'
const upstream = createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [
      { id: 'gpt-bad-model', owned_by: 'openai' },
      { id: 'gpt-good-model', owned_by: 'openai' },
    ] }))
    return
  }
  if (req.url === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    res.setHeader('content-type', 'application/json')
    if (body.model === 'gpt-bad-model') {
      res.statusCode = 503
      res.end(JSON.stringify({ error: { message: 'simulated provider outage' } }))
      return
    }
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'FALLBACK_OK' } }] }))
    return
  }
  if (req.url === '/v0/management/auth-files') {
    res.setHeader('content-type', 'application/json')
    res.end('{"files":[]}')
    return
  }
  res.statusCode = 404
  res.end()
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const routes = []
const webServer = {
  host: '127.0.0.1',
  port: 0,
  register(route) {
    routes.push(route)
    return () => routes.splice(routes.indexOf(route), 1)
  },
  tapIndex() { return () => {} },
}
const harness = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const route = routes.filter(row => pathname === row.path || pathname.startsWith(`${row.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (route === undefined) {
    res.statusCode = 404
    res.end()
    return
  }
  Promise.resolve(route.handler(req, res)).catch(error => {
    res.statusCode = 500
    res.end(String(error))
  })
})
await new Promise(resolve => harness.listen(0, '127.0.0.1', resolve))
webServer.port = harness.address().port

const temp = await mkdtemp(join(tmpdir(), 'dsh-cliapi-test-'))
const ctx = {
  webServer,
  logger: { info() {}, warn() {} },
  settings: {
    get: () => ({ providers: { 'cliproxy-codex': { models: [{ id: 'gpt-bad-model' }, { id: 'gpt-good-model' }] } } }),
    update: async () => {},
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'dsh-cliapi-auto', model: 'auto' }),
    saveSelection: async () => {},
  },
}

let dispose
try {
  dispose = await registerControlPlane(ctx, {
    host: '127.0.0.1',
    port: upstreamPort,
    apiKey,
    managementKey: 'test-management-key',
    autoConfigPath: join(temp, 'auto.json'),
    defaultAutoCandidates: ['gpt-bad-model', 'gpt-good-model'],
  })
  const response = await fetch(`http://127.0.0.1:${String(webServer.port)}/dsh-cliapi/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'test' }], stream: false }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-dsh-cliapi-model'), 'gpt-good-model')
  assert.equal(response.headers.get('x-dsh-cliapi-attempts'), '2')
  const body = await response.json()
  assert.equal(body.choices[0].message.content, 'FALLBACK_OK')
  console.log('AUTO_FAILOVER_OK')
} finally {
  await dispose?.()
  await Promise.all([
    new Promise(resolve => harness.close(resolve)),
    new Promise(resolve => upstream.close(resolve)),
  ])
  await rm(temp, { recursive: true, force: true })
}
