#!/usr/bin/env node
/** Codex-side client for the dsh-codex-bridge plugin. */
import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntimeConfig } from './client/config.mjs'
import { initialize } from './client/init.mjs'

const DEFAULT_TIMEOUT_MS = 660000
const MAX_TIMER_MS = 2147483647
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const TASK_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
const COMMAND_FLAGS = {
  doctor: [], health: [], providers: [], stats: [], init: ['dir'],
  submit: ['prompt', 'prompt-file', 'label', 'mode', 'provider', 'model', 'agent-provider', 'workspace', 'external-id', 'labels', 'max-depth', 'persona'],
  wait: ['timeout-ms'], status: ['wait-ms'],
  list: ['status', 'external-id', 'label', 'limit'], cancel: [], batch: ['file'],
}

class UsageError extends Error {}

const baseUrl = runtime => runtime?.url ?? process.env.DSH_BRIDGE_URL ?? 'http://127.0.0.1:3080/dsh-codex-bridge'
const token = runtime => runtime?.token ?? process.env.DSH_BRIDGE_TOKEN ?? ''
function safeBaseUrl(runtime) { return baseUrl(runtime) }

function timeoutConfig(runtime = {}) {
  if (runtime.timeoutMs !== undefined) return runtime.timeoutMs
  const raw = process.env.DSH_BRIDGE_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new UsageError(`DSH_BRIDGE_TIMEOUT_MS must be a positive integer no greater than ${MAX_TIMER_MS}`)
  }
  return value
}

function parseArgs(args) {
  const flags = Object.create(null)
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-h' || arg === '--help') { flags.help = true; continue }
    if (arg.startsWith('-') && !arg.startsWith('--')) throw new UsageError(`unknown option: ${arg}`)
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    const key = arg.slice(2, eq < 0 ? undefined : eq)
    if (!key || Object.hasOwn(flags, key)) throw new UsageError(`invalid or repeated option: ${arg}`)
    if (eq >= 0) {
      flags[key] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next === undefined || next.startsWith('-')) throw new UsageError(`option --${key} requires a value`)
    flags[key] = next
    i += 1
  }
  return { flags, positional }
}

function parseInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new UsageError(`--${name} must be an integer`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}`)
  return number
}

function requiredValue(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`--${name} requires a non-empty value`)
  return value
}

function validateArgs(cmd, flags, positional) {
  if (!cmd) return
  if (!Object.hasOwn(COMMAND_FLAGS, cmd)) throw new UsageError(`unknown command: ${cmd}`)
  const allowed = new Set([...COMMAND_FLAGS[cmd], 'help'])
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new UsageError(`unknown option for ${cmd}: --${name}`)
  if (flags.help) return
  const exactPositionals = { wait: 1, status: 1, cancel: 1 }
  if (Object.hasOwn(exactPositionals, cmd)) {
    if (positional.length !== exactPositionals[cmd] || !positional[0].trim()) throw new UsageError(`${cmd} requires exactly one task id`)
  } else if (cmd === 'submit') {
    const sources = Number(positional.length > 0) + Number(Object.hasOwn(flags, 'prompt')) + Number(Object.hasOwn(flags, 'prompt-file'))
    if (sources > 1) throw new UsageError('use only one prompt source: positional prompt, --prompt, or --prompt-file')
    if (Object.hasOwn(flags, 'prompt-file')) requiredValue(flags, 'prompt-file')
  } else if (positional.length) throw new UsageError(`${cmd} does not accept positional arguments`)

  if (cmd === 'submit') {
    for (const name of ['label', 'provider', 'model', 'agent-provider', 'workspace', 'external-id', 'labels', 'persona']) {
      if (Object.hasOwn(flags, name)) requiredValue(flags, name)
    }
    if (Object.hasOwn(flags, 'mode') && !['sync', 'async'].includes(flags.mode)) throw new UsageError('--mode must be sync or async')
    if (Object.hasOwn(flags, 'max-depth')) parseInteger(flags['max-depth'], 'max-depth')
    if (Object.hasOwn(flags, 'labels') && !flags.labels.split(',').some(x => x.trim())) throw new UsageError('--labels must contain at least one label')
  }
  if (cmd === 'wait' && Object.hasOwn(flags, 'timeout-ms')) parseInteger(flags['timeout-ms'], 'timeout-ms', { min: 1 })
  if (cmd === 'status' && Object.hasOwn(flags, 'wait-ms')) parseInteger(flags['wait-ms'], 'wait-ms')
  if (cmd === 'list' && Object.hasOwn(flags, 'limit')) parseInteger(flags.limit, 'limit', { min: 1 })
  if (cmd === 'list') {
    for (const name of ['status', 'external-id', 'label']) if (Object.hasOwn(flags, name)) requiredValue(flags, name)
    if (Object.hasOwn(flags, 'status') && !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(flags.status)) {
      throw new UsageError('--status must be queued, running, completed, failed, cancelled, or interrupted')
    }
  }
  if (cmd === 'batch') requiredValue(flags, 'file')
}

function help(cmd, runtime) {
  const common = `Usage:
  dsh-dispatch doctor | health | providers | stats
  dsh-dispatch init [--dir <path>]
  dsh-dispatch submit <prompt> [--prompt <text> | --prompt-file <path>] [--label <label>] [--mode sync|async] [--provider <p>]
        [--model <m>] [--agent-provider <p>] [--workspace <dir>] [--external-id <id>] [--labels a,b] [--max-depth <n>] [--persona <text>]
  dsh-dispatch wait <task-id> [--timeout-ms <n>]
  dsh-dispatch status <task-id> [--wait-ms <n>]
  dsh-dispatch list [--status <s>] [--external-id <id>] [--label <l>] [--limit <n>]
  dsh-dispatch cancel <task-id>
  dsh-dispatch batch --file <tasks.json>
  dsh-dispatch --version
  Global: [--config <path>] may appear before or after the command

