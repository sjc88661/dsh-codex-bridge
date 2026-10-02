import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let tempRoot
let allowedRoot
let nestedRoot
let outsideRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'dsh-bridge-server-'))
  allowedRoot = join(tempRoot, 'allowed')
  nestedRoot = join(allowedRoot, 'nested')
  outsideRoot = join(tempRoot, 'allowed-sibling')
  mkdirSync(nestedRoot, { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
})

after(() => rmSync(tempRoot, { recursive: true, force: true }))

function fixture(overrides = {}) {
  let handler
  const started = []
  const ctx = {
    webServer: {
      port: 3080,
      register(route) { handler = route.handler; return () => {} },
    },
    agents: { async create(options) { return { agent: { options } } } },
    subagents: {
      list: () => ['mock'],
      getProvider: () => ({ capabilities: { agentOptions: true } }),
      async start(_provider, request) {
        started.push(request)
        return {
          id: `mock-${started.length}`,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'accepted' }] }),
          async dispose() {},
        }
      },
    },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  const config = {
    pathPrefix: '/dsh-codex-bridge',
    apiToken: '',
    provider: 'mock',
    workspace: '',
    workspaceRoots: [],
    agentPreset: '',
    agentProvider: '',
    agentModel: '',
    maxTokens: 0,
    maxDepth: 3,
    defaultMode: 'async',
    requestTimeoutMs: 2000,
    maxConcurrent: 3,
    journalPath: join(tempRoot, `journal-${Math.random()}.jsonl`),
    keepTasks: 500,
    ...overrides,
  }
  apply(ctx, config)
  assert.equal(typeof handler, 'function')
  return { handler, config, started }
}

async function request(server, {
  method = 'GET', path = '/dsh-codex-bridge/health', remoteAddress = '127.0.0.1',
  host = '127.0.0.1:3080', headers = {}, body,
} = {}) {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: path,
    headers: { host, ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield* bytes },
  }
  return await new Promise((resolve) => {
    let statusCode
    const res = {
      writeHead(status) { statusCode = status },
      end(responseBody = '') {
        resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : undefined })
      },
    }
    server.handler(req, res)
  })
}

test('loopback authorization uses only the socket peer address', async () => {
  const server = fixture()
  const spoofed = await request(server, { remoteAddress: '192.0.2.7', host: 'localhost:3080' })
  assert.equal(spoofed.status, 403)
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    const result = await request(server, { remoteAddress: address })
    assert.equal(result.status, 200, address)
  }
})

test('browser-origin requests are rejected and task JSON requires its content type', async () => {
  const server = fixture()
  const browserPost = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks', headers: { origin: 'https://example.test' },
    body: { prompt: 'must reject' },
  })
  assert.equal(browserPost.status, 403)
  assert.match(browserPost.body.error, /native client only/)
  const wrongType = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks', headers: { 'content-type': 'text/plain' },
    body: { prompt: 'must reject' },
  })
  assert.equal(wrongType.status, 415)
  const nativeJson = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks', body: { prompt: 'accepted', mode: 'sync' },
  })
  assert.equal(nativeJson.status, 200)
})

test('configured bearer token is enforced', async () => {
  const server = fixture({ apiToken: 'local-secret' })
  assert.equal((await request(server)).status, 401)
  assert.equal((await request(server, { headers: { authorization: 'Bearer local-secret' } })).status, 200)
})

test('allowed nested workspace is canonicalized and accepted', async () => {
  const server = fixture({ workspaceRoots: [allowedRoot] })
  const result = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks',
    body: { prompt: 'normal task', workspace: nestedRoot, mode: 'sync' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'completed')
  assert.equal(result.body.workspace, realpathSync(nestedRoot))
  assert.equal(server.started.length, 1)
})

test('sibling-prefix workspace is rejected', async () => {
  const server = fixture({ workspaceRoots: [allowedRoot] })
  const result = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks',
    body: { prompt: 'must reject', workspace: outsideRoot, mode: 'async' },
  })
  assert.equal(result.status, 400)
})

test('junction escaping an allowed root is rejected after canonicalization', async (t) => {
  const escapePath = join(allowedRoot, 'escape')
  try {
    symlinkSync(outsideRoot, escapePath, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`junction creation unavailable: ${error.code}`)
    throw error
  }
  try {
    const server = fixture({ workspaceRoots: [allowedRoot] })
    const result = await request(server, {
      method: 'POST', path: '/dsh-codex-bridge/tasks',
      body: { prompt: 'must reject', workspace: escapePath, mode: 'async' },
    })
    assert.equal(result.status, 400)
  } finally {
    rmSync(escapePath, { recursive: true, force: true })
  }
})

test('default workspace is retained for a normal task without workspace override', async () => {
  const server = fixture({ workspace: nestedRoot, workspaceRoots: [allowedRoot] })
  const result = await request(server, {
    method: 'POST', path: '/dsh-codex-bridge/tasks',
    body: { prompt: 'use configured default', mode: 'sync' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'completed')
  assert.equal(result.body.workspace, realpathSync(nestedRoot))
})
