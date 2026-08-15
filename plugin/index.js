import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROXY_CREDENTIAL_REF, registerControlPlane } from './control.js'

export const name = 'dsh-cliapi'
export const inject = ['webServer', 'agentDefaultModel', 'settings', 'llm', 'credentials']

const MAX_DIAGNOSTIC_BYTES = 16 * 1024
const NATIVE_AUTO_PROVIDER = 'dsh-cliapi-auto-native'
const LEGACY_AUTO_PROVIDER = 'dsh-cliapi-auto'

function requireText(config, key) {
  const value = config?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-cliapi: config.${key} must be a non-empty string`)
  }
  return value
}

function optionalText(config, key, fallback) {
  const value = config?.[key] ?? fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dsh-cliapi: config.${key} must be a non-empty string`)
  }
  return value.trim()
}

async function resolveRuntimeConfig(config) {
  const dshHome = optionalText(config, 'dshHome', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const executable = optionalText(config, 'executable', join(dshHome, 'cliproxyapi', 'bin', 'cli-proxy-api'))
  const configPath = optionalText(config, 'configPath', join(dshHome, 'cliproxyapi', 'config.yaml'))
  const autoConfigPath = optionalText(config, 'autoConfigPath', join(dshHome, 'cliproxyapi', 'dsh-cliapi.json'))
  const secretsPath = optionalText(config, 'secretsPath', join(dshHome, 'cliproxyapi', 'plugin-secrets.json'))
  let apiKey = typeof config?.apiKey === 'string' ? config.apiKey.trim() : ''
  let managementKey = typeof config?.managementKey === 'string' ? config.managementKey.trim() : ''
  if (apiKey === '' || managementKey === '') {
    let secrets
    try {
      secrets = JSON.parse(await readFile(secretsPath, 'utf8'))
    } catch (error) {
      throw new Error(`dsh-cliapi: cannot read ${secretsPath}; run the official installer again (${String(error)})`)
    }
    if (apiKey === '') apiKey = requireText(secrets, 'apiKey')
    if (managementKey === '') managementKey = requireText(secrets, 'managementKey')
  }
  return { executable, configPath, autoConfigPath, apiKey, managementKey }
}

function positiveInteger(config, key, fallback) {
  const value = config?.[key] ?? fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`dsh-cliapi: config.${key} must be a positive integer`)
  }
  return value
}

function canConnect(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPort(host, port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`CLIProxyAPI exited before becoming ready (exit=${String(child.exitCode)}, signal=${String(child.signalCode)})`)
    }
    if (await canConnect(host, port)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`CLIProxyAPI did not listen on ${host}:${String(port)} within ${String(timeoutMs)} ms`)
}

async function stopProcess(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit').then(() => true, () => true)
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    exited,
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
  ])
  if (graceful) return
  child.kill('SIGKILL')
  await exited
}

export function apply(ctx, config = {}) {
  const host = config.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new TypeError('dsh-cliapi: config.host must be a loopback host')
  }
  const port = positiveInteger(config, 'port', 8317)
  const startupTimeoutMs = positiveInteger(config, 'startupTimeoutMs', 15_000)
  const shutdownTimeoutMs = positiveInteger(config, 'shutdownTimeoutMs', 5_000)
  const defaultAutoCandidates = Array.isArray(config.defaultAutoCandidates)
    ? config.defaultAutoCandidates.filter(value => (
      (typeof value === 'string' && value.trim() !== '')
      || (value !== null && typeof value === 'object' && !Array.isArray(value))
    )).slice(0, 12)
    : []
  const configuredPreferredProvider = typeof config.preferredProvider === 'string' && config.preferredProvider.trim() !== ''
    ? config.preferredProvider.trim()
    : NATIVE_AUTO_PROVIDER
  const preferredProvider = configuredPreferredProvider === LEGACY_AUTO_PROVIDER
    ? NATIVE_AUTO_PROVIDER
    : configuredPreferredProvider

  // The Harness catalog follows LLM registration order. Dynamic settings
  // routes register after the native adapter, so give this plugin-owned route
  // an explicit presentation priority without changing dispatch semantics.
  ctx.effect(() => {
    const runtime = ctx.llm
    const hadOwn = Object.prototype.hasOwnProperty.call(runtime, 'listProviders')
    const original = runtime.listProviders
    const prioritized = function () {
      return original.call(this).filter(provider => provider.id !== LEGACY_AUTO_PROVIDER).sort((left, right) => {
        if (left.id === preferredProvider) return right.id === preferredProvider ? 0 : -1
        if (right.id === preferredProvider) return 1
        return 0
      })
    }
    runtime.listProviders = prioritized
    return () => {
      if (runtime.listProviders !== prioritized) return
      if (hadOwn) runtime.listProviders = original
      else delete runtime.listProviders
    }
  }, 'dsh-cliapi.provider-priority')

  ctx.effect(async () => {
    const { executable, configPath, autoConfigPath, apiKey, managementKey } = await resolveRuntimeConfig(config)
    await Promise.all([access(executable), access(configPath)])
    if (await canConnect(host, port)) {
      throw new Error(`dsh-cliapi: ${host}:${String(port)} is already in use`)
    }

    const child = spawn(executable, ['--config', configPath], {
      cwd: dirname(configPath),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostic = ''
    const remember = (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_BYTES)
    }
    child.stdout?.on('data', remember)
    child.stderr?.on('data', remember)

    try {
      await waitForPort(host, port, startupTimeoutMs, child)
    } catch (error) {
      await stopProcess(child, shutdownTimeoutMs)
      const detail = diagnostic.trim()
      throw new Error(`dsh-cliapi: startup failed: ${String(error)}${detail ? `\n${detail}` : ''}`)
    }

    let disposeControlPlane
    try {
      // llm-pi-ai resolves named credentials through Harness on every request;
      // writing through the official service keeps the proxy key durable,
      // owner-only, hot-reloadable, and separate from the plugin manifest.
      await ctx.credentials.set(PROXY_CREDENTIAL_REF, apiKey)
      disposeControlPlane = await registerControlPlane(ctx, {
        host,
        port,
        apiKey,
        managementKey,
        autoConfigPath,
        defaultAutoCandidates,
      })
    } catch (error) {
      await stopProcess(child, shutdownTimeoutMs)
      throw error
    }
    ctx.logger.info('DSH_CLIAPI ready at http://%s:%d/dsh-cliapi', ctx.webServer.host, ctx.webServer.port)

    return async () => {
      try {
        await disposeControlPlane()
      } finally {
        await stopProcess(child, shutdownTimeoutMs)
      }
      ctx.logger.info('DSH_CLIAPI stopped')
    }
  }, 'dsh-cliapi.runtime')
}
