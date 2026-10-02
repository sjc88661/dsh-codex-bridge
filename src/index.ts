/**
 * @dsh-external/dsh-codex-bridge — Codex ↔ DeepSeek Harness task dispatch bridge.
 *
 * DSH 侧：
 *  - 在 webServer 上挂一组本地 HTTP 路由（默认 /dsh-codex-bridge）。
 *  - 接收 Codex 提交的任务（单发 / 批量），通过 ctx.subagents 分派给 DSH 内部
 *    subagent（默认 spawn provider）。
 *  - 维护「每工作区一个」轻量 dispatcher Agent 作为 subagent 的 parent：子 agent 的
 *    cwd 继承自 parent 的 session cwd，所以并行任务要各自的工作目录，就必须各自
 *    有一个 dispatcher（见 ensureDispatcher）。
 *  - 任务台账写入 JSONL journal，进程重启后仍可查（运行中的任务标记 interrupted）。
 *
 * Codex 侧：
 *  - 仓库内附带 codex-dsh-client.mjs（全局命令 dsh-dispatch），Codex 直接
 *    `dsh-dispatch submit ...` 即可把任务交给 DSH 分配。
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import z from 'schemastery'

export const name = '@dsh-external/dsh-codex-bridge'
export const inject = ['webServer', 'subagents', 'agents']

/** 服务端版本，随 package.json 一起发布。 */
export const VERSION = '0.2.0'

export interface Config {
  /** HTTP 路由前缀。 */
  pathPrefix: string
  /** 可选 Bearer token；配置后所有请求必须带 Authorization: Bearer <token>。 */
  apiToken: string
  /** 默认 subagent provider 名（spawn / fork / codex / ...）。 */
  provider: string
  /** 默认工作目录；留空用 DSH 进程 cwd。任务可用 workspace 字段覆盖。 */
  workspace: string
  /** 允许的任务工作目录白名单（绝对路径前缀）；留空表示不限制。 */
  workspaceRoots: string[]
  /**
   * dispatcher 与子 agent 使用的 agent preset（决定子 agent 手里有哪些工具）。
   * 程序化创建的 agent 不会自动挂 preset，而 Web 类 profile 把 fs/shell 工具交给 preset
   * 挂载——留空会让子 agent 无工具可用；留空仅适用于自带工具平面的 profile。
   */
  agentPreset: string
  /** dispatcher Agent 的 provider；留空用 agentDefaultModel。 */
  agentProvider: string
  /** dispatcher Agent 的 model；留空用 agentDefaultModel。 */
  agentModel: string
  /** dispatcher Agent 的 maxTokens；0 表示不设置。 */
  maxTokens: number
  /** 默认子任务 maxDepth。 */
  maxDepth: number
  /** 默认提交模式：sync 等待结果，async 立即返回 task id。 */
  defaultMode: 'sync' | 'async'
  /** sync 模式的请求超时（毫秒）。 */
  requestTimeoutMs: number
  /** 同时运行的任务上限；超出部分排队（0 = 不限制）。 */
  maxConcurrent: number
  /** 任务台账 JSONL 路径；留空 = <默认工作目录>/.dsh-codex-bridge/tasks.jsonl。 */
  journalPath: string
  /** 内存中保留的已完成任务数上限（0 = 不限制）。 */
  keepTasks: number
}

export const Config = z.object({
  pathPrefix: z.string().default('/dsh-codex-bridge'),
  apiToken: z.string().default(''),
  provider: z.string().default('spawn'),
  workspace: z.string().default(''),
  workspaceRoots: z.array(z.string()).default([]),
  agentPreset: z.string().default('standard'),
  agentProvider: z.string().default(''),
  agentModel: z.string().default(''),
  maxTokens: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxDepth: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(3),
  defaultMode: z.union(['sync', 'async'] as const).default('async'),
  requestTimeoutMs: z.number().min(1000).default(600_000),
  maxConcurrent: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(3),
  journalPath: z.string().default(''),
  keepTasks: z.number().min(0).max(Number.MAX_SAFE_INTEGER).default(500),
})

type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

