import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const client = fileURLToPath(new URL('../codex-dsh-client.mjs', import.meta.url))
const { main, isDirectExecution } = await import(pathToFileURL(client).href)

async function fixture(handler) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
    calls.push(call)
    await handler(call, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    calls,
    url: `http://127.0.0.1:${port}/dsh-codex-bridge`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

async function run(args, { url, env = {}, token = 'test-secret' } = {}) {
  const saved = Object.fromEntries(['DSH_BRIDGE_URL', 'DSH_BRIDGE_TOKEN', 'DSH_BRIDGE_TIMEOUT_MS'].map(k => [k, process.env[k]]))
  for (const key of Object.keys(saved)) delete process.env[key]
  Object.assign(process.env, { ...(Object.hasOwn(env, 'DSH_BRIDGE_URL') ? {} : { DSH_BRIDGE_URL: url ?? 'http://127.0.0.1:1/dsh-codex-bridge' }), DSH_BRIDGE_TOKEN: token, ...env })
  let stdout = ''; let stderr = ''; let code
  const log = console.log; const error = console.error
  console.log = (...x) => { stdout += `${x.join(' ')}\n` }
  console.error = (...x) => { stderr += `${x.join(' ')}\n` }
  try { code = await main(args) } catch (e) { stderr += `${e?.message ?? e}\n`; code = e?.usage ? 2 : 1 }
  finally {
    console.log = log; console.error = error
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value
  }
  return { code, stdout, stderr }
}

async function withFixture(handler, fn) {
  const f = await fixture(handler)
  try { await fn(f) } finally { await f.close() }
}

test('help forms succeed and advertise agent provider and timeout environment variable', async () => {
  for (const args of [[], ['help'], ['--help'], ['-h'], ['submit', '--help'], ['wait', '--help']]) {
    const result = await run(args)
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  }
  const help = await run(['--help'])
  assert.match(help.stdout, /--agent-provider/)
  assert.match(help.stdout, /DSH_BRIDGE_TIMEOUT_MS/)
})

test('entrypoint detection follows Windows npm-link junctions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-'))
  try {
    const linked = join(dir, 'linked')
    await symlink(dirname(client), linked, 'junction')
    assert.equal(isDirectExecution(join(linked, 'codex-dsh-client.mjs'), client), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('submit sends UTF-8 prompt-file bytes and task options, including max-depth zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  const path = join(dir, '中文任务.txt')
  const prompt = '第一行\n第二行：你好🌱\n'
  await writeFile(path, prompt, 'utf8')
  try {
    await withFixture((call, res) => {
      assert.equal(call.headers.authorization, 'Bearer test-secret')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 't1', status: 'queued' }))
    }, async f => {
      const workspace = resolve('C:\\ws')
      const result = await run(['submit', '--prompt-file', path, '--mode', 'async', '--model', 'm1', '--agent-provider', 'ap', '--provider', 'dp', '--workspace', 'C:\\ws', '--external-id', 'ext/1', '--labels', 'red, blue', '--max-depth', '0'], { url: f.url })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(f.calls[0].body, { prompt, mode: 'async', provider: 'dp', workspace, externalId: 'ext/1', labels: ['red', 'blue'], maxDepth: 0, agentOptions: { provider: 'ap', model: 'm1' } })
      assert.doesNotMatch(result.stdout + result.stderr, /test-secret/)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('positional prompts retain joined-word behavior and explicit sync cannot return unfinished', async () => {
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'running' })), async f => {
    const result = await run(['submit', 'two', 'word', 'prompt', '--mode', 'sync'], { url: f.url })
    assert.equal(result.code, 1)
    assert.equal(f.calls[0].body.prompt, 'two word prompt')
  })
})

