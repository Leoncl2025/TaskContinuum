import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTaskWorkspace } from '../src/main/workspaceReader'
import { filterTasks, taskProgress } from '../src/shared/tasks'

const roots: string[] = []
async function fixtureRoot() {
  const directory = join(process.cwd(), 'artifacts', 'task-document-tests')
  await mkdir(directory, { recursive: true })
  return directory
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(await fixtureRoot(), 'taskcontinuum-workspace-'))
  roots.push(root)
  const directory = join(root, 'tasks', 'T-0002-real-task')
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, '.agentdesk'))
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Real planning data', paths: { tasks: 'tasks' } }))
  const task = { schemaVersion: '1.0', id: 'T-0002', title: 'Real task', type: 'feature', status: 'in-review', priority: 'P0', owner: 'Owner', summary: 'On-disk summary', relations: { level: 'task', parent: 'T-0001' }, today: { nextAction: 'Verify the result' } }
  await writeFile(join(directory, 'task.json'), JSON.stringify(task))
  await writeFile(join(directory, 'RequirementAnalysis.md'), '---\ndoc: requirement-analysis\n---\n# Requirements\n\n| ID | Goal |\n|---|---|\n| G1 | Real goal |\n\n| ID | Requirement |\n|---|---|\n| FR-01 | Real requirement |\n')
  await writeFile(join(directory, 'Plan.md'), '# Plan\n\n1. First action\n2. Second action\n')
  const checklist = '# Checklist\n\n> - [ ] `CL-999` Example only\n\n```md\n- [ ] `CL-998` Code sample\n```\n\n- [x] `CL-001` Completed criterion <!-- owner:human -->\n- [ ] `CL-002` Pending criterion\n'
  await writeFile(join(directory, 'Checklist.md'), checklist)
  return { root, directory, task, checklist }
}

describe('read-only task workspaces', () => {
  it('loads actual metadata and Markdown, preserving status and checklist ownership', async () => {
    const { root, directory, checklist } = await fixture()
    const workspace = await readTaskWorkspace(root)
    expect(workspace.title).toBe('Real planning data')
    expect(workspace.tasks).toHaveLength(1)
    expect(workspace.tasks[0]).toMatchObject({ id: 'T-0002', status: 'in-review', priority: 'P0', goal: 'Real goal', parentId: 'T-0001', nextAction: 'Verify the result', requirements: ['Real requirement'], plan: ['First action', 'Second action'] })
    expect(workspace.tasks[0].documents?.requirements).toMatch(/^# Requirements/)
    expect(workspace.tasks[0].checklist).toEqual([{ id: 'CL-001', title: 'Completed criterion', done: true }, { id: 'CL-002', title: 'Pending criterion', done: false }])
    expect(taskProgress(workspace.tasks[0])).toBe(50)
    expect(filterTasks(workspace.tasks, '', 'active')).toHaveLength(1)
    expect(workspace.diagnostics?.some((issue) => issue.code === 'SCHEMA_INVALID')).toBe(true)
    expect(workspace.warnings.some((warning) => warning.includes('SCHEMA_INVALID'))).toBe(true)
    expect(await readFile(join(directory, 'Checklist.md'), 'utf8')).toBe(checklist)
  })

  it('refreshes on-disk changes and derives a stable identity from the folder', async () => {
    const { root, directory, task } = await fixture()
    const first = await readTaskWorkspace(root)
    await writeFile(join(directory, 'task.json'), JSON.stringify({ ...task, title: 'Updated task', status: 'done' }))
    const second = await readTaskWorkspace(join(root, '.'))
    expect(second.id).toBe(first.id)
    expect(second.tasks[0]).toMatchObject({ title: 'Updated task', status: 'done' })
  })

  it('rejects non-workspaces and traversal in the configured tasks path', async () => {
    const { root } = await fixture()
    await expect(readTaskWorkspace(join(root, 'tasks'))).rejects.toThrow('AgentDesk workspace')
    await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Unsafe', paths: { tasks: '../outside' } }))
    await expect(readTaskWorkspace(root)).rejects.toThrow('inside the workspace')
  })

  it('warns about malformed tasks without hiding valid ones', async () => {
    const { root } = await fixture()
    const broken = join(root, 'tasks', 'T-0003-broken')
    await mkdir(broken)
    await writeFile(join(broken, 'task.json'), '{bad json')
    const workspace = await readTaskWorkspace(root)
    expect(workspace.tasks).toHaveLength(1)
    expect(workspace.warnings[0]).toContain('T-0003-broken')
  })

  it('does not follow task directory links outside the selected workspace', async () => {
    const { root } = await fixture()
    const outside = await mkdtemp(join(await fixtureRoot(), 'taskcontinuum-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'tasks', 'T-0003-linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const workspace = await readTaskWorkspace(root)
    expect(workspace.tasks).toHaveLength(1)
    expect(workspace.warnings.some((warning) => warning.includes('escapes the selected folder'))).toBe(true)
  })

  it('supports valid empty workspaces and manual progress', async () => {
    const { root, directory, task } = await fixture()
    await writeFile(join(directory, 'task.json'), JSON.stringify({ ...task, progress: { mode: 'manual', percent: 35, manualPercent: 40 } }))
    expect(taskProgress((await readTaskWorkspace(root)).tasks[0])).toBe(40)
    await writeFile(join(directory, 'task.json'), JSON.stringify({ ...task, progress: { mode: 'rollup', percent: 37 } }))
    expect(taskProgress((await readTaskWorkspace(root)).tasks[0])).toBe(37)
    await rm(directory, { recursive: true })
    expect((await readTaskWorkspace(root)).tasks).toEqual([])
  })
})