Environment: DSH_BRIDGE_URL (default ${safeBaseUrl(runtime)}), DSH_BRIDGE_TOKEN, DSH_BRIDGE_TIMEOUT_MS (default ${DEFAULT_TIMEOUT_MS})`
  if (!cmd || cmd === 'help') return common
  const perCommand = {
    doctor: 'doctor: check bridge and provider readiness', health: 'health: print bridge health', providers: 'providers: list registered providers', stats: 'stats: print task counts',
    submit: 'submit: allocate a task; --agent-provider and --model configure agentOptions',
    wait: 'wait: poll a task until terminal state or --timeout-ms expires', status: 'status: read task status; --wait-ms optionally waits for a change',
    list: 'list: query tasks', cancel: 'cancel: request task cancellation', batch: 'batch: submit an array of { prompt } objects',
  }
  return `${perCommand[cmd]}\n\n${common}`
}

function safeText(value, runtime = {}) {
  let message = String(value)
  const secret = token(runtime)
  if (secret) {
    message = message.split(secret).join('[redacted]')
    const jsonEscapedSecret = JSON.stringify(secret).slice(1, -1)
    if (jsonEscapedSecret !== secret) message = message.split(jsonEscapedSecret).join('[redacted]')
  }
  message = message.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
  return message
}

function safeMessage(error, runtime) { return safeText(error?.message ?? error, runtime) }

function logFor(runtime, ...values) { console.log(...values.map(value => safeText(value, runtime))) }
function diagnoseFor(runtime, ...values) { console.error(...values.map(value => safeText(value, runtime))) }
function print(data, runtime) {
  const json = JSON.stringify(data, (_key, value) => typeof value === 'string' ? safeText(value, runtime) : value, 2)
  console.log(safeText(json, runtime))
}

async function request(method, path, body, { timeoutMs, runtime = {} } = {}) {
  timeoutMs ??= timeoutConfig(runtime)
  const headers = { 'content-type': 'application/json' }
  if (token(runtime)) headers.authorization = `Bearer ${token(runtime)}`
  let res
  try {
    res = await fetch(baseUrl(runtime) + path, {
      method, headers, signal: AbortSignal.timeout(timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok && res.status !== 202) {
      const description = data && typeof data === 'object' ? JSON.stringify(data) : String(data ?? res.statusText)
      const error = new Error(`HTTP ${res.status}: ${description}`)
      error.status = res.status
      error.data = data
      throw error
    }
    return data
  } catch (error) {
    if (error?.status) throw error
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs} ms`)
    throw new Error(`request failed: ${safeMessage(error, runtime)}`)
  }
}