interface TaskRecord {
  id: string
  label: string
  /** 外部追踪器 id（例如 Beads issue id），仅用于关联与筛选。 */
  externalId?: string
  labels: string[]
  /** 提交时的任务正文（journal 中截断保存）。 */
  prompt: string
  provider: string
  agentOptions?: Record<string, unknown>
  /** 解析后的绝对工作目录，决定子 agent 的 cwd/沙箱根。 */
  workspace: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  output?: string
  structured?: unknown
  stopReason?: string
  error?: string
  runId?: string
  controller?: AbortController
}

interface QueueItem {
  task: TaskRecord
  body: Record<string, any>
}

const TERMINAL: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'interrupted']
const PROMPT_JOURNAL_LIMIT = 4000

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status)
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage, maxBytes = 2_000_000): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as any
}

/** 只允许本机回环访问；外部网络不可调用。 */
function isLoopback(request: IncomingMessage): boolean {
  const addr = request.socket.remoteAddress ?? ''
  return addr === '::1' || /^127(?:\.\d{1,3}){3}$/.test(addr) || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(addr)
}

function authorized(request: IncomingMessage, token: string): boolean {
  if (!token) return true
  const header = request.headers.authorization ?? ''
  return header === `Bearer ${token}`
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'] ?? ''
  return /^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)
}

