import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const fields = new Set(['url', 'workspace', 'provider', 'model', 'agentProvider', 'mode', 'maxDepth', 'timeoutMs'])
const defaultUrl = 'http://127.0.0.1:3080/dsh-codex-bridge'
const maxTimer = 2147483647

export function validateBridgeUrl(value, label = 'bridge URL') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty URL`)
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} must be a valid loopback HTTP(S) URL`) }
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host) && host.split('.').slice(1).every(n => Number(n) <= 255)
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error(`${label} must use HTTP(S) on localhost, 127.0.0.0/8, or ::1 without credentials, query, or fragment`)
  }
  return url.toString().replace(/\/+$/, '')
}

export function findConfig(cwd = process.cwd()) {
  let dir = resolve(cwd)
  for (;;) {
    const candidate = resolve(dir, 'dsh-bridge.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readConfig(path) {
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`config file does not exist: ${path}`)
    if (error instanceof SyntaxError) throw new Error(`config file contains invalid JSON: ${path}`)
    throw new Error(`cannot read config file: ${path}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`config must be a JSON object: ${path}`)
  for (const key of Object.keys(parsed)) if (!fields.has(key)) throw new Error(`unsupported config field: ${key}`)
  for (const key of ['url', 'workspace', 'provider', 'model', 'agentProvider', 'mode']) {
    if (key in parsed && (typeof parsed[key] !== 'string' || !parsed[key].trim())) throw new Error(`config field ${key} must be a non-empty string`)
  }
  if (parsed.mode !== undefined && !['sync', 'async'].includes(parsed.mode)) throw new Error('config field mode must be sync or async')
  if (parsed.maxDepth !== undefined && (!Number.isSafeInteger(parsed.maxDepth) || parsed.maxDepth < 0)) throw new Error('config field maxDepth must be a non-negative safe integer')
  if (parsed.timeoutMs !== undefined && (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1 || parsed.timeoutMs > maxTimer)) throw new Error(`config field timeoutMs must be an integer from 1 to ${maxTimer}`)
  return parsed
}

export function loadRuntimeConfig({ configPath, cwd = process.cwd(), env = process.env } = {}) {
  const chosenPath = configPath ? resolve(cwd, configPath) : findConfig(cwd)
  const fileConfig = chosenPath ? readConfig(chosenPath) : {}
  const fileUrl = fileConfig.url === undefined ? undefined : validateBridgeUrl(fileConfig.url, 'config url')
  const envUrl = env.DSH_BRIDGE_URL
  const effectiveEnvUrl = envUrl === undefined ? undefined : validateBridgeUrl(envUrl, 'DSH_BRIDGE_URL')
  const url = effectiveEnvUrl ?? fileUrl ?? defaultUrl
  let timeoutMs = fileConfig.timeoutMs
  if (env.DSH_BRIDGE_TIMEOUT_MS !== undefined) {
    if (!/^[0-9]+$/.test(env.DSH_BRIDGE_TIMEOUT_MS)) throw new Error(`DSH_BRIDGE_TIMEOUT_MS must be an integer from 1 to ${maxTimer}`)
    timeoutMs = Number(env.DSH_BRIDGE_TIMEOUT_MS)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimer) throw new Error(`DSH_BRIDGE_TIMEOUT_MS must be an integer from 1 to ${maxTimer}`)
  }
  const runtime = {
    url, token: env.DSH_BRIDGE_TOKEN || '', timeoutMs: timeoutMs ?? 660000,
    configPath: chosenPath,
    workspace: fileConfig.workspace ? resolve(dirname(chosenPath), fileConfig.workspace) : undefined,
    provider: fileConfig.provider,
    mode: fileConfig.mode,
    maxDepth: fileConfig.maxDepth,
    agentOptions: {
      ...(fileConfig.agentProvider ? { provider: fileConfig.agentProvider } : {}),
      ...(fileConfig.model ? { model: fileConfig.model } : {}),
    },
  }
  return runtime
}
