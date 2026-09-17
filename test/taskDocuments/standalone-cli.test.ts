import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  const create = (args: string[]) => {
    const result = spawnSync(process.execPath, [join(product, 'scripts', 'task-documents.mjs'), 'create', ...args, '--root', workspace], {
      cwd: root, encoding: 'utf8', timeout: 20000,
    })
    if (result.error) throw result.error
    return result
  }
  const flags = create(['--title', 'Relocated agent task', '--parent', 'T-0001', '--level', 'subtask', '--actor', 'copilot'])
  expect(flags.status, flags.stderr).toBe(0)
  expect(JSON.parse(flags.stdout)).toEqual({ taskId: 'T-0002', directory: 'tasks/T-0002-relocated-agent-task' })
  await writeFile(join(workspace, 'draft.json'), JSON.stringify({ title: '\u4e2d\u6587\u4efb\u52a1', acceptance: ['Keep original content'] }))
  const imported = create(['--draft', 'draft.json'])
  expect(imported.status, imported.stderr).toBe(0)
  expect(JSON.parse(imported.stdout)).toEqual({ taskId: 'T-0003', directory: 'tasks/T-0003-task' })
  for (const args of [
    ['--draft', 'draft.json', '--title', 'Override'],
    ['--title', 'Task', '--status', 'done'],
    ['--draft', join(product, 'package.json')],
  ]) {
    const result = create(args)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('DOCUMENT_COMMAND_FAILED')
  }
  expect(await readFile(taskFile, 'utf8')).toBe(originalTask)
  expect(await readdir(join(workspace, '.agentdesk', 'cache'))).toEqual([])
}, 60000)

it('serializes independent CLI processes through a workspace lock without colliding IDs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'taskcon-create-processes-')))
  temporaryRoots.push(root)
  await mkdir(join(root, '.agentdesk'))
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify(makeConfig()))
  const script = resolve('scripts', 'task-documents.mjs')
  const launch = (title: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, 'create', '--title', title, '--root', root], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
    child.on('error', reject)
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
  const attempts = await Promise.all([launch('Parallel one'), launch('Parallel two')])
  expect(attempts.some((result) => result.status === 0)).toBe(true)
  const created: string[] = []
  for (const result of attempts) {
    if (result.status === 0) created.push(JSON.parse(result.stdout).taskId)
    else {
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/busy or.*stale/)
      expect(result.stdout).toBe('')
      const retry = await launch('Retried busy creation')
      expect(retry.status, retry.stderr).toBe(0)
      created.push(JSON.parse(retry.stdout).taskId)
    }
  }
  expect(created.sort()).toEqual(['T-0001', 'T-0002'])
  const directories = await readdir(join(root, 'tasks'))
  expect(directories).toHaveLength(2)
  for (const directory of directories) {
    expect(await readdir(join(root, 'tasks', directory))).toContain('task.json')
    expect(await readdir(join(root, 'tasks', directory, 'designs'))).toEqual([])
    expect(await readdir(join(root, 'tasks', directory, 'ref'))).toEqual([])
  }
  expect(await readdir(join(root, '.agentdesk', 'cache'))).toEqual([])
}, 60000)