function taskBody(flags, prompt, runtime = {}) {
  const body = { prompt }
  for (const [flag, field] of [['label', 'label'], ['mode', 'mode'], ['provider', 'provider'], ['workspace', 'workspace'], ['external-id', 'externalId'], ['persona', 'persona']]) {
    if (Object.hasOwn(flags, flag)) body[field] = flags[flag]
  }
  if (Object.hasOwn(flags, 'labels')) body.labels = flags.labels.split(',').map(s => s.trim()).filter(Boolean)
  if (!Object.hasOwn(flags, 'workspace') && runtime.workspace) body.workspace = runtime.workspace
  if (!Object.hasOwn(flags, 'mode') && runtime.mode) body.mode = runtime.mode
  if (!Object.hasOwn(flags, 'provider') && runtime.provider) body.provider = runtime.provider
  if (Object.hasOwn(flags, 'max-depth')) body.maxDepth = parseInteger(flags['max-depth'], 'max-depth')
  else if (runtime.maxDepth !== undefined) body.maxDepth = runtime.maxDepth
  const agentOptions = { ...(runtime.agentOptions ?? {}) }
  if (Object.hasOwn(flags, 'agent-provider')) agentOptions.provider = flags['agent-provider']
  if (Object.hasOwn(flags, 'model')) agentOptions.model = flags.model
  if (Object.keys(agentOptions).length) body.agentOptions = agentOptions
  return body
}

async function waitForTask(id, timeoutMs, runtime) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return { timedOut: true }
    let task
    try {
      const requestTimeout = Math.max(1, Math.floor(Math.min(timeoutConfig(runtime), remaining)))
      task = await request('GET', `/tasks/${encodeURIComponent(id)}`, undefined, { timeoutMs: requestTimeout, runtime })
    }
    catch (error) {
      if (/^request timed out after/.test(error.message)) {
        return { timedOut: true, requestTimedOut: deadline - performance.now() > 0 }
      }
      throw error
    }
    if (!isValidTask(task) || task.id !== id) throw new Error(`wait returned a malformed task response for ${id}`)
    if (TERMINAL.has(task.status)) return { task }
    const afterFetch = deadline - performance.now()
    if (afterFetch <= 0) return { timedOut: true }
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(1000, afterFetch)))
  }
}

function reportOutcome(task, runtime) {
  if (task?.status === 'completed') return 0
  diagnoseFor(runtime, `task ${task?.id ?? '(unknown)'} ended as ${task?.status ?? 'unknown'}${task?.error ? `: ${task.error}` : ''}`)
  return 1
}

function isValidTask(task) {
  return Boolean(task && typeof task === 'object' && !Array.isArray(task) &&
    typeof task.id === 'string' && task.id.trim() && TASK_STATUSES.has(task.status))
}

function validBatchResponse(result, submittedCount) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true ||
    !Array.isArray(result.ids) || result.ids.length === 0 ||
    !result.ids.every(id => typeof id === 'string' && id.trim()) || new Set(result.ids).size !== result.ids.length ||
    !Number.isSafeInteger(result.count) || result.count <= 0 || result.count !== result.ids.length ||
    !Array.isArray(result.tasks) || result.tasks.length !== result.count ||
    (result.rejected !== undefined && !Array.isArray(result.rejected))) return false
  if (!result.tasks.every((task, index) => task && typeof task === 'object' && !Array.isArray(task) &&
    task.id === result.ids[index] && typeof task.workspace === 'string' && task.workspace.trim())) return false
  const rejected = result.rejected ?? []
  if (result.count + rejected.length !== submittedCount) return false
  const indices = new Set()
  for (const item of rejected) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.index) ||
      item.index < 0 || item.index >= submittedCount || typeof item.error !== 'string' || !item.error.trim() || indices.has(item.index)) return false
    indices.add(item.index)
  }
  return true
}

