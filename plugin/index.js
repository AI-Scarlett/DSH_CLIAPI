import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { registerControlPlane } from './control.js'

export const name = 'dsh-cliapi'
export const inject = ['webServer', 'agentDefaultModel', 'settings', 'llm']

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
  const executable = requireText(config, 'executable')
  const configPath = requireText(config, 'configPath')
  const apiKey = requireText(config, 'apiKey')
  const managementKey = requireText(config, 'managementKey')
  const autoConfigPath = requireText(config, 'autoConfigPath')
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
      await disposeControlPlane()
      await stopProcess(child, shutdownTimeoutMs)
      ctx.logger.info('DSH_CLIAPI stopped')
    }
  }, 'dsh-cliapi.runtime')
}
