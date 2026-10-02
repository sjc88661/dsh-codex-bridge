import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const templateDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

export async function initialize(directory = process.cwd(), cwd = process.cwd()) {
  const target = resolve(cwd, directory)
  await mkdir(target, { recursive: true })
  const workspace = target
  const specs = [
    ['dsh-bridge.json', JSON.stringify({ url: 'http://127.0.0.1:3080/dsh-codex-bridge', workspace: '.', mode: 'async' }, null, 2) + '\n'],
    ['dsh-task.md', (await readFile(resolve(templateDir, 'dsh-task.md'), 'utf8')).replaceAll('{{WORKSPACE}}', workspace)],
    ['AGENTS.dsh.md', await readFile(resolve(templateDir, 'AGENTS.dsh.md'), 'utf8')],
  ]
  const created = []; const skipped = []
  for (const [name, content] of specs) {
    const path = resolve(target, name)
    try { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }); created.push(path) }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      skipped.push(path)
    }
  }
  return { directory: target, created, skipped }
}