function validateBatchFile(file, runtime) {
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { throw new UsageError(`cannot read/parse batch file: ${safeMessage(error, runtime)}`) }
  const tasks = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.tasks : undefined
  if (!Array.isArray(tasks) || tasks.length === 0) throw new UsageError('batch file must contain a non-empty JSON array or { tasks: [...] }')
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i]
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.prompt !== 'string' || !task.prompt.trim()) {
      throw new UsageError(`batch task at index ${i} must be an object with a non-empty prompt`)
    }
  }
  return tasks
}

function doctorReady(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health) || health.ok !== true || health.journalReady !== true) return false
  if (!health.defaults || typeof health.defaults !== 'object' || Array.isArray(health.defaults)) return false
  if (typeof health.defaults.provider !== 'string' || !health.defaults.provider.trim()) return false
  if (typeof health.defaults.agentModel !== 'string' || !health.defaults.agentModel.trim()) return false
  if (!Array.isArray(health.providers)) return false
  const provider = health.providers.find(p => p && typeof p === 'object' && !Array.isArray(p) && p.name === health.defaults.provider)
  return Boolean(provider && provider.acceptsAgentOptions === true)
}

export function isDirectExecution(argvPath, modulePath = fileURLToPath(import.meta.url)) {
  if (!argvPath) return false
  try { return realpathSync(resolve(argvPath)) === realpathSync(modulePath) }
  catch { return resolve(argvPath) === resolve(modulePath) }
}