test('invalid arguments and malformed batch inputs fail before HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  const file = join(dir, 'bad.json')
  await writeFile(file, JSON.stringify([{ prompt: 'ok' }, { nope: true }]))
  try {
    await withFixture((call, res) => res.writeHead(200).end('{}'), async f => {
      const cases = [
        ['submit', 'x', '--wat'], ['submit', '--model', ''], ['submit', '--mode', 'later', 'x'],
        ['submit', 'one', '--prompt', 'two'], ['wait', 'id', '--timeout-ms', '0'],
        ['status', 'id', '--wait-ms', '-1'], ['list', '--limit', '0'], ['submit', 'x', '--max-depth', '1.5'],
        ['list', '--status', 'pending'], ['list', '--label', ''],
        ['batch', '--file', file], ['batch', '--file', join(dir, 'absent.json')],
      ]
      for (const args of cases) {
        const result = await run(args, { url: f.url })
        assert.equal(result.code, 2, `${args.join(' ')} => ${result.code}: ${result.stderr}`)
      }
      assert.equal(f.calls.length, 0)
      assert.equal((await run(['health'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '' } })).code, 2)
      assert.equal((await run(['health'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '2147483648' } })).code, 2)
      assert.equal(f.calls.length, 0)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('partial batch rejection preserves accepted and rejected results and exits 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify([{ prompt: 'one' }, { prompt: 'two' }]))
  try {
    await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ ok: true, ids: ['a1'], count: 1, tasks: [{ id: 'a1', workspace: 'x' }], rejected: [{ index: 1, error: 'no' }] })), async f => {
      const result = await run(['batch', '--file', file], { url: f.url })
      assert.equal(result.code, 1)
      assert.match(result.stdout, /a1/)
      assert.match(result.stdout, /rejected/)
      assert.match(result.stderr, /retry/i)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('fully accepted batch response succeeds when rejected is omitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify([{ prompt: 'one' }]))
  try {
    await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ ok: true, ids: ['a1'], count: 1, tasks: [{ id: 'a1', workspace: 'x' }] })), async f => {
      assert.equal((await run(['batch', '--file', file], { url: f.url })).code, 0)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('malformed batch responses fail instead of reporting success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-client-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify([{ prompt: 'one' }, { prompt: 'two' }]))
  const malformed = [
    { ok: true, ids: [], count: 0, tasks: [] },
    { ok: true, ids: ['a', 'a'], count: 2, tasks: [{ id: 'a', workspace: 'w' }, { id: 'a', workspace: 'w' }] },
    { ok: true, ids: ['a', 'b'], count: 1, tasks: [{ id: 'a', workspace: 'w' }] },
    { ok: true, ids: ['a', 'b'], count: 2, tasks: [{ id: 'a', workspace: 'w' }, { id: 'b', workspace: '' }] },
    { ok: true, ids: ['a'], count: 1, tasks: [{ id: 'a', workspace: 'w' }] },
    { ok: true, ids: ['a'], count: 1, tasks: [{ id: 'a', workspace: 'w' }], rejected: [{ index: 1, error: '' }] },
    { ok: true, ids: ['a'], count: 1, tasks: [{ id: 'a', workspace: 'w' }], rejected: [{ index: '1', error: 'no' }] },
  ]
  try {
    for (const resultBody of malformed) {
      await withFixture((call, res) => res.writeHead(200).end(JSON.stringify(resultBody)), async f => {
        assert.equal((await run(['batch', '--file', file], { url: f.url })).code, 1, JSON.stringify(resultBody))
      })
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('sync failures exit 1 even when mode is omitted', async () => {
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'failed', error: 'bad' })), async f => {
    const result = await run(['submit', 'task'], { url: f.url })
    assert.equal(result.code, 1)
  })
})

test('default async accepted tasks succeed, while malformed submit results fail', async () => {
  await withFixture((call, res) => res.writeHead(202).end(JSON.stringify({ id: 'x', status: 'queued' })), async f => assert.equal((await run(['submit', 'task'], { url: f.url })).code, 0))
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ ok: true })), async f => assert.equal((await run(['submit', 'task', '--mode', 'async'], { url: f.url })).code, 1))
})

test('submit response ids must be non-empty and returned tokens are redacted', async () => {
  for (const response of [{ id: '', status: 'queued' }, { id: 'x', status: 'queued', error: 'test-secret leaked' }]) {
    await withFixture((call, res) => res.writeHead(200).end(JSON.stringify(response)), async f => {
      const result = await run(['submit', 'task'], { url: f.url })
      if (!response.id) assert.equal(result.code, 1)
      assert.doesNotMatch(result.stdout + result.stderr, /test-secret/)
    })
  }
})

test('JSON escaped bearer tokens are redacted from successful task output and HTTP errors', async () => {
  const secret = 'review"fake\\token'
  const escaped = JSON.stringify(secret).slice(1, -1)
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'failed', error: `echo ${secret}` })), async f => {
    const result = await run(['submit', 'task'], { url: f.url, token: secret })
    assert.equal(result.code, 1)
    assert.equal((result.stdout + result.stderr).includes(secret), false)
    assert.equal((result.stdout + result.stderr).includes(escaped), false)
  })
  await withFixture((call, res) => res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `echo ${secret}`, id: 'task-8' })), async f => {
    const result = await run(['health'], { url: f.url, token: secret })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /task-8/)
    assert.equal(result.stderr.includes(secret), false)
    assert.equal(result.stderr.includes(escaped), false)
  })
})

