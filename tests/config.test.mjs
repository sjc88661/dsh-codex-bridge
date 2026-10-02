import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findConfig, loadRuntimeConfig, validateBridgeUrl } from '../client/config.mjs'

const clientPath = fileURLToPath(new URL('../codex-dsh-client.mjs', import.meta.url))
const { main } = await import(pathToFileURL(clientPath).href)

async function withEnv(changes, fn, cwd) {
  const names = ['DSH_BRIDGE_URL', 'DSH_BRIDGE_TOKEN', 'DSH_BRIDGE_TIMEOUT_MS']
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const oldCwd = process.cwd()
  for (const name of names) delete process.env[name]
  for (const [name, value] of Object.entries(changes)) if (value !== undefined) process.env[name] = value
  if (cwd) process.chdir(cwd)
  try { return await fn() }
  finally {
    process.chdir(oldCwd)
    for (const [name, value] of Object.entries(oldEnv)) value === undefined ? delete process.env[name] : process.env[name] = value
  }
}

async function capture(args) {
  let stdout = ''; let stderr = ''
  const out = console.log; const err = console.error
  console.log = (...parts) => { stdout += parts.join(' ') + '\n' }
  console.error = (...parts) => { stderr += parts.join(' ') + '\n' }
  try { return { code: await main(args), get stdout() { return stdout }, get stderr() { return stderr } } }
  finally { console.log = out; console.error = err }
}

