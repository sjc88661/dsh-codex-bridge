#!/usr/bin/env node
/**
 * Zero-dependency acceptance self-test for the dsh-codex-bridge plugin.
 *
 * Answers three questions Codex asks on every acceptance run:
 *   1. is the bridge alive and correctly configured?      -> health
 *   2. is the task journal present and intact?            -> journal
 *   3. can a task actually round-trip through a subagent? -> roundtrip
 *
 * Environment:
 *   DSH_BRIDGE_URL         default http://127.0.0.1:3080/dsh-codex-bridge
 *   DSH_BRIDGE_TOKEN       optional Bearer token, must match plugin config.apiToken
 *   DSH_BRIDGE_TIMEOUT_MS  per-request timeout, default 900000 (roundtrip runs a real task)
 *
 * Usage:
 *   node scripts/verify-bridge.mjs health
 *   node scripts/verify-bridge.mjs journal
 *   node scripts/verify-bridge.mjs roundtrip [--model <model>]
 *   node scripts/verify-bridge.mjs --help
 *
 * Exit codes: 0 all assertions passed, 1 any assertion failed, 2 usage error.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

const BASE = (process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3080/dsh-codex-bridge').replace(/\/+$/, '')
const TOKEN = process.env.DSH_BRIDGE_TOKEN || ''
const TIMEOUT_MS = Number(process.env.DSH_BRIDGE_TIMEOUT_MS || 900_000)
const SELFTEST = 'BRIDGE_SELFTEST_OK'

const USAGE = `dsh-codex-bridge acceptance self-test

Usage:
  node scripts/verify-bridge.mjs health
  node scripts/verify-bridge.mjs journal
  node scripts/verify-bridge.mjs roundtrip [--model <model>]
  node scripts/verify-bridge.mjs --help

Commands:
  health     GET /health — assert ok=true, the configured provider is registered,
             and a default agent model is set.
  journal    Read health.journalPath — assert the file exists and every line is valid JSON.
  roundtrip  Dispatch a minimal sync task whose only job is to reply "${SELFTEST}",
             then assert it completed with that marker in its output.

Env:
  DSH_BRIDGE_URL         default ${BASE}
  DSH_BRIDGE_TOKEN       optional Bearer token
  DSH_BRIDGE_TIMEOUT_MS  per-request timeout, default ${TIMEOUT_MS}

Exit codes: 0 pass, 1 assertion failed, 2 usage error.`

/** Trim a response body down to a single readable line for FAIL output. */
function snippet(text, limit = 300) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '(empty body)'
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * One HTTP call. Returns { ok, status, data, text }; network-level problems come back
 * as ok:false with status 0 so callers always report something readable instead of a stack.
 */
async function http(method, path, body) {
  const headers = {}
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error?.cause?.message ?? error?.message ?? String(error)
    const hint = error?.name === 'TimeoutError' ? ` (timed out after ${TIMEOUT_MS}ms)` : ''
    return { ok: false, status: 0, data: null, text: `cannot reach ${BASE}${path}: ${reason}${hint}` }
  }
  const text = await response.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { ok: response.ok, status: response.status, data, text }
}

/** Fetch /health or fail with a readable HTTP diagnosis. */
async function fetchHealth() {
  const res = await http('GET', '/health')
  if (!res.ok) {
    const detail = res.data?.error ? `error=${JSON.stringify(res.data.error)}` : snippet(res.text)
    const where = res.status === 0 ? '' : `HTTP ${res.status} `
    return { error: `${where}GET /health failed: ${detail}` }
  }
  if (res.data === null || typeof res.data !== 'object') {
    return { error: `GET /health returned non-JSON body: ${snippet(res.text)}` }
  }
  return { health: res.data }
}

function fail(reason) {
  console.log(`FAIL: ${reason}`)
  return 1
}

async function cmdHealth() {
  const { health, error } = await fetchHealth()
  if (error !== undefined) return fail(error)

  if (health.ok !== true) {
    return fail(`health.ok is ${JSON.stringify(health.ok)} (expected true) — bridge mounted but not ready; body=${snippet(JSON.stringify(health))}`)
  }

  const defaults = health.defaults ?? {}
  const provider = defaults.provider
  if (typeof provider !== 'string' || provider.trim() === '') {
    return fail(`health.defaults.provider is empty — no default subagent provider configured; body=${snippet(JSON.stringify(health))}`)
  }

  const providers = Array.isArray(health.providers) ? health.providers : []
  const names = providers.map(entry => entry?.name).filter(name => typeof name === 'string')
  if (!names.includes(provider)) {
    return fail(`defaults.provider "${provider}" is not registered — tasks would be rejected; registered=[${names.join(', ') || 'none'}]`)
  }

  const model = defaults.agentModel
  if (typeof model !== 'string' || model.trim() === '') {
    return fail(`health.defaults.agentModel is empty — no default model for dispatched subagents (source=${defaults.agentModelSource ?? 'unknown'})`)
  }

  console.log(`PASS version=${health.version ?? '(unknown)'} port=${health.port ?? '(unknown)'} provider=${provider} model=${model}`)
  return 0
}