test('doctor requires complete bridge readiness', async () => {
  const ready = { ok: true, version: '1', providers: [{ name: 'p', acceptsAgentOptions: true }], defaults: { provider: 'p', agentModel: 'm' }, journalReady: true }
  const invalid = [
    { ...ready, ok: false }, { ...ready, providers: [] },
    { ...ready, providers: [{ name: 'p', acceptsAgentOptions: false }] },
    { ...ready, journalReady: false }, { ...ready, defaults: { provider: 'p' } },
    { ...ready, providers: null }, { ...ready, defaults: null },
  ]
  for (const health of invalid) await withFixture((call, res) => res.writeHead(200).end(JSON.stringify(health)), async f => assert.equal((await run(['doctor'], { url: f.url })).code, 1))
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify(ready)), async f => assert.equal((await run(['doctor'], { url: f.url })).code, 0))
})

test('wait reports completed, failed, total timeout, and an HTTP request that hangs', async () => {
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'a/b', status: 'completed' })), async f => {
    const result = await run(['wait', 'a/b', '--timeout-ms', '1000'], { url: f.url })
    assert.equal(result.code, 0)
    assert.equal(f.calls[0].url, '/dsh-codex-bridge/tasks/a%2Fb')
  })
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'failed' })), async f => assert.equal((await run(['wait', 'x', '--timeout-ms', '1000'], { url: f.url })).code, 1))
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'running' })), async f => {
    const result = await run(['wait', 'x', '--timeout-ms', '70'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '1000' } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /may still be running/i)
  })
  await withFixture((call, res) => {}, async f => {
    const start = Date.now()
    const result = await run(['wait', 'x', '--timeout-ms', '80'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '1000' } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /may still be running/i)
    assert.match(result.stderr, /status or cancel/i)
    assert.ok(Date.now() - start < 700)
  })
  await withFixture((call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{') }, async f => {
    const result = await run(['wait', 'x', '--timeout-ms', '500'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '40' } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /wait request timed out/i)
    assert.match(result.stderr, /may still be running/i)
    assert.match(result.stderr, /status or cancel/i)
  })
})

test('wait rejects malformed task replies immediately', async () => {
  const malformed = [
    { id: '', status: 'completed' }, { id: 'other', status: 'completed' },
    { id: 'x', status: 'unknown' }, [], null,
  ]
  for (const reply of malformed) await withFixture((call, res) => res.writeHead(200).end(JSON.stringify(reply)), async f => {
    const started = Date.now()
    const result = await run(['wait', 'x', '--timeout-ms', '5000'], { url: f.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /malformed task response/)
    assert.ok(Date.now() - started < 1000)
  })
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ id: 'x', status: 'completed' })), async f => {
    assert.equal((await run(['wait', 'x', '--timeout-ms', '9007199254740991'], { url: f.url })).code, 0)
  })
})

test('network timeout is readable and HTTP errors retain task tracking fields without token leakage', async () => {
  await withFixture(() => {}, async f => {
    const result = await run(['health'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '50' } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /timeout|timed out/i)
    assert.doesNotMatch(result.stderr, /test-secret/)
  })
  await withFixture((call, res) => res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'conflict test-secret', id: 'task-7', status: 'running' })), async f => {
    const result = await run(['health'], { url: f.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /task-7/)
    assert.match(result.stderr, /running/)
    assert.doesNotMatch(result.stderr, /test-secret/)
  })
  await withFixture((call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{') }, async f => {
    const result = await run(['health'], { url: f.url, env: { DSH_BRIDGE_TIMEOUT_MS: '50' } })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /timeout|timed out/i)
  })
})

test('existing endpoint methods and URL encoding remain compatible', async () => {
  await withFixture((call, res) => res.writeHead(200).end(JSON.stringify({ ok: true, id: 'x' })), async f => {
    for (const args of [['health'], ['providers'], ['stats'], ['list', '--status', 'queued'], ['status', 'a/b', '--wait-ms', '2'], ['cancel', 'a/b']]) {
      assert.equal((await run(args, { url: f.url })).code, 0, args.join(' '))
    }
    assert.deepEqual(f.calls.map(c => c.url), ['/dsh-codex-bridge/health', '/dsh-codex-bridge/providers', '/dsh-codex-bridge/stats', '/dsh-codex-bridge/tasks?status=queued', '/dsh-codex-bridge/tasks/a%2Fb?waitMs=2', '/dsh-codex-bridge/tasks/a%2Fb/cancel'])
  })
})
