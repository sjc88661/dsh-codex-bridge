import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
if (realpathSync(root) !== root) throw new Error(`Project root is not canonical: ${root}`)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifestPath = join(root, 'release-files.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const releaseName = `dsh-codex-bridge-${pkg.version}-${stamp}-${randomBytes(3).toString('hex')}`
const releasesDirectory = join(root, 'release')
const releaseRoot = join(releasesDirectory, releaseName)
const sourceName = `dsh-codex-bridge-${pkg.version}`
const sourceRoot = join(releaseRoot, sourceName)

function isWithinRoot(path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertContained(path, description) {
  const absolutePath = resolve(path)
  if (!isWithinRoot(absolutePath)) throw new Error(`${description} escapes canonical project root: ${absolutePath}`)
  let current = root
  if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== root) {
    throw new Error(`Project root is not a canonical directory: ${root}`)
  }
  const rel = relative(root, absolutePath)
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink or junction in ${description}: ${current}`)
    if (!isWithinRoot(realpathSync(current))) {
      throw new Error(`${description} resolves outside canonical project root: ${current}`)
    }
  }
  return absolutePath
}

function assertSafePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')) {
    throw new Error(`Unsafe release manifest path: ${relativePath}`)
  }
  const target = assertContained(resolve(root, relativePath), `Release input ${relativePath}`)
  lstatSync(target)
  return target
}

function collectFiles(path, relativePath, output) {
  assertSafePath(relativePath)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release input: ${relativePath}`)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) collectFiles(join(path, name), `${relativePath}/${name}`, output)
  } else if (stat.isFile()) {
    output.push(relativePath)
  } else {
    throw new Error(`Unsupported release input: ${relativePath}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function npmPack() {
  assertContained(releaseRoot, 'npm pack destination')
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', releaseRoot]
  let command = process.execPath
  let commandArgs
  const npmCli = process.env.npm_execpath
  if (npmCli) commandArgs = [npmCli, ...args]
  else {
    const localCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    try {
      lstatSync(localCli)
      commandArgs = [localCli, ...args]
    } catch {
      throw new Error('npm CLI is unavailable. Run this script through `npm run release`.')
    }
  }
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm pack failed with exit code ${result.status}`)
  const details = JSON.parse(result.stdout)
  if (!Array.isArray(details) || typeof details[0]?.filename !== 'string') throw new Error('npm pack returned no archive filename')
  if (details[0].filename.includes('/') || details[0].filename.includes('\\') || details[0].filename === '.' || details[0].filename === '..') {
    throw new Error(`npm pack returned an unsafe archive filename: ${details[0].filename}`)
  }
  assertContained(join(releaseRoot, details[0].filename), 'npm pack output')
  return details[0].filename
}

function buildPackage() {
  const buildScript = join(root, 'scripts', 'build.mjs')
  const result = spawnSync(process.execPath, [buildScript], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Build failed with exit code ${result.status}`)
  assertSafeBuildTree()
  const compiledEntry = assertSafePath('lib/index.js')
  const compiledSource = readFileSync(compiledEntry, 'utf8')
  const compiledVersion = compiledSource.match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1]
  if (compiledVersion !== pkg.version) {
    throw new Error(`Compiled server version mismatch: expected ${pkg.version}, found ${compiledVersion ?? 'none'}`)
  }
}

function assertSafeBuildTree() {
  const lib = assertContained(join(root, 'lib'), 'Compiled output')
  const stack = [lib]
  while (stack.length > 0) {
    const path = stack.pop()
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Symlink or junction in compiled output: ${path}`)
    if (!isWithinRoot(realpathSync(path))) throw new Error(`Compiled output escapes canonical root: ${path}`)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) stack.push(join(path, name))
    }
  }
  for (const path of ['lib/index.js', 'lib/index.js.map', 'lib/types/index.d.ts']) {
    const compiledPath = assertSafePath(path)
    if (!lstatSync(compiledPath).isFile()) throw new Error(`Compiled artifact is not a file: ${path}`)
  }
}

function writeExclusive(path, bytes) {
  assertContained(path, 'Release output')
  writeFileSync(path, bytes, { flag: 'wx' })
  assertContained(path, 'Release output')
}

const selected = []
for (const requestedPath of manifest.files) {
  const source = assertSafePath(requestedPath)
  try {
    collectFiles(source, requestedPath.replaceAll('\\', '/'), selected)
  } catch (error) {
    throw new Error(`Cannot package ${requestedPath}: ${error.message}`)
  }
}

buildPackage()
assertContained(releasesDirectory, 'Release output directory')
mkdirSync(releasesDirectory, { recursive: true })
assertContained(releasesDirectory, 'Release output directory')
if (!lstatSync(releasesDirectory).isDirectory()) throw new Error('Release output path is not a directory')
assertContained(releaseRoot, 'Release run directory')
mkdirSync(releaseRoot)
assertContained(releaseRoot, 'Release run directory')
mkdirSync(sourceRoot)
assertContained(sourceRoot, 'Release source directory')
const zipEntries = {}
for (const path of [...new Set(selected)].sort()) {
  const source = assertSafePath(path)
  const target = join(sourceRoot, path)
  assertContained(dirname(target), 'Release source output')
  mkdirSync(dirname(target), { recursive: true })
  assertContained(target, 'Release source output')
  copyFileSync(source, target, 1)
  assertContained(target, 'Release source output')
  zipEntries[`${sourceName}/${path.replaceAll('\\', '/')}`] = new Uint8Array(readFileSync(source))
}

const zipFilename = `${sourceName}.zip`
const zipBytes = zipSync(zipEntries, { level: 6 })
writeExclusive(join(releaseRoot, zipFilename), zipBytes)
const tgzFilename = npmPack()
const artifacts = [zipFilename, tgzFilename].map(path => {
  const artifactPath = assertContained(join(releaseRoot, path), 'Release archive')
  const bytes = readFileSync(artifactPath)
  return { path, sha256: sha256(bytes), size: bytes.length }
})
writeExclusive(join(releaseRoot, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n')
writeExclusive(join(releaseRoot, 'release-manifest.json'), JSON.stringify({
  name: sourceName,
  version: pkg.version,
  artifacts,
}, null, 2) + '\n')
process.stdout.write(`${JSON.stringify({ releaseDirectory: relative(root, releaseRoot), sourceDirectory: relative(root, sourceRoot), artifacts }, null, 2)}\n`)
