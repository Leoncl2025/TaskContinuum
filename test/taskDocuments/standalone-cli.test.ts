import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { makeConfig, makeTask } from './fixtures'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the relocated checker without an AgentDesk checkout, tsx, or a product build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-owned-cli-'))
  temporaryRoots.push(root)
  const product = join(root, 'product')
  const workspace = join(root, 'workspace')
  const taskDirectory = join(workspace, 'tasks', 'T-0001-t-0001')
  await mkdir(join(product, 'scripts'), { recursive: true })
  await mkdir(join(product, 'src', 'main'), { recursive: true })
  await mkdir(join(product, 'src', 'shared'), { recursive: true })
  await mkdir(join(workspace, '.agentdesk'), { recursive: true })
  await mkdir(taskDirectory, { recursive: true })
  await cp(resolve('scripts', 'task-documents.mjs'), join(product, 'scripts', 'task-documents.mjs'))
  await cp(resolve('src'), join(product, 'src'), { recursive: true })
  await writeFile(join(product, 'package.json'), '{"private":true,"type":"module"}\n')
  // Only installed dependencies are shared; the relocated source has no sibling checkout.
  await symlink(resolve('node_modules'), join(product, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify(makeConfig()))
  const taskFile = join(taskDirectory, 'task.json')
  const originalTask = `${JSON.stringify(makeTask({ id: 'T-0001' }), null, 2)}\n`
  await writeFile(taskFile, originalTask)
  for (const [file, doc] of [
    ['RequirementAnalysis.md', 'requirement-analysis'],
    ['Plan.md', 'plan'],
    ['Checklist.md', 'checklist'],
  ]) {
    await writeFile(join(taskDirectory, file), `---\ndoc: ${doc}\nupdated: "2026-09-14"\n---\n`)
  }

  const commands = [
    ['validate'],
    ['validate', 'T-0001'],
    ['scan', '--all'],
    ['check'],
    ['schema:gen'],
    ['schema:gen', '--check'],
    ['reindex'],
  ]
  for (const command of commands) {
    const result = spawnSync(process.execPath, [join(product, 'scripts', 'task-documents.mjs'), ...command, '--root', workspace], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
    })
    if (result.error) throw result.error
    expect(result.status, `${command.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
  }
  expect(await readFile(taskFile, 'utf8')).toBe(originalTask)
}, 30000)