export async function main(args = process.argv.slice(2)) {
  const environment = { ...process.env }
  const earlyRuntime = { token: environment.DSH_BRIDGE_TOKEN ?? '', url: environment.DSH_BRIDGE_URL ?? 'http://127.0.0.1:3080/dsh-codex-bridge' }
  let configPath
  const stripped = []
  try {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--config' || arg.startsWith('--config=')) {
        if (configPath !== undefined) throw new UsageError('repeated option: --config')
        const value = arg === '--config' ? args[++i] : arg.slice('--config='.length)
        if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new UsageError('--config requires a non-empty path')
        configPath = value
      } else stripped.push(arg)
    }
  } catch (error) { diagnoseFor(earlyRuntime, error.message); return 2 }
  if (stripped.includes('--version') || stripped.includes('-v')) {
    if (stripped.length !== 1) { diagnoseFor(earlyRuntime, '--version cannot be combined with other arguments'); return 2 }
    const packageJson = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    logFor(earlyRuntime, packageJson.version); return 0
  }
  const [cmd, ...rest] = stripped
  if (stripped.length === 0 || cmd === 'help' || cmd === '-h' || cmd === '--help') { logFor(earlyRuntime, help(undefined, earlyRuntime)); return 0 }
  let parsed
  try {
    parsed = parseArgs(rest)
    if (cmd === 'init' && Object.hasOwn(parsed.flags, 'dir')) requiredValue(parsed.flags, 'dir')
    validateArgs(cmd, parsed.flags, parsed.positional)
  }
  catch (error) { if (error instanceof UsageError) { diagnoseFor(earlyRuntime, error.message); diagnoseFor(earlyRuntime, help(undefined, earlyRuntime)); return 2 } throw error }
  const { flags, positional } = parsed
  if (flags.help) { logFor(earlyRuntime, help(cmd, earlyRuntime)); return 0 }
  if (cmd === 'init') {
    try {
      const result = await initialize(flags.dir ?? process.cwd())
      logFor(earlyRuntime, JSON.stringify(result, null, 2))
      logFor(earlyRuntime, 'Reference AGENTS.dsh.md from your existing AGENTS.md; it is not auto-detected.')
      return 0
    } catch (error) { diagnoseFor(earlyRuntime, `init failed: ${safeMessage(error, earlyRuntime)}`); return 1 }
  }
  let runtime
  try {
    runtime = loadRuntimeConfig({ configPath, env: environment })
    if (Object.hasOwn(flags, 'workspace')) {
      flags.workspace = resolve(process.cwd(), flags.workspace)
      runtime.workspace = flags.workspace
    }
    runtime.clientVersion = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version
  } catch (error) { diagnoseFor(earlyRuntime, error.message); return 2 }
  const defaultTimeout = timeoutConfig(runtime)

  try {
    switch (cmd) {
      case 'health': print(await request('GET', '/health', undefined, { timeoutMs: defaultTimeout, runtime }), runtime); return 0
      case 'providers': print(await request('GET', '/providers', undefined, { timeoutMs: defaultTimeout, runtime }), runtime); return 0
      case 'stats': print(await request('GET', '/stats', undefined, { timeoutMs: defaultTimeout, runtime }), runtime); return 0
      case 'doctor': {
        logFor(runtime, `client version: ${runtime.clientVersion}`)
        logFor(runtime, `config:      ${runtime.configPath ?? '(none found)'}`)
        logFor(runtime, `effective workspace: ${runtime.workspace ?? '(server default)'}`)
        logFor(runtime, `bridge URL: ${safeBaseUrl(runtime)}`)
        logFor(runtime, `token:      ${token(runtime) ? 'set' : '(none)'}`)
        let health
        try { health = await request('GET', '/health', undefined, { timeoutMs: defaultTimeout, runtime }) }
        catch (error) {
          diagnoseFor(runtime, `FAILED: ${safeMessage(error, runtime)}`)
          diagnoseFor(runtime, 'hint: the DSH instance hosting the bridge is not running, or the plugin is not mounted.')
          return 1
        }
        const providers = Array.isArray(health?.providers) ? health.providers : []
        const defaults = health?.defaults && typeof health.defaults === 'object' ? health.defaults : {}
        const registered = providers.find(p => p?.name === defaults.provider)
        logFor(runtime, `ok:         ${health?.ok === true}`)
        logFor(runtime, `version:    ${health?.version}  prefix=${health?.pathPrefix}  port=${health?.port}`)
        logFor(runtime, `auth:       ${health?.authRequired ? 'token required' : 'open on loopback'}`)
        logFor(runtime, `workspace:  ${defaults.workspace}`)
        logFor(runtime, `provider:   ${defaults.provider}  (agentOptions accepted: ${registered?.acceptsAgentOptions ?? 'unknown'})`)
        logFor(runtime, `configured default model: ${defaults.agentModel ?? '(unset)'}  [source: ${defaults.agentModelSource}]`)
        logFor(runtime, `mode:       ${defaults.defaultMode}  maxConcurrent=${defaults.maxConcurrent}  maxDepth=${defaults.maxDepth}`)
        logFor(runtime, `journal:    ${health?.journalPath}  (ready: ${health?.journalReady})`)
        logFor(runtime, 'providers:')
        for (const provider of providers) logFor(runtime, `  - ${provider?.name ?? '(unknown)'}${provider?.acceptsAgentOptions === true ? '  [agentOptions]' : ''}`)
        logFor(runtime, `tasks:      ${JSON.stringify(health?.stats?.byStatus ?? {})}  running=${health?.stats?.running ?? 0} queued=${health?.stats?.queued ?? 0}`)
        if (!doctorReady(health)) {
          diagnoseFor(runtime, 'FAILED: bridge readiness checks did not pass (provider, agentOptions, configured default model, journal, or health state).')
          return 1
        }
        return 0
      }
      case 'submit': {
        let prompt
        try {
          prompt = Object.hasOwn(flags, 'prompt-file') ? readFileSync(flags['prompt-file'], 'utf8')
            : Object.hasOwn(flags, 'prompt') ? flags.prompt : positional.join(' ')
        } catch (error) { throw new UsageError(`cannot read prompt file: ${safeMessage(error, runtime)}`) }
        if (typeof prompt !== 'string' || !prompt.trim()) throw new UsageError('submit requires a non-empty prompt')
        const body = taskBody(flags, prompt, runtime)
        const result = await request('POST', '/tasks', body, { timeoutMs: defaultTimeout, runtime })
        print(result, runtime)
        if (!isValidTask(result)) {
          diagnoseFor(runtime, 'task response has an unexpected shape; inspect the service result before continuing.')
          return 1
        }
        if (result && TERMINAL.has(result.status)) return reportOutcome(result, runtime)
        if (result.status === 'queued' || result.status === 'running') return body.mode === 'sync' ? 1 : 0
        diagnoseFor(runtime, `task ${result.id} returned unexpected status ${result.status}`)
        return 1
      }
      case 'wait': {
        const timeoutMs = Object.hasOwn(flags, 'timeout-ms') ? parseInteger(flags['timeout-ms'], 'timeout-ms', { min: 1 }) : 600000
        const outcome = await waitForTask(positional[0], timeoutMs, runtime)
        if (outcome.timedOut) {
          const cause = outcome.requestTimedOut
            ? 'a wait request timed out before the overall wait budget expired'
            : `wait timed out after ${timeoutMs} ms`
          diagnoseFor(runtime, `${cause}; task ${positional[0]} may still be running. Use status or cancel to inspect it.`)
          return 1
        }
        print(outcome.task, runtime)
        return reportOutcome(outcome.task, runtime)
      }
      case 'status': {
        const waitMs = Object.hasOwn(flags, 'wait-ms') ? parseInteger(flags['wait-ms'], 'wait-ms') : 0
        const suffix = waitMs > 0 ? `?waitMs=${waitMs}` : ''
        print(await request('GET', `/tasks/${encodeURIComponent(positional[0])}${suffix}`, undefined, { timeoutMs: defaultTimeout, runtime }), runtime)
        return 0
      }
      case 'list': {
        const params = new URLSearchParams()
        for (const key of ['status', 'external-id', 'label', 'limit']) if (Object.hasOwn(flags, key)) params.set(key === 'external-id' ? 'externalId' : key, String(flags[key]))
        const query = params.toString()
        print(await request('GET', `/tasks${query ? `?${query}` : ''}`, undefined, { timeoutMs: defaultTimeout, runtime }), runtime)
        return 0
      }
      case 'cancel': print(await request('POST', `/tasks/${encodeURIComponent(positional[0])}/cancel`, undefined, { timeoutMs: defaultTimeout, runtime }), runtime); return 0
      case 'batch': {
        const file = resolve(process.cwd(), flags.file)
        const tasks = validateBatchFile(file, runtime).map(task => {
          const clone = { ...task }
          for (const key of ['workspace', 'cwd']) if (typeof clone[key] === 'string' && clone[key].trim()) clone[key] = resolve(dirname(file), clone[key])
          if (!Object.hasOwn(clone, 'workspace') && !Object.hasOwn(clone, 'cwd') && runtime.workspace) clone.workspace = runtime.workspace
          if (!Object.hasOwn(clone, 'provider') && runtime.provider) clone.provider = runtime.provider
          if (!Object.hasOwn(clone, 'maxDepth') && runtime.maxDepth !== undefined) clone.maxDepth = runtime.maxDepth
          clone.agentOptions = { ...(runtime.agentOptions ?? {}), ...(clone.agentOptions ?? {}) }
          if (!Object.keys(clone.agentOptions).length) delete clone.agentOptions
          clone.mode = 'async'
          return clone
        })
        const result = await request('POST', '/batch', { tasks }, { timeoutMs: defaultTimeout, runtime })
        print(result, runtime)
        if (!validBatchResponse(result, tasks.length)) {
          diagnoseFor(runtime, 'batch response has an unexpected shape; inspect the service result before retrying.')
          return 1
        }
        if ((result.rejected ?? []).length) {
          diagnoseFor(runtime, 'batch was partially rejected; do not retry the entire batch because accepted tasks may run more than once.')
          return 1
        }
        return 0
      }
      default: return 2
    }
  } catch (error) {
    if (error instanceof UsageError) { diagnoseFor(runtime, error.message); return 2 }
    diagnoseFor(runtime, safeMessage(error, runtime))
    return 1
  }
}

if (isDirectExecution(process.argv[1])) {
  main().then(code => { process.exitCode = code ?? 0 }).catch(error => {
    diagnoseFor(undefined, safeMessage(error))
    process.exitCode = error instanceof UsageError ? 2 : 1
  })
}
