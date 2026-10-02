import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = realpathSync(rootPath)
if (realpathSync(root) !== root) throw new Error(`Project root is not canonical: ${root}`)

function isWithinRoot(path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertWithinRoot(path, description) {
  const absolutePath = resolve(path)
  const rel = relative(root, absolutePath)
  if (!isWithinRoot(absolutePath)) throw new Error(`${description} escapes canonical project root: ${absolutePath}`)
  return rel
}

function inspectOutputEntry(path) {
  assertWithinRoot(path, 'Build output path')
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Build output contains a symlink or junction: ${path}`)
  const actual = realpathSync(path)
  assertWithinRoot(actual, 'Resolved build output path')
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) inspectOutputEntry(resolve(path, name))
  }
}

function requireOutputFile(path) {
  inspectOutputEntry(path)
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Build did not produce ${relative(root, path)}`)
    throw error
  }
  if (!stat.isFile()) throw new Error(`Build output is not a regular file: ${path}`)
}

function inspectOutputDirectory(path) {
  assertWithinRoot(path, 'Build output directory')
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Build output directory is a symlink or junction: ${path}`)
  if (!stat.isDirectory()) throw new Error(`Build output path is not a directory: ${path}`)
  assertWithinRoot(realpathSync(path), 'Resolved build output directory')
}

const outputRoot = resolve(root, 'lib')
inspectOutputDirectory(outputRoot)
inspectOutputDirectory(resolve(root, 'lib/types'))
inspectOutputEntry(outputRoot)
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
try {
  lstatSync(tsc)
} catch {
  throw new Error('TypeScript compiler not found. Run npm install (or npm ci) first.')
}

const result = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

inspectOutputEntry(outputRoot)
requireOutputFile(resolve(root, 'lib/index.js'))
requireOutputFile(resolve(root, 'lib/index.js.map'))
requireOutputFile(resolve(root, 'lib/types/index.d.ts'))
