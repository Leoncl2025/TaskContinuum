import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import matter from '@11ty/gray-matter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import { createTaskDocuments, getTaskCreationContext, readTaskCreationDraft, taskCreationDraftSchema } from '../../src/main/taskDocuments/create'
import { run } from '../../src/main/taskDocuments/cli'
import { validateDocuments } from '../../src/main/taskDocuments/validation'
import { FRONT_MATTER_SCHEMAS, parseChecklist } from '../../src/shared/taskDocuments/frontmatter'
import { Task, TASK_KEY_ORDER } from '../../src/shared/taskDocuments/task'
import { makeConfig, makeTask } from './fixtures'

const roots: string[] = []
const resultSchema = z.object({ taskId: z.string(), directory: z.string() }).strict()

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(overrides: Record<string, unknown> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'taskcon-create-')))
  roots.push(root)
  const config = makeConfig(overrides)
  fs.mkdirSync(path.join(root, '.agentdesk'))
  fs.writeFileSync(path.join(root, '.agentdesk', 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return { root, config }
}

function writeTask(root: string, task: Task, store = 'tasks') {
  const directory = path.join(root, store, `${task.id}-${task.slug}`)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`)
  return directory
}

function loadCreated(root: string, result: { directory: string }) {
  const directory = path.resolve(root, result.directory)
  const content = fs.readFileSync(path.join(directory, 'task.json'), 'utf8')
  return { directory, content, task: Task.parse(JSON.parse(content)) }
}

function cacheEntries(root: string) {
  const cache = path.join(root, '.agentdesk', 'cache')
  return fs.existsSync(cache) ? fs.readdirSync(cache) : []
}

describe('canonical task creation', () => {
  it('creates a title-only backlog task with canonical documents and no Git/index/parent writes', () => {
    const { root } = fixture()
    vi.useFakeTimers()
    const now = new Date(2026, 8, 17, 0, 10, 0)
    vi.setSystemTime(now)
    fs.mkdirSync(path.join(root, '.git'))
    const untouched = new Map([
      [path.join(root, '.git', 'HEAD'), 'ref: refs/heads/fixture\n'],
      [path.join(root, '.git', 'index'), 'unchanged index bytes'],
      [path.join(root, '.gitignore'), '/.agentdesk/cache/\n'],
      [path.join(root, '.agentdesk', 'index.json'), '{"existing":true}\n'],
      [path.join(root, '.agentdesk', 'config.json'), fs.readFileSync(path.join(root, '.agentdesk', 'config.json'), 'utf8')],
    ])
    for (const [file, text] of untouched) fs.writeFileSync(file, text)
    const result = createTaskDocuments(root, { title: '  Create a useful task  ' })
    expect(result).toEqual({
      taskId: 'T-0001',
      directory: 'tasks/T-0001-create-a-useful-task',
      files: ['task.json', 'skill.md', 'RequirementAnalysis.md', 'Plan.md', 'Checklist.md', 'Reference.md']
        .map((file) => `tasks/T-0001-create-a-useful-task/${file}`),
    })
    const { directory, content, task } = loadCreated(root, result)
    expect(content.charCodeAt(0)).not.toBe(0xfeff)
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}\n`)
    expect(Object.keys(JSON.parse(content))).toEqual(TASK_KEY_ORDER.filter((key) => key in task))
    expect(task.$schema).toBeUndefined()
    expect(task).toMatchObject({
      schemaVersion: '1.0', title: 'Create a useful task', status: 'backlog', type: 'feature', priority: 'P2',
      owner: 'tester', dates: { created: '2026-09-17', started: null, due: null, completed: null },
      relations: { parent: null, level: 'task', dependsOn: [], relatedTo: [] },
      progress: { mode: 'checklist', percent: 0, manualPercent: null },
      copilot: { handoff: 'none', phase: 'analyze', contextScope: 'ancestors', lastRunAt: null },
      history: [{ at: now.toISOString(), by: 'tester', field: 'created', from: null, to: 'T-0001', note: 'Created via ui.' }],
    })
    expect(task.derived).toBeUndefined()
    expect(Object.values(task.lifecycle).every((entry) => entry.state === 'todo')).toBe(true)
    expect(fs.readdirSync(directory).sort()).toEqual([
      'Checklist.md', 'Plan.md', 'Reference.md', 'RequirementAnalysis.md', 'designs', 'ref', 'skill.md', 'task.json',
    ].sort())
    expect(fs.readdirSync(path.join(directory, 'designs'))).toEqual([])
    expect(fs.readdirSync(path.join(directory, 'ref'))).toEqual([])
    for (const [file, kind] of [
      ['RequirementAnalysis.md', 'requirement-analysis'], ['Plan.md', 'plan'],
      ['Checklist.md', 'checklist'], ['Reference.md', 'reference'],
    ] as const) {
      const text = fs.readFileSync(path.join(directory, file), 'utf8')
      expect(text).toContain('updated: "2026-09-17"')
      const parsed = matter(text, {})
      expect(FRONT_MATTER_SCHEMAS[kind].parse(parsed.data)).toMatchObject({ taskId: result.taskId, updated: '2026-09-17' })
    }
    expect(parseChecklist(matter(fs.readFileSync(path.join(directory, 'Checklist.md'), 'utf8'), {}).content).items).toEqual([])
    expect(validateDocuments(root).issues).toEqual([])
    for (const [file, text] of untouched) expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(cacheEntries(root)).toEqual([])
  })

  it('preserves Chinese and other non-ASCII content with a valid fallback slug and stable unchecked acceptance IDs', () => {
    const { root } = fixture()
    const description = '\u4fdd\u7559\u539f\u59cb\u9700\u6c42\n\nR\u00e9sum\u00e9 \u2014 \ud83d\ude80'
    const result = createTaskDocuments(root, {
      title: '\u521b\u5efa\u4efb\u52a1', description,
      acceptance: ['\u4fdd\u7559\u4e2d\u6587', 'Display r\u00e9sum\u00e9', 'Literal <!-- owner:intruder -->'],
    }, { source: 'agent', actor: 'copilot' })
    expect(result.directory).toBe('tasks/T-0001-task')
    const { directory, task } = loadCreated(root, result)
    expect(task.title).toBe('\u521b\u5efa\u4efb\u52a1')
    expect(task.history[0]).toMatchObject({ by: 'copilot', note: 'Created via agent.' })
    expect(fs.readFileSync(path.join(directory, 'RequirementAnalysis.md'), 'utf8')).toContain(description)
    const checklist = parseChecklist(matter(fs.readFileSync(path.join(directory, 'Checklist.md'), 'utf8'), {}).content)
    expect(checklist.duplicates).toEqual([])
    expect(checklist.items.map((item) => [item.id, item.checked, item.owner])).toEqual([
      ['CL-001', false, undefined], ['CL-002', false, undefined], ['CL-003', false, undefined],
    ])
    expect(checklist.items[0].text).toBe('\u4fdd\u7559\u4e2d\u6587')
    expect(validateDocuments(root).issues).toEqual([])
  })

  it('uses configured members, paths, ranks and valid parent choices without copying inherited skills', () => {
    const { root } = fixture({
      members: [{ id: 'copilot', name: 'Agent', kind: 'agent' }, { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
      levels: [{ id: 'feature', title: 'Initiative', rank: 2 }, { id: 'task', title: 'Work item', rank: 6 }, { id: 'subtask', title: 'Step', rank: 7 }],
      paths: { tasks: 'work/items', archive: 'work/archive' },
    })
    const parent = { ...makeTask({ id: 'T-0001', level: 'feature' }), owner: 'alice' }
    const parentDirectory = writeTask(root, parent, path.join('work', 'items'))
    fs.writeFileSync(path.join(parentDirectory, 'skill.md'), '# Shared rules\n\nDo not duplicate this text.\n')
    const before = fs.readFileSync(path.join(parentDirectory, 'task.json'), 'utf8')
    const context = getTaskCreationContext(root)
    expect(context).toMatchObject({
      members: [{ id: 'copilot', name: 'Agent' }, { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }],
      defaults: { owner: 'alice', level: 'task', type: 'feature', priority: 'P2' },
      levels: [{ id: 'feature', title: 'Initiative', rank: 2 }, { id: 'task', title: 'Work item', rank: 6 }, { id: 'subtask', title: 'Step', rank: 7 }],
      parents: [{ id: 'T-0001', title: parent.title, level: 'feature' }],
    })
    const result = createTaskDocuments(root, { title: 'Child', parentId: 'T-0001', owner: 'bob', type: 'bug', priority: 'P0', slug: 'explicit-slug' })
    expect(result.directory).toBe('work/items/T-0002-explicit-slug')
    expect(loadCreated(root, result).task).toMatchObject({ owner: 'bob', type: 'bug', priority: 'P0', relations: { level: 'task', parent: 'T-0001' } })
    expect(fs.readFileSync(path.join(parentDirectory, 'task.json'), 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(root, result.directory, 'skill.md'), 'utf8')).not.toContain('Do not duplicate this text.')
  })

  it('automatically chooses a valid child level when the UI or agent omits level', () => {
    const { root } = fixture({ hierarchy: { strictLevelStep: true } })
    const parent = createTaskDocuments(root, { title: 'Parent task' })
    const before = fs.readFileSync(path.join(root, parent.directory, 'task.json'), 'utf8')
    const child = createTaskDocuments(root, { title: 'Child task', parentId: parent.taskId })
    expect(loadCreated(root, child).task.relations).toMatchObject({ parent: parent.taskId, level: 'subtask' })
    expect(fs.readFileSync(path.join(root, parent.directory, 'task.json'), 'utf8')).toBe(before)
  })

  it('uses a configured agent member when no human default exists', () => {
    const { root } = fixture({ members: [{ id: 'copilot', name: 'Copilot', kind: 'agent' }] })
    expect(getTaskCreationContext(root).defaults.owner).toBe('copilot')
    expect(loadCreated(root, createTaskDocuments(root, { title: 'Agent-owned task' })).task.owner).toBe('copilot')
  })

  it('chooses a configured default when the task level is absent', () => {
    const { root } = fixture({ levels: [{ id: 'epic', title: 'Epic', rank: 0 }, { id: 'story', title: 'Story', rank: 2 }] })
    expect(getTaskCreationContext(root).defaults.level).toBe('story')
    expect(loadCreated(root, createTaskDocuments(root, { title: 'Story' })).task.relations.level).toBe('story')
    expect(() => createTaskDocuments(root, { title: 'Invalid', level: 'task' })).toThrow(/not configured/)
  })

  it('reserves IDs from live/archive task data, malformed directories and occupied files without overwriting', () => {
    const { root } = fixture()
    const existing = writeTask(root, makeTask({ id: 'T-0001' }))
    writeTask(root, makeTask({ id: 'T-0007' }), 'archive')
    fs.mkdirSync(path.join(root, 'tasks', 'T-0010-broken'))
    fs.writeFileSync(path.join(root, 'tasks', 'T-0010-broken', 'task.json'), '{broken')
    fs.mkdirSync(path.join(root, 'archive', 'unexpected-name'))
    fs.writeFileSync(path.join(root, 'archive', 'unexpected-name', 'task.json'), '{"id":"T-0018","invalid":true}')
    const reservation = path.join(root, 'tasks', 'T-0020-reserved')
    fs.writeFileSync(reservation, 'occupied, not a task directory')
    const before = fs.readFileSync(path.join(existing, 'task.json'), 'utf8')
    expect(createTaskDocuments(root, { title: 'Reserved' }).taskId).toBe('T-0021')
    expect(fs.readFileSync(reservation, 'utf8')).toBe('occupied, not a task directory')
    expect(fs.readFileSync(path.join(existing, 'task.json'), 'utf8')).toBe(before)
  })

  it('allows unrelated existing document errors but validates the generated task', () => {
    const { root } = fixture()
    const existing = writeTask(root, makeTask({ id: 'T-0001' }))
    fs.writeFileSync(path.join(existing, 'Plan.md'), '---\ndoc: incorrect\nupdated: "2026-09-17"\n---\n')
    const result = createTaskDocuments(root, { title: 'Independent task' })
    const checked = validateDocuments(root)
    expect(checked.issues.some((item) => item.taskId === 'T-0001' && item.severity === 'error')).toBe(true)
    expect(checked.issues.filter((item) => item.taskId === result.taskId && item.severity === 'error')).toEqual([])
  })

  it.each([
    { taskIdPrefix: 'WORK-' }, { taskIdWidth: 5 },
    { members: [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }] },
    { levels: [{ id: 'task', rank: 0, title: 'One' }, { id: 'task', rank: 1, title: 'Two' }] },
    { paths: { tasks: '../outside' } }, { paths: { tasks: '.git/tasks' } },
    { paths: { tasks: '.agentdesk/cache/tasks' } }, { paths: { tasks: 'tasks', archive: 'tasks/archive' } },
  ])('rejects incompatible creation configuration without creating tasks: %j', (overrides) => {
    const { root } = fixture(overrides)
    expect(() => createTaskDocuments(root, { title: 'Invalid config' })).toThrow()
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false)
  })

  it('does not fall back to a default workspace for missing or malformed config', () => {
    const { root } = fixture()
    const config = path.join(root, '.agentdesk', 'config.json')
    fs.writeFileSync(config, '{}')
    expect(() => getTaskCreationContext(root)).toThrow()
    fs.unlinkSync(config)
    expect(() => createTaskDocuments(root, { title: 'Missing config' })).toThrow()
    expect(cacheEntries(root)).toEqual([])
  })

  it('rejects unknown owners, archived/missing parents, inverted ranks and excessive depth', () => {
    const { root } = fixture({ hierarchy: { maxDepth: 2, strictLevelStep: true } })
    writeTask(root, makeTask({ id: 'T-0001', level: 'story' }))
    writeTask(root, makeTask({ id: 'T-0002', level: 'task', parent: 'T-0001' }))
    writeTask(root, makeTask({ id: 'T-0003', level: 'story' }), 'archive')
    expect(() => createTaskDocuments(root, { title: 'Owner', owner: 'unknown' })).toThrow(/member/)
    expect(() => createTaskDocuments(root, { title: 'Missing', parentId: 'T-0099' })).toThrow(/valid, live/)
    expect(() => createTaskDocuments(root, { title: 'Archive', parentId: 'T-0003' })).toThrow(/valid, live/)
    expect(() => createTaskDocuments(root, { title: 'Same level', parentId: 'T-0002', level: 'task' })).toThrow(/ranks/)
    expect(() => createTaskDocuments(root, { title: 'Skipped level', parentId: 'T-0001', level: 'subtask' })).toThrow(/strictLevelStep/)
    expect(() => createTaskDocuments(root, { title: 'Too deep', parentId: 'T-0002', level: 'subtask' })).toThrow(/maxDepth/)
    expect(getTaskCreationContext(root).parents.map((item) => item.id)).toEqual(['T-0001'])
    expect(cacheEntries(root)).toEqual([])
  })

  it('rejects parent chains containing missing parents, duplicate IDs or cycles', () => {
    const { root } = fixture()
    writeTask(root, makeTask({ id: 'T-0001', level: 'story', parent: 'T-0090' }))
    expect(() => createTaskDocuments(root, { title: 'Orphan chain', parentId: 'T-0001' })).toThrow(/valid, live/)
    writeTask(root, makeTask({ id: 'T-0002', level: 'story' }))
    writeTask(root, { ...makeTask({ id: 'T-0002', level: 'story' }), slug: 'duplicate' })
    expect(() => createTaskDocuments(root, { title: 'Ambiguous', parentId: 'T-0002' })).toThrow(/valid, live/)
    writeTask(root, makeTask({ id: 'T-0003', level: 'feature', parent: 'T-0004' }))
    writeTask(root, makeTask({ id: 'T-0004', level: 'story', parent: 'T-0003' }))
    expect(() => createTaskDocuments(root, { title: 'Cyclic', parentId: 'T-0004' })).toThrow(/cycle|ranks/)
  })

  it('rejects exhausted IDs, excess tasks and oversized existing task files', () => {
    const exhausted = fixture().root
    fs.mkdirSync(path.join(exhausted, 'archive', 'T-9999-reserved'), { recursive: true })
    expect(() => createTaskDocuments(exhausted, { title: 'Exhausted' })).toThrow(/exhausted/)
    const full = fixture().root
    for (let i = 1; i <= 1000; i++) fs.mkdirSync(path.join(full, 'tasks', `T-${String(i).padStart(4, '0')}-reserved`), { recursive: true })
    expect(() => createTaskDocuments(full, { title: 'Full' })).toThrow(/1,000 task limit/)
    const oversized = fixture().root
    const existing = writeTask(oversized, makeTask({ id: 'T-0001' }))
    fs.writeFileSync(path.join(existing, 'task.json'), ' '.repeat(1024 * 1024 + 1))
    expect(() => createTaskDocuments(oversized, { title: 'Oversized' })).toThrow(/1 MB file limit/)
  })

  it('fails visibly on a busy/stale root lock and never removes another owner lock', () => {
    const { root } = fixture()
    const cache = path.join(root, '.agentdesk', 'cache')
    fs.mkdirSync(cache)
    const lock = path.join(cache, 'task-creation.lock')
    const original = '{"token":"another-owner","pid":1,"at":"2000-01-01T00:00:00Z"}\n'
    fs.writeFileSync(lock, original)
    expect(() => createTaskDocuments(root, { title: 'Busy' })).toThrow(/busy or.*stale/)
    expect(fs.readFileSync(lock, 'utf8')).toBe(original)
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false)
  })

  it('publishes one complete directory by rename, and releases its own staging and lock', () => {
    const { root } = fixture()
    const rename = fs.renameSync
    const publish = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      expect(fs.readdirSync(path.join(root, 'tasks'))).toEqual([])
      expect(fs.existsSync(path.join(String(from), 'task.json'))).toBe(true)
      expect(fs.existsSync(path.join(String(from), 'Checklist.md'))).toBe(true)
      expect(fs.existsSync(path.join(String(from), 'designs'))).toBe(true)
      expect(fs.existsSync(path.join(String(from), 'ref'))).toBe(true)
      rename(from, to)
    })
    createTaskDocuments(root, { title: 'Atomic' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(cacheEntries(root)).toEqual([])
  })

  it('leaves no partial task on publication failure and preserves unrelated cache files', () => {
    const { root } = fixture()
    fs.mkdirSync(path.join(root, '.agentdesk', 'cache'))
    fs.writeFileSync(path.join(root, '.agentdesk', 'cache', 'unrelated.json'), '{"keep":true}')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Simulated rename failure') })
    expect(() => createTaskDocuments(root, { title: 'Failure' })).toThrow(/Simulated rename failure/)
    expect(fs.readdirSync(path.join(root, 'tasks'))).toEqual([])
    expect(cacheEntries(root)).toEqual(['unrelated.json'])
  })

  it('detects changed reservations before publishing instead of creating a colliding ID', () => {
    const { root } = fixture()
    const directory = writeTask(root, makeTask({ id: 'T-0001' }))
    const sync = fs.fsyncSync
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
      sync(fd)
      fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(makeTask({ id: 'T-0002' })))
    })
    expect(() => createTaskDocuments(root, { title: 'Race' })).toThrow(/changed during creation/)
    expect(fs.readdirSync(path.join(root, 'tasks'))).toEqual(['T-0001-t-0001'])
    expect(cacheEntries(root)).toEqual([])
  })

  it('preserves a replacement lock whose ownership changed while staging', () => {
    const { root } = fixture()
    const lock = path.join(root, '.agentdesk', 'cache', 'task-creation.lock')
    const sync = fs.fsyncSync
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
      sync(fd)
      fs.unlinkSync(lock)
      fs.writeFileSync(lock, 'replacement-owner')
    })
    expect(() => createTaskDocuments(root, { title: 'Ownership race' })).toThrow(/ownership changed/)
    expect(fs.readFileSync(lock, 'utf8')).toBe('replacement-owner')
    expect(fs.readdirSync(path.join(root, 'tasks'))).toEqual([])
  })

  it('rejects linked roots, linked ancestors, linked task/cache stores and hard-linked config files', () => {
    const { root } = fixture()
    const { root: outside } = fixture()
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const alias = path.join(outside, 'alias')
    fs.symlinkSync(root, alias, linkType)
    expect(() => createTaskDocuments(alias, { title: 'Linked root' })).toThrow(/Linked workspace/)
    fs.mkdirSync(path.join(root, 'nested'))
    expect(() => createTaskDocuments(path.join(alias, 'nested'), { title: 'Linked ancestor' })).toThrow(/Linked workspace/)
    fs.symlinkSync(outside, path.join(root, 'tasks'), linkType)
    expect(() => createTaskDocuments(root, { title: 'Outside tasks' })).toThrow(/link|Linked/)
    fs.unlinkSync(path.join(root, 'tasks'))
    fs.mkdirSync(path.join(root, 'internal-cache'))
    fs.symlinkSync(path.join(root, 'internal-cache'), path.join(root, '.agentdesk', 'cache'), linkType)
    expect(() => createTaskDocuments(root, { title: 'Inside link' })).toThrow(/Linked/)
    fs.unlinkSync(path.join(root, '.agentdesk', 'cache'))
    fs.linkSync(path.join(root, '.agentdesk', 'config.json'), path.join(root, 'config-copy.json'))
    expect(() => createTaskDocuments(root, { title: 'Hard link' })).toThrow(/Hard-linked/)
    expect(fs.existsSync(path.join(outside, 'tasks'))).toBe(false)
  })
})