function textFromBlocks(blocks: any[] | undefined): string {
  return (blocks ?? [])
    .filter((block: any) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('')
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      onTimeout()
      rejectPromise(new Error(`request timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      },
    )
  })
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function cleanLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
}

/**
 * 任务记录的可序列化投影。`controller` 是活对象，永远不进 journal 或 HTTP 响应；
 * `prompt` 在台账里截断保存，响应里只给预览。
 */
function taskToJson(task: TaskRecord, options: { prompt?: boolean } = {}): Record<string, unknown> {
  return {
    id: task.id,
    label: task.label,
    ...(task.externalId !== undefined ? { externalId: task.externalId } : {}),
    labels: task.labels,
    status: task.status,
    provider: task.provider,
    ...(task.agentOptions !== undefined ? { agentOptions: task.agentOptions } : {}),
    workspace: task.workspace,
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.startedAt !== undefined && task.finishedAt !== undefined
      ? { durationMs: task.finishedAt - task.startedAt }
      : {}),
    ...(options.prompt === true
      ? { prompt: task.prompt }
      : { promptPreview: task.prompt.slice(0, 200) }),
    output: task.output,
    structured: task.structured,
    stopReason: task.stopReason,
    error: task.error,
    runId: task.runId,
  }
}

interface JournalEvent {
  t: 'created' | 'started' | 'finished'
  at: number
  id: string
  task?: Record<string, unknown>
  status?: TaskStatus
  output?: string
  structured?: unknown
  stopReason?: string
  error?: string
  runId?: string
}

class CodexBridge {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly order: string[] = []
  /** 每个工作目录一个 dispatcher Agent：子 agent 的 cwd 继承自 parent session。 */
  private readonly dispatchers = new Map<string, Promise<any>>()
  private readonly queue: QueueItem[] = []
  private running = 0
  private journalReady = true
  /** 卸载中：此时被中止的任务记为 interrupted（基础设施打断），而不是 cancelled（人为取消）。 */
  private unloading = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  private get defaultWorkspace(): string {
    return this.config.workspace ? resolvePath(this.config.workspace) : process.cwd()
  }

  private get journalPath(): string {
    return this.config.journalPath
      ? resolvePath(this.config.journalPath)
      : join(this.defaultWorkspace, '.dsh-codex-bridge', 'tasks.jsonl')
  }

  start(): void {
    const ctxAny = this.ctx as any
    const prefix = this.config.pathPrefix.replace(/\/+$/, '')
    const disposer = ctxAny.webServer?.register({
      kind: 'prefix',
      path: prefix,
      handler: (request: IncomingMessage, response: ServerResponse) => {
        void this.handle(request, response)
      },
    })
    if (disposer === undefined) {
      throw new Error('dsh-codex-bridge: webServer.register unavailable')
    }
    this.ctx.effect(() => disposer, 'dsh-codex-bridge: http routes')
    this.ctx.effect(() => {
      return () => {
        this.unloading = true
        for (const pending of this.dispatchers.values()) {
          void pending.then(handle => handle?.dispose?.()).catch(() => {})
        }
        this.dispatchers.clear()
        // 运行中的任务活不过这次卸载（dispatcher 一销毁，子 agent 就没了），但台账必须
        // 区分「人为取消」与「桥接重载打断」：后者应原样重派，不计入返工。
        for (const task of this.tasks.values()) {
          if (!isTerminal(task.status)) task.controller?.abort('bridge reloaded while the task was running')
        }
      }
    }, 'dsh-codex-bridge: dispatcher agents')
    this.loadJournal()
  }

  // ── 台账 ────────────────────────────────────────────────────────────────────

  private appendJournal(event: JournalEvent): void {
    if (!this.journalReady) return
    try {
      const path = this.journalPath
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error: any) {
      this.journalReady = false
      this.ctx.logger?.warn?.(`[dsh-codex-bridge] journal disabled: ${error?.message ?? error}`)
    }
  }

  /** 折叠 JSONL：同 id 后写覆盖先写；未终结的任务标记为 interrupted。 */
  private loadJournal(): void {
    const path = this.journalPath
    if (!existsSync(path)) return
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const byId = new Map<string, TaskRecord>()
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      let event: JournalEvent
      try {
        event = JSON.parse(line) as JournalEvent
      } catch {
        continue // 半行（进程被杀）忽略
      }
      if (event.t === 'created' && event.task) {
        const record = event.task as unknown as TaskRecord
        byId.set(event.id, {
          ...record,
          labels: Array.isArray(record.labels) ? record.labels : [],
        })
      } else {
        const record = byId.get(event.id)
        if (record === undefined) continue
        if (event.t === 'started') {
          record.startedAt = event.at
          record.status = 'running'
        } else {
          record.status = event.status ?? record.status
          record.finishedAt = event.at
          if (event.output !== undefined) record.output = event.output
          if (event.structured !== undefined) record.structured = event.structured
          if (event.stopReason !== undefined) record.stopReason = event.stopReason
          if (event.error !== undefined) record.error = event.error
          if (event.runId !== undefined) record.runId = event.runId
        }
      }
    }
    for (const record of byId.values()) {
      // 折叠完仍未终结 = 进程在它跑完之前就没了。必须落成 interrupted，绝不能让台账里
      // 留一个永远 running 的幽灵任务——那会同时污染通过率、并发数和"还在跑"的判断。
      if (!isTerminal(record.status)) {
        record.status = 'interrupted'
        record.error = record.error ?? 'interrupted by bridge restart'
        record.finishedAt = record.finishedAt ?? Date.now()
      }
      this.tasks.set(record.id, record)
      this.order.push(record.id)
    }
    this.trim()
  }

  private trim(): void {
    const keep = this.config.keepTasks
    if (keep <= 0) return
    while (this.order.length > keep) {
      const id = this.order[0]
      if (id === undefined) break
      const task = this.tasks.get(id)
      if (task !== undefined && !isTerminal(task.status)) break
      this.order.shift()
      if (id !== undefined) this.tasks.delete(id)
    }
  }

  // ── 工作目录与 dispatcher ───────────────────────────────────────────────────

  private resolveWorkspace(body: Record<string, any>): string {
    const requested = cleanString(body.workspace) ?? cleanString(body.cwd)
    const requestedTarget = requested !== undefined
      ? (isAbsolute(requested) ? requested : resolvePath(requested))
      : this.defaultWorkspace
    let target: string
    try {
      target = realpathSync(requestedTarget)
    } catch {
      throw new WorkspaceError(`workspace does not exist: ${requestedTarget}`)
    }
    if (!statSync(target).isDirectory()) throw new WorkspaceError(`workspace is not a directory: ${target}`)
    if (this.config.workspaceRoots.length > 0) {
      const roots = this.config.workspaceRoots.map((root) => {
        try {
          const resolvedRoot = realpathSync(resolvePath(root))
          return statSync(resolvedRoot).isDirectory() ? resolvedRoot : undefined
        } catch {
          return undefined
        }
      })
      const allowed = roots.some((root) => root !== undefined &&
        (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)))
      if (!allowed) {
        throw new WorkspaceError(`workspace not allowed by workspaceRoots: ${target}`)
      }
    }
    return target
  }

  private dispatcherDefaults(): { provider?: string; model?: string; source: string } {
    if (this.config.agentProvider || this.config.agentModel) {
      return {
        ...(this.config.agentProvider ? { provider: this.config.agentProvider } : {}),
        ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
        source: 'plugin-config',
      }
    }
    const defaultModelService = this.ctx.get?.('agentDefaultModel') as any
    const current = defaultModelService?.currentSelection?.() ?? {}
    return {
      ...(current.provider ? { provider: current.provider } : {}),
      ...(current.model ? { model: current.model } : {}),
      source: 'agentDefaultModel',
    }
  }

  private ensureDispatcher(workspace: string): Promise<any> {
    const existing = this.dispatchers.get(workspace)
    if (existing !== undefined) return existing
    const created = (async () => {
      const ctxAny = this.ctx as any
      const agents = ctxAny.agents
      if (agents?.create === undefined) throw new Error('dsh-codex-bridge: ctx.agents unavailable')
      const defaults = this.dispatcherDefaults()
      const agentOptions: Record<string, unknown> = {}
      if (defaults.provider) agentOptions.provider = defaults.provider
      if (defaults.model) agentOptions.model = defaults.model
      if (this.config.maxTokens > 0) agentOptions.maxTokens = this.config.maxTokens
      const sessionId = `dsh-codex-bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      // 程序化创建的 agent 不会自动挂 preset，而 Web 类 profile 把 fs/shell/skill 工具全部
      // 交给 preset 挂载：不挂 preset 的 dispatcher，其子 agent 手里没有任何工具，会退化
      // 成"声称改了文件、实际什么都没做"的假成功。meta.agentPreset + setup 挂载，是
      // webhook 会话创建路径使用的同一套动作。
      const presets = this.ctx.get?.('agentPresets') as any
      let presetId: string | undefined
      if (this.config.agentPreset && presets?.resolve !== undefined) {
        const resolved = await presets.resolve(this.config.agentPreset)
        presetId = resolved?.id ?? this.config.agentPreset
        await presets.standingKeyFor?.(presetId)
      }
      const handle = await agents.create({
        sessionId,
        meta: { cwd: workspace, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
        ...(presetId !== undefined && presets?.mount !== undefined
          ? { setup: async (agentCtx: any) => { await presets.mount(agentCtx, presetId) } }
          : {}),
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      })
      return handle
    })()
    // 创建失败不要把坏 promise 留在缓存里。
    created.catch(() => this.dispatchers.delete(workspace))
    this.dispatchers.set(workspace, created)
    return created
  }

  // ── 任务生命周期 ────────────────────────────────────────────────────────────

  private createTask(body: Record<string, any>, workspace: string): TaskRecord {
    const id = randomUUID()
    const prompt = String(body.prompt)
    const task: TaskRecord = {
      id,
      label: cleanString(body.label) ?? prompt.slice(0, 40),
      ...(cleanString(body.externalId) !== undefined ? { externalId: cleanString(body.externalId) } : {}),
      labels: cleanLabels(body.labels),
      prompt,
      provider: cleanString(body.provider) ?? this.config.provider,
      ...(body.agentOptions && typeof body.agentOptions === 'object'
        ? { agentOptions: body.agentOptions as Record<string, unknown> }
        : {}),
      workspace,
      status: 'queued',
      createdAt: Date.now(),
      controller: new AbortController(),
    }
    this.tasks.set(id, task)
    this.order.push(id)
    this.appendJournal({
      t: 'created',
      at: task.createdAt,
      id,
      task: {
        ...taskToJson(task, { prompt: true }),
        prompt: prompt.slice(0, PROMPT_JOURNAL_LIMIT),
      },
    })
    return task
  }

  private enqueue(task: TaskRecord, body: Record<string, any>): void {
    this.queue.push({ task, body })
    this.pump()
  }

  private get concurrency(): number {
    return this.config.maxConcurrent > 0 ? this.config.maxConcurrent : Number.MAX_SAFE_INTEGER
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()
      if (item === undefined) break
      if (item.task.status !== 'queued') continue
      this.running += 1
      void this.execute(item.task, item.body).finally(() => {
        this.running -= 1
        this.trim()
        this.pump()
      })
    }
  }

  private async execute(task: TaskRecord, body: Record<string, any>): Promise<void> {
    let run: any
    task.status = 'running'
    task.startedAt = Date.now()
    this.appendJournal({ t: 'started', at: task.startedAt, id: task.id })
    try {
      const handle = await this.ensureDispatcher(task.workspace)
      const parent = handle.agent
      const ctxAny = this.ctx as any
      const subagents = ctxAny.subagents
      const provider = subagents?.getProvider?.(task.provider)
      if (provider === undefined) {
        const available = subagents?.list?.() ?? []
        throw new Error(
          `dsh-codex-bridge: subagent provider not found: ${task.provider} (available: ${available.join(', ') || 'none'})`,
        )
      }
      if (task.agentOptions !== undefined && provider.capabilities?.agentOptions !== true) {
        throw new Error(`dsh-codex-bridge: provider "${task.provider}" does not accept agentOptions`)
      }
      const request: Record<string, unknown> = {
        label: task.label,
        prompt: [{ type: 'text', text: task.prompt }],
        parent,
        signal: task.controller!.signal,
      }
      if (task.agentOptions !== undefined) request.agentOptions = task.agentOptions
      if (body.maxDepth !== undefined) request.maxDepth = body.maxDepth
      else if (this.config.maxDepth > 0) request.maxDepth = this.config.maxDepth
      if (body.persona !== undefined) request.persona = body.persona
      if (body.toolFilter !== undefined) request.toolFilter = body.toolFilter
      if (body.outputSchema !== undefined) request.outputSchema = body.outputSchema

      run = await subagents.start(task.provider, request)
      task.runId = run.id
      const result = await run.result
      await run.dispose().catch(() => {})
      run = undefined

      if (task.controller?.signal.aborted) {
        this.settleAborted(task)
        return
      }
      const output = textFromBlocks(result?.output)
      if (result?.stopReason !== 'completed') {
        this.finish(task, 'failed', {
          stopReason: result?.stopReason,
          error: output || `subagent stopped with ${result?.stopReason ?? 'unknown'}`,
          ...(output ? { output } : {}),
        })
        return
      }
      this.finish(task, 'completed', {
        stopReason: 'completed',
        ...(output ? { output } : {}),
        ...(result?.structured !== undefined ? { structured: result.structured } : {}),
      })
    } catch (error: any) {
      if (run !== undefined) {
        await run.dispose().catch(() => {})
        run = undefined
      }
      const message = error instanceof Error ? error.message : String(error)
      if (task.controller?.signal.aborted) this.settleAborted(task)
      else this.finish(task, 'failed', { error: message })
    }
  }

  /**
   * 中止后的落账：`interrupted` 表示桥接自身重载/重启打断（任务没跑完，但没人否定它，
   * 应原样重派）；`cancelled` 表示有人主动取消。两者的返工含义完全不同，台账必须分开。
   */
  private settleAborted(task: TaskRecord): void {
    const reason = String(task.controller?.signal.reason ?? 'aborted')
    if (this.unloading) this.finish(task, 'interrupted', { error: `bridge reloaded: ${reason}` })
    else this.finish(task, 'cancelled', { error: reason })
  }

  private finish(
    task: TaskRecord,
    status: TaskStatus,
    detail: { output?: string; structured?: unknown; stopReason?: string; error?: string },
  ): void {
    task.status = status
    task.finishedAt = Date.now()
    if (detail.output !== undefined) task.output = detail.output
    if (detail.structured !== undefined) task.structured = detail.structured
    if (detail.stopReason !== undefined) task.stopReason = detail.stopReason
    if (detail.error !== undefined) task.error = detail.error
    this.appendJournal({
      t: 'finished',
      at: task.finishedAt,
      id: task.id,
      status,
      ...(task.output !== undefined ? { output: task.output } : {}),
      ...(task.structured !== undefined ? { structured: task.structured } : {}),
      ...(task.stopReason !== undefined ? { stopReason: task.stopReason } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      ...(task.runId !== undefined ? { runId: task.runId } : {}),
    })
  }

  private async waitForTask(task: TaskRecord, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (isTerminal(task.status)) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  private stats(): Record<string, unknown> {
    const byStatus: Record<string, number> = {}
    const byExternalId: Record<string, { total: number; completed: number; failed: number }> = {}
    let durationTotal = 0
    let durationCount = 0
    for (const task of this.tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
      if (task.externalId !== undefined) {
        const bucket = byExternalId[task.externalId] ?? { total: 0, completed: 0, failed: 0 }
        bucket.total += 1
        if (task.status === 'completed') bucket.completed += 1
        if (task.status === 'failed') bucket.failed += 1
        byExternalId[task.externalId] = bucket
      }
      if (task.startedAt !== undefined && task.finishedAt !== undefined) {
        durationTotal += task.finishedAt - task.startedAt
        durationCount += 1
      }
    }
    return {
      tasks: this.tasks.size,
      byStatus,
      byExternalId,
      running: this.running,
      queued: this.queue.length,
      avgDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : null,
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopback(request)) return sendJson(response, 403, { error: 'loopback only' })
    if (request.headers.origin !== undefined) {
      return sendJson(response, 403, { error: 'native client only' })
    }
    if (!authorized(request, this.config.apiToken)) {
      return sendJson(response, 401, { error: 'missing or invalid apiToken' })
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    const prefix = this.config.pathPrefix.replace(/\/+$/, '')
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path
    const clean = rest === '' ? '/' : rest

    try {
      if (request.method === 'GET' && (clean === '/' || clean === '/health')) {
        const ctxAny = this.ctx as any
        const defaults = this.dispatcherDefaults()
        return sendJson(response, 200, {
          ok: true,
          name,
          version: VERSION,
          port: ctxAny.webServer?.port ?? null,
          pathPrefix: prefix,
          authRequired: this.config.apiToken.length > 0,
          providers: this.providerList(),
          defaults: {
            provider: this.config.provider,
            ...(defaults.provider ? { agentProvider: defaults.provider } : {}),
            ...(defaults.model ? { agentModel: defaults.model } : {}),
            agentModelSource: defaults.source,
            agentPreset: this.config.agentPreset || '(none)',
            workspace: this.defaultWorkspace,
            defaultMode: this.config.defaultMode,
            maxConcurrent: this.concurrency === Number.MAX_SAFE_INTEGER ? 0 : this.concurrency,
            maxDepth: this.config.maxDepth,
          },
          journalPath: this.journalPath,
          journalReady: this.journalReady,
          dispatchers: [...this.dispatchers.keys()],
          stats: this.stats(),
        })
      }

      if (request.method === 'GET' && clean === '/providers') {
        return sendJson(response, 200, { providers: this.providerList() })
      }

      if (request.method === 'GET' && clean === '/stats') {
        return sendJson(response, 200, { ok: true, stats: this.stats(), journalPath: this.journalPath })
      }

      if (request.method === 'GET' && clean === '/tasks') {
        const status = url.searchParams.get('status')
        const externalId = url.searchParams.get('externalId')
        const label = url.searchParams.get('label')
        const limitRaw = Number(url.searchParams.get('limit') ?? '0')
        let tasks = [...this.tasks.values()]
        if (status !== null && status !== '') tasks = tasks.filter(task => task.status === status)
        if (externalId !== null && externalId !== '') tasks = tasks.filter(task => task.externalId === externalId)
        if (label !== null && label !== '') tasks = tasks.filter(task => task.label === label)
        tasks.sort((a, b) => b.createdAt - a.createdAt)
        if (Number.isSafeInteger(limitRaw) && limitRaw > 0) tasks = tasks.slice(0, limitRaw)
        return sendJson(response, 200, { tasks: tasks.map(task => taskToJson(task)) })
      }

      const taskMatch = clean.match(/^\/tasks\/([^/]+)$/)
      if (request.method === 'GET' && taskMatch) {
        const task = this.tasks.get(taskMatch[1])
        if (task === undefined) return sendJson(response, 404, { error: 'task not found' })
        const waitMs = Number(url.searchParams.get('waitMs') ?? '0')
        if (Number.isSafeInteger(waitMs) && waitMs > 0 && !isTerminal(task.status)) {
          const settled = await this.waitForTask(task, waitMs)
          return sendJson(response, settled ? 200 : 202, { ...taskToJson(task, { prompt: true }), waited: true, settled })
        }
        return sendJson(response, 200, taskToJson(task, { prompt: true }))
      }

      if (request.method === 'POST' && (clean === '/tasks' || clean === '/tasks/')) {
        if (!hasJsonContentType(request)) return sendJson(response, 415, { error: 'content-type must be application/json' })
        const body = await readJsonBody(request)
        if (typeof body?.prompt !== 'string' || body.prompt.trim().length === 0) {
          return sendJson(response, 400, { error: 'prompt is required' })
        }
        const workspace = this.resolveWorkspace(body)
        const mode = body.mode === 'sync' || body.mode === 'async' ? body.mode : this.config.defaultMode
        const task = this.createTask(body, workspace)
        this.enqueue(task, body)
        if (mode === 'async') {
          return sendJson(response, 202, { ok: true, id: task.id, status: task.status, workspace: task.workspace })
        }
        const settled = await this.waitForTask(task, this.config.requestTimeoutMs)
        if (!settled) {
          task.controller?.abort('request timeout')
          return sendJson(response, 504, { ...taskToJson(task), error: 'request timed out' })
        }
        if (task.status === 'completed') return sendJson(response, 200, taskToJson(task))
        return sendJson(response, 502, taskToJson(task))
      }

      const cancelMatch = clean.match(/^\/tasks\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        const task = this.tasks.get(cancelMatch[1])
        if (task === undefined) return sendJson(response, 404, { error: 'task not found' })
        if (isTerminal(task.status)) {
          return sendJson(response, 200, { ok: true, id: task.id, status: task.status, note: 'already settled' })
        }
        if (task.status === 'queued') {
          const index = this.queue.findIndex(item => item.task.id === task.id)
          if (index >= 0) this.queue.splice(index, 1)
        }
        task.controller?.abort('cancelled via API')
        if (task.status === 'queued') this.finish(task, 'cancelled', { error: 'cancelled before start' })
        return sendJson(response, 200, { ok: true, id: task.id, status: task.status })
      }

      if (request.method === 'POST' && clean === '/batch') {
        if (!hasJsonContentType(request)) return sendJson(response, 415, { error: 'content-type must be application/json' })
        const body = await readJsonBody(request)
        const items = Array.isArray(body?.tasks) ? body.tasks : []
        if (items.length === 0) return sendJson(response, 400, { error: 'tasks array is required' })
        const accepted: Array<{ id: string; workspace: string }> = []
        const rejected: Array<{ index: number; error: string }> = []
        for (const [index, item] of items.entries()) {
          if (typeof item?.prompt !== 'string' || item.prompt.trim().length === 0) {
            rejected.push({ index, error: 'prompt is required' })
            continue
          }
          try {
            const workspace = this.resolveWorkspace(item)
            const task = this.createTask(item, workspace)
            this.enqueue(task, item)
            accepted.push({ id: task.id, workspace: task.workspace })
          } catch (error: any) {
            rejected.push({ index, error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (accepted.length === 0) return sendJson(response, 400, { error: 'no valid tasks in batch', rejected })
        return sendJson(response, 202, {
          ok: true,
          ids: accepted.map(item => item.id),
          count: accepted.length,
          tasks: accepted,
          ...(rejected.length > 0 ? { rejected } : {}),
        })
      }

      return sendJson(response, 404, { error: 'not found' })
    } catch (error: any) {
      if (error instanceof WorkspaceError) return sendJson(response, 400, { error: error.message })
      return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private providerList(): Array<Record<string, unknown>> {
    const ctxAny = this.ctx as any
    const names: string[] = ctxAny.subagents?.list?.() ?? []
    return names.map((providerName) => {
      const provider = ctxAny.subagents?.getProvider?.(providerName)
      const capabilities = provider?.capabilities
      return {
        name: providerName,
        ...(capabilities !== undefined ? { capabilities } : {}),
        acceptsAgentOptions: capabilities?.agentOptions === true,
      }
    })
  }
}

/** 工作目录解析失败 → HTTP 400 而不是 500。 */
class WorkspaceError extends Error {}

export function apply(ctx: Context, config: Config): void {
  const bridge = new CodexBridge(ctx, config)
  bridge.start()
  ctx.logger?.info?.(
    `[dsh-codex-bridge] v${VERSION} mounted at ${config.pathPrefix} (default workspace ${config.workspace || process.cwd()})`,
  )
}