async function fixture(handler) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ url: req.url, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined })
    await handler(res)
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}/dsh-codex-bridge`
  return { calls, url, close: async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) } }
}

test('config discovery walks upward; file-relative workspace and env precedence are applied', async () => {
  const noConfig = loadRuntimeConfig({ cwd: process.cwd(), env: {} })
  assert.equal(noConfig.url, 'http://127.0.0.1:3080/dsh-codex-bridge')
  assert.equal(noConfig.workspace, undefined)
  const root = await mkdtemp(join(tmpdir(), 'dsh 配置 space-'))
  try {
    const cfgDir = join(root, 'parent')
    const child = join(cfgDir, 'child'); await mkdir(child, { recursive: true })
    const configPath = join(cfgDir, 'dsh-bridge.json')
    await writeFile(configPath, '\uFEFF' + JSON.stringify({ url: 'http://localhost:3000/x/', workspace: './项目', provider: 'p', model: 'm', agentProvider: 'ap', mode: 'sync', maxDepth: 0, timeoutMs: 77 }))
    assert.equal(findConfig(child), configPath)
    const config = loadRuntimeConfig({ cwd: child, env: {} })
    assert.equal(config.url, 'http://localhost:3000/x')
    assert.equal(config.workspace, resolve(cfgDir, '项目'))
    assert.equal(config.timeoutMs, 77)
    const over = loadRuntimeConfig({ cwd: child, env: { DSH_BRIDGE_URL: 'http://127.1.2.3:99/new/', DSH_BRIDGE_TIMEOUT_MS: '88', DSH_BRIDGE_TOKEN: 'only-in-env' } })
    assert.equal(over.url, 'http://127.1.2.3:99/new')
    assert.equal(over.timeoutMs, 88)
    assert.equal(over.token, 'only-in-env')
    assert.equal(JSON.stringify(config).includes('only-in-env'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid config fields, secrets, URL forms, and numeric values are rejected without content leakage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  try {
    const path = join(root, 'dsh-bridge.json')
    for (const [raw, pattern] of [
      ['{bad secret JSON', /invalid JSON/],
      [JSON.stringify({ apiToken: 'do-not-echo-this' }), /apiToken/],
      [JSON.stringify({ url: 'http://user:pass@localhost:3' }), /localhost/],
      [JSON.stringify({ url: 'https://example.com' }), /localhost/],
      [JSON.stringify({ url: 'http://127.0.0.1?secret=x' }), /localhost/],
      [JSON.stringify({ url: 'http://127.0.0.1/path?' }), /localhost/],
      [JSON.stringify({ url: 'http://127.0.0.1/path#' }), /localhost/],
      [JSON.stringify({ maxDepth: 1.2 }), /maxDepth/],
      [JSON.stringify({ timeoutMs: 0 }), /timeoutMs/],
    ]) {
      await writeFile(path, raw)
      assert.throws(() => loadRuntimeConfig({ configPath: path, cwd: root, env: {} }), error => {
        assert.match(error.message, pattern)
        assert.equal(error.message.includes('do-not-echo-this'), false)
        assert.equal(error.message.includes('secret=x'), false)
        return true
      })
    }
    assert.throws(() => validateBridgeUrl('http://192.168.1.1'), /localhost/)
    assert.throws(() => loadRuntimeConfig({ configPath: 'missing.json', cwd: root, env: {} }), /does not exist/)
    await writeFile(path, '{}')
    assert.throws(() => loadRuntimeConfig({ cwd: root, env: { DSH_BRIDGE_URL: 'http://outside.example' } }), /DSH_BRIDGE_URL/)
    assert.throws(() => loadRuntimeConfig({ cwd: root, env: { DSH_BRIDGE_URL: '' } }), /DSH_BRIDGE_URL/)
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1/path?' }))
    assert.throws(() => loadRuntimeConfig({ configPath: path, cwd: root, env: { DSH_BRIDGE_URL: 'http://127.0.0.1/valid' } }), /config url/)
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1/path%3F' }))
    assert.equal(loadRuntimeConfig({ configPath: path, cwd: root, env: {} }).url, 'http://127.0.0.1/path%3F')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI config can occur on either side of command; CLI workspace and fields override config defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli config-'))
  const sub = join(root, 'nested'); await mkdir(sub)
  const server = await fixture(res => res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'one', status: 'queued' })))
  try {
    const configPath = join(root, 'dsh-bridge.json')
    await writeFile(configPath, JSON.stringify({ url: 'http://127.0.0.1:1/ignored', workspace: 'cfg-ws', provider: 'cfg-p', model: 'cfg-m', agentProvider: 'cfg-ap', mode: 'sync', maxDepth: 2 }))
    await withEnv({ DSH_BRIDGE_URL: server.url }, async () => {
      let got
      const out = console.log; const err = console.error; console.log = (...v) => { out(...[]) }; console.error = (...v) => { err(...[]) }
      try {
        const code = await main(['submit', '--config', configPath, 'hello', '--workspace', './cli-ws', '--model', 'cli-model', '--mode', 'async'])
        got = code
      } finally { console.log = out; console.error = err }
      assert.equal(got, 0)
      assert.deepEqual(server.calls[0].body, { prompt: 'hello', workspace: resolve(sub, 'cli-ws'), provider: 'cfg-p', mode: 'async', maxDepth: 2, agentOptions: { provider: 'cfg-ap', model: 'cli-model' } })
    }, sub)
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('batch paths and defaults resolve from batch directory while preserving per-task overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-batch config-'))
  const work = join(root, 'work'); await mkdir(work)
  const server = await fixture(res => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ids: ['a', 'b'], count: 2, tasks: [{ id: 'a', workspace: resolve(work, 'one') }, { id: 'b', workspace: resolve(root, 'two') }] })))
  try {
    const cfg = join(root, 'dsh-bridge.json'); const batch = join(root, 'batch.json')
    await writeFile(cfg, JSON.stringify({ url: server.url, workspace: 'default-ws', provider: 'p', model: 'm', agentProvider: 'ap', mode: 'sync', maxDepth: 0 }))
    await writeFile(batch, JSON.stringify([{ prompt: 'first', cwd: 'one' }, { prompt: 'second', workspace: 'two', mode: 'sync', provider: 'override', agentOptions: { model: 'custom' } }]))
    await withEnv({}, async () => {
      const output = await capture(['batch', '--file', batch, `--config=${cfg}`])
      assert.equal(output.code, 0, output.stderr)
      assert.deepEqual(server.calls[0].body.tasks, [
        { prompt: 'first', cwd: resolve(root, 'one'), provider: 'p', maxDepth: 0, agentOptions: { provider: 'ap', model: 'm' }, mode: 'async' },
        { prompt: 'second', workspace: resolve(root, 'two'), mode: 'async', provider: 'override', agentOptions: { provider: 'ap', model: 'custom' }, maxDepth: 0 },
      ])
    }, root)
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('help, version, and init do not require valid bridge config; init preserves existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh 初始化 space-'))
  try {
    await writeFile(join(root, 'dsh-bridge.json'), '{invalid')
    await withEnv({}, async () => {
      assert.equal((await capture(['--version', '--config', 'missing'])).stdout.trim(), JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
      assert.equal((await capture(['health', '--help', '--config', join(root, 'dsh-bridge.json')])).code, 0)
      const result = await capture(['init', '--dir', root])
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /AGENTS\.dsh\.md/)
      assert.equal(await readFile(join(root, 'dsh-bridge.json'), 'utf8'), '{invalid')
      assert.match(await readFile(join(root, 'dsh-task.md'), 'utf8'), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      const result2 = await capture(['init', '--dir', root])
      assert.match(result2.stdout, /skipped/)
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('repeated config flags fail with usage code and config state does not leak across main calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repeat-'))
  try {
    const first = join(root, 'first.json'); const second = join(root, 'second.json')
    await writeFile(first, JSON.stringify({ workspace: 'first' })); await writeFile(second, JSON.stringify({ workspace: 'second' }))
    assert.equal((await capture(['health', '--config', first, `--config=${second}`])).code, 2)
    const a = loadRuntimeConfig({ configPath: first, cwd: root, env: {} })
    const b = loadRuntimeConfig({ configPath: second, cwd: root, env: {} })
    assert.equal(a.workspace, resolve(root, 'first'))
    assert.equal(b.workspace, resolve(root, 'second'))
    assert.notEqual(a.workspace, b.workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('successive main calls use only their own config URL and defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-no-config-leak-'))
  const a = await fixture(res => res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'a', status: 'queued' })))
  const b = await fixture(res => res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'b', status: 'queued' })))
  try {
    const ca = join(root, 'a.json'); const cb = join(root, 'b.json')
    await writeFile(ca, JSON.stringify({ url: a.url, workspace: 'a-ws' }))
    await writeFile(cb, JSON.stringify({ url: b.url, workspace: 'b-ws' }))
    await withEnv({}, async () => {
      const one = await capture(['submit', 'one', '--config', ca])
      const two = await capture(['submit', 'two', '--config', cb])
      assert.equal(one.code, 0, one.stderr); assert.equal(two.code, 0, two.stderr)
      assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1)
      assert.equal(a.calls[0].body.workspace, resolve(root, 'a-ws'))
      assert.equal(b.calls[0].body.workspace, resolve(root, 'b-ws'))
    })
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }) }
})

test('overlapping main calls freeze their own tokens and redact HTTP errors independently', async () => {
  const a = await fixture(async res => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 35))
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'token-a' }))
  })
  const b = await fixture(async res => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'token-b' }))
  })
  const names = ['DSH_BRIDGE_URL', 'DSH_BRIDGE_TOKEN', 'DSH_BRIDGE_TIMEOUT_MS']
  const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]))
  let stderr = ''
  const originalLog = console.log; const originalError = console.error
  console.log = () => {}
  console.error = (...parts) => { stderr += parts.join(' ') + '\n' }
  try {
    process.env.DSH_BRIDGE_URL = a.url; process.env.DSH_BRIDGE_TOKEN = 'token-a'; delete process.env.DSH_BRIDGE_TIMEOUT_MS
    const first = main(['health'])
    process.env.DSH_BRIDGE_URL = b.url; process.env.DSH_BRIDGE_TOKEN = 'token-b'
    const second = main(['health'])
    assert.deepEqual(await Promise.all([first, second]), [1, 1])
    assert.equal(a.calls[0].authorization, 'Bearer token-a')
    assert.equal(b.calls[0].authorization, 'Bearer token-b')
    assert.equal(stderr.includes('token-a'), false)
    assert.equal(stderr.includes('token-b'), false)
  } finally {
    console.log = originalLog; console.error = originalError
    for (const [name, value] of Object.entries(oldEnv)) value === undefined ? delete process.env[name] : process.env[name] = value
    await a.close(); await b.close()
  }
})