describe('strict agent creation drafts and CLI', () => {
  it.each([
    { title: '' }, { title: ' '.repeat(3) }, { title: 'x'.repeat(121) },
    { title: 'Task', description: 'x'.repeat(8001) },
    { title: 'Task', acceptance: [''] }, { title: 'Task', acceptance: ['two\nlines'] },
    { title: 'Task', acceptance: ['x'.repeat(501)] }, { title: 'Task', acceptance: Array(31).fill('criterion') },
    { title: 'Task', status: 'done' }, { title: 'Task', allowedPaths: ['**'] },
    { title: 'Task', relations: { parent: 'T-0001' } }, { title: 'Task', slug: '../escape' },
    { title: 'Task', type: 'unknown' }, { title: 'Task', parentId: 'T-10000' },
  ])('rejects an invalid or over-broad draft: %j', (draft) => {
    expect(taskCreationDraftSchema.safeParse(draft).success).toBe(false)
  })

  it('prints only the concise JSON result for flag-based agent creation', () => {
    const { root } = fixture()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(run([
      'create', '--title', 'Agent task', '--description', 'Describe the work',
      '--owner', 'tester', '--level', 'task', '--type', 'chore', '--priority', 'P3',
      '--slug', 'agent-task', '--acceptance', 'First', '--acceptance', 'Second', '--actor', 'copilot', '--root', root,
    ], root)).toBe(0)
    expect(output).toHaveBeenCalledTimes(1)
    const result = resultSchema.parse(JSON.parse(String(output.mock.calls[0][0])))
    expect(result).toEqual({ taskId: 'T-0001', directory: 'tasks/T-0001-agent-task' })
    expect(loadCreated(root, result).task.history[0]).toMatchObject({ by: 'copilot', note: 'Created via agent.' })
  })

  it('loads a workspace-relative JSON draft from --root rather than the process cwd', () => {
    const { root } = fixture()
    const { root: cwd } = fixture()
    fs.writeFileSync(path.join(root, 'draft.json'), JSON.stringify({ title: 'Imported', description: '\u4e2d\u6587', parentId: null, acceptance: ['Unfinished'] }))
    const before = fs.readFileSync(path.join(root, 'draft.json'))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(run(['create', '--draft', 'draft.json', '--actor', 'copilot', '--root', root], cwd)).toBe(0)
    const result = resultSchema.parse(JSON.parse(String(output.mock.calls[0][0])))
    expect(loadCreated(root, result).task.title).toBe('Imported')
    expect(fs.readFileSync(path.join(root, 'draft.json'))).toEqual(before)
    expect(fs.existsSync(path.join(cwd, 'tasks'))).toBe(false)
  })

  it.each([
    ['--title', 'Task', '--unknown', 'x'], ['--title'], ['--title', 'First', '--title', 'Second'],
    ['--title', 'Task', '--status', 'done'], ['--title', 'Task', '--acceptance'],
    ['--draft', 'draft.json', '--title', 'Override'], ['--draft', 'draft.json', '--acceptance', 'Override'],
    ['--draft', 'draft.json', '--owner', 'tester'], ['--draft', 'draft.json', '--parent', 'T-0001'],
    ['--draft', 'draft.json', '--description', ''],
  ])('rejects unsupported, duplicate, incomplete or mixed CLI options: %j', (...args) => {
    const { root } = fixture()
    fs.writeFileSync(path.join(root, 'draft.json'), '{"title":"Draft"}')
    expect(() => run(['create', ...args, '--root', root], root)).toThrow()
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false)
  })

  it('rejects outside, hard-linked, invalid UTF-8, oversized and non-strict JSON drafts', () => {
    const { root } = fixture()
    const { root: outside } = fixture()
    const external = path.join(outside, 'draft.json')
    fs.writeFileSync(external, '{"title":"Outside"}')
    expect(() => readTaskCreationDraft(root, external)).toThrow(/escapes/)
    const draft = path.join(root, 'draft.json')
    fs.linkSync(external, draft)
    expect(() => readTaskCreationDraft(root, draft)).toThrow(/Hard-linked/)
    fs.unlinkSync(draft)
    for (const content of ['{"title":"Task","status":"done"}', '{invalid', ' '.repeat(128 * 1024 + 1), Buffer.from([0xff])]) {
      fs.writeFileSync(draft, content)
      expect(() => readTaskCreationDraft(root, draft)).toThrow()
    }
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false)
  })
})