async function cmdJournal() {
  const { health, error } = await fetchHealth()
  if (error !== undefined) return fail(error)

  const journalPath = health.journalPath
  if (typeof journalPath !== 'string' || journalPath.trim() === '') {
    return fail(`health.journalPath is empty — the bridge has no journal configured; body=${snippet(JSON.stringify(health))}`)
  }

  if (!existsSync(journalPath)) {
    return fail(`journal file does not exist: ${journalPath} (no task has been recorded yet, or journalPath points elsewhere)`)
  }
  let stat
  try {
    stat = statSync(journalPath)
  } catch (statError) {
    return fail(`cannot stat journal ${journalPath}: ${statError?.message ?? statError}`)
  }
  if (!stat.isFile()) return fail(`journal path is not a regular file: ${journalPath}`)

  let raw
  try {
    raw = readFileSync(journalPath, 'utf8')
  } catch (readError) {
    return fail(`cannot read journal ${journalPath}: ${readError?.message ?? readError}`)
  }

  const lines = raw.split('\n')
  let count = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    count += 1
    try {
      JSON.parse(line)
    } catch (parseError) {
      return fail(`journal line ${index + 1} is not valid JSON (${lines.length} lines scanned, ${count} JSON lines so far): ${parseError?.message ?? parseError} — line=${snippet(line, 200)}`)
    }
  }

  console.log(`PASS lines=${count} path=${journalPath}`)
  return 0
}

/** Minimal task: reply with the marker and touch nothing. */
const ROUNDTRIP_PROMPT = [
  `Reply with exactly ${SELFTEST} and nothing else.`,
  'Do not call any tools. Do not read or write files. Do not explain.',
].join(' ')

async function cmdRoundtrip(model) {
  const body = { prompt: ROUNDTRIP_PROMPT, label: 'bridge-selftest', mode: 'sync' }
  if (model !== undefined) body.agentOptions = { model }

  const startedAt = Date.now()
  const res = await http('POST', '/tasks', body)
  const elapsedMs = Date.now() - startedAt

  if (!res.ok) {
    const detail = res.data?.error ? `error=${JSON.stringify(res.data.error)}` : snippet(res.text)
    const extra = res.data === null ? '' : ` status=${JSON.stringify(res.data.status)}${res.data.stopReason ? ` stopReason=${JSON.stringify(res.data.stopReason)}` : ''}`
    const where = res.status === 0 ? '' : `HTTP ${res.status} `
    return fail(`${where}POST /tasks failed after ${elapsedMs}ms: ${detail}${extra}`)
  }

  const task = res.data
  if (task === null || typeof task !== 'object') {
    return fail(`POST /tasks returned non-JSON body after ${elapsedMs}ms: ${snippet(res.text)}`)
  }

  const id = task.id ?? '(no id)'
  if (task.status !== 'completed') {
    const detail = task.error ?? task.stopReason ?? 'no error reported'
    return fail(`task ${id} ended as status=${JSON.stringify(task.status)} after ${elapsedMs}ms: ${snippet(detail)}`)
  }

  const output = typeof task.output === 'string' ? task.output : ''
  if (!output.includes(SELFTEST)) {
    return fail(`task ${id} completed but output lacks ${SELFTEST} after ${elapsedMs}ms — output=${snippet(output) || '(empty)'}`)
  }

  console.log(`PASS ${id} ${elapsedMs}ms model=${model ?? task.agentOptions?.model ?? 'default'} output=${snippet(output, 80)}`)
  return 0
}

/** Parse `--model <m>` / `--model=<m>`; anything else is a usage error. */
function parseArgs(args) {
  let model
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--model') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: '--model requires a value' }
      model = value
      i += 1
      continue
    }
    if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length)
      if (value === '') return { error: '--model requires a value' }
      model = value
      continue
    }
    return { error: `unknown argument: ${arg}` }
  }
  return { model }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return 0
  }

  const { model, error: argError } = parseArgs(rest)
  if (argError !== undefined) {
    console.error(`FAIL: ${argError}`)
    console.error(USAGE)
    return 2
  }

  switch (command) {
    case 'health':
      if (model !== undefined) return usageError('health takes no arguments')
      return cmdHealth()
    case 'journal':
      if (model !== undefined) return usageError('journal takes no arguments')
      return cmdJournal()
    case 'roundtrip':
      return cmdRoundtrip(model)
    default:
      return usageError(`unknown command: ${command}`)
  }

  function usageError(message) {
    console.error(`FAIL: ${message}`)
    console.error(USAGE)
    return 2
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    // Last-resort guard: report readably rather than dumping a stack.
    console.log(`FAIL: unexpected error: ${error?.message ?? error}`)
    process.exitCode = 1
  })
