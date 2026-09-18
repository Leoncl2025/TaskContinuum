import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { z } from 'zod/v3'
import { taskCreationDraftSchema, type TaskCreationContext, type TaskCreationDraft } from '../../shared/taskCreation.js'
import { MemberId, Priority, SCHEMA_VERSION, TaskId, TaskType } from '../../shared/taskDocuments/common.js'
import { Config } from '../../shared/taskDocuments/config.js'
import { Task, TASK_KEY_ORDER } from '../../shared/taskDocuments/task.js'
import { DocumentFiles } from './files.js'
import { hashOf } from './hash.js'
import { validateDocuments } from './validation.js'
import type { LoadedTask } from './workspace.js'

export { taskCreationDraftSchema }

const MAX_TASKS = 1000
const MAX_BYTES = 16 * 1024 * 1024
const creationOptions = z.object({
  actor: MemberId.optional(),
  source: z.enum(['ui', 'agent']).optional(),
}).strict()

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// Inspect the lexical path, not just realpath: even an in-workspace junction is
// an alias through which a second writer could otherwise bypass the root lock.
function assertUnlinked(file: string): void {
  let current = path.resolve(file)
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`Linked workspace paths are not allowed for task creation: ${current}`)
    if (stat?.isFile() && stat.nlink !== 1) throw new Error(`Hard-linked workspace files are not allowed: ${current}`)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

class CreationFiles extends DocumentFiles {
  overlay?: { target: string; staging: string }

  override contained(file: string): string {
    const absolute = super.contained(file)
    assertUnlinked(absolute)
    const overlay = this.overlay
    if (!overlay || !inside(overlay.target, absolute)) return absolute
    const physical = super.contained(path.join(overlay.staging, path.relative(overlay.target, absolute)))
    assertUnlinked(physical)
    return physical
  }

  override readdirSync(file: string): string[]
  override readdirSync(file: string, options: { withFileTypes: true }): fs.Dirent[]
  override readdirSync(file: string, options?: { withFileTypes: true }): string[] | fs.Dirent[] {
    const entries = super.readdirSync(file, { withFileTypes: true })
    if (this.overlay && path.resolve(file) === path.dirname(this.overlay.target)) {
      const candidate = super.readdirSync(path.dirname(this.overlay.staging), { withFileTypes: true })
        .find((entry) => entry.name === path.basename(this.overlay!.staging))
      if (!candidate) throw new Error('Task creation staging directory disappeared.')
      if (entries.some((entry) => entry.name.toLowerCase() === candidate.name.toLowerCase())) {
        throw new Error('The task destination is already occupied.')
      }
      entries.push(candidate)
      entries.sort((a, b) => a.name.localeCompare(b.name))
    }
    return options ? entries : entries.map((entry) => entry.name)
  }
}

function openFiles(root: string): CreationFiles {
  const absolute = path.resolve(root)
  assertUnlinked(absolute)
  return new CreationFiles(absolute)
}

function readConfig(files: CreationFiles): Config {
  const config = Config.parse(JSON.parse(files.readFileSync(path.join(files.root, '.agentdesk', 'config.json'), 'utf8')))
  if (config.taskIdPrefix !== 'T-' || config.taskIdWidth !== 4) {
    throw new Error('Task creation requires taskIdPrefix "T-" and taskIdWidth 4 to match the fixed task schema.')
  }
  if (new Set(config.members.map((member) => member.id)).size !== config.members.length ||
      new Set(config.levels.map((level) => level.id)).size !== config.levels.length) {
    throw new Error('Task creation requires unique configured member IDs and level IDs.')
  }
  const directories = [config.paths.tasks, config.paths.archive, config.paths.templates, config.bridge.jobs.dir]
    .map((relative) => {
      if (!relative.trim() || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
        throw new Error('Configured document paths must be workspace-relative directories.')
      }
      const directory = files.contained(path.resolve(files.root, relative))
      if (directory === files.root || inside(path.join(files.root, '.git'), directory)) {
        throw new Error('Configured document paths cannot target the workspace root or Git metadata.')
      }
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
      if (stat && !stat.isDirectory()) throw new Error(`Configured document path is not a directory: ${relative}`)
      return directory
    })
  const [tasks, archive, templates, jobs] = directories
  const metadata = [path.join(files.root, '.agentdesk'), path.join(files.root, '.taskcontinuum')]
  for (const store of [tasks, archive]) {
    for (const other of [store === tasks ? archive : tasks, templates, jobs, ...metadata]) {
      if (inside(store, other) || inside(other, store)) throw new Error('Task/archive directories must not overlap other document stores or metadata.')
    }
  }
  return config
}

interface Inventory {
  reserved: Set<number>
  count: number
  signature: string
}

function inventory(files: CreationFiles, config: Config): Inventory {
  const reserved = new Set<number>()
  const snapshot: string[] = []
  let count = 0
  const reserve = (id: string) => {
    const match = /^T-(\d{4})(?!\d)/i.exec(id)
    if (match) reserved.add(Number(match[1]))
  }
  for (const relative of [config.paths.tasks, config.paths.archive]) {
    const directory = files.contained(path.resolve(files.root, relative))
    if (!files.existsSync(directory)) continue
    for (const entry of files.readdirSync(directory, { withFileTypes: true })) {
      const absolute = files.contained(path.join(directory, entry.name))
      const stat = fs.lstatSync(absolute)
      reserve(entry.name)
      snapshot.push(`${relative}/${entry.name}:${stat.dev}:${stat.ino}:${stat.isDirectory()}`)
      if (!stat.isDirectory()) continue
      if (++count > MAX_TASKS) throw new Error('The workspace exceeds the 1,000 task limit.')
      const taskFile = path.join(absolute, 'task.json')
      if (!files.existsSync(taskFile)) continue
      const text = files.readFileSync(taskFile, 'utf8')
      snapshot.push(`${entry.name}:${hashOf(text)}`)
      let raw: unknown
      try { raw = JSON.parse(text) }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // A malformed reservation still owns the ID encoded in its directory.
        continue
      }
      if (raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string') {
        reserve(raw.id)
      }
    }
  }
  return { reserved, count, signature: hashOf(JSON.stringify(snapshot)) }
}

function readState(files: CreationFiles) {
  const config = readConfig(files)
  const ids = inventory(files, config)
  const validated = validateDocuments(files.root, undefined, files)
  const limit = validated.issues.find((item) => /1 MB file limit|16 MB read limit|20,000 directory entry limit|changed beyond the read limit/.test(item.message))
  if (limit) throw new Error(`Task creation cannot read a bounded workspace: ${limit.message}`)
  return { config, ids, validated }
}

type CreationState = ReturnType<typeof readState>

class HierarchyError extends Error {}

function checkHierarchy(state: CreationState, level: Task['relations']['level'], parentId: string | null): void {
  const ranks = new Map(state.config.levels.map((item) => [item.id, item.rank]))
  let childRank = ranks.get(level)
  if (childRank === undefined) throw new HierarchyError(`Level "${level}" is not configured in this workspace.`)
  const seen = new Set<string>()
  let depth = 1
  let current = parentId
  while (current) {
    if (seen.has(current)) throw new HierarchyError('The selected parent has a hierarchy cycle.')
    seen.add(current)
    const matches = state.validated.workspace.tasks.filter((item) => item.task.id === current)
    if (matches.length !== 1 || matches[0].broken || matches[0].archived) {
      throw new HierarchyError(`Parent ${current} must identify one valid, live task.`)
    }
    const parent = matches[0]
    if (parent.issues.some((item) => item.code === 'DIR_NAME_MISMATCH')) {
      throw new HierarchyError(`Parent ${current} has an incompatible task directory.`)
    }
    const parentRank = ranks.get(parent.task.relations.level)
    if (parentRank === undefined || parentRank >= childRank ||
        (state.config.hierarchy.strictLevelStep && childRank - parentRank !== 1)) {
      throw new HierarchyError('The selected parent violates configured hierarchy ranks or strictLevelStep.')
    }
    if (++depth > state.config.hierarchy.maxDepth) throw new HierarchyError('The selected parent exceeds hierarchy.maxDepth.')
    childRank = parentRank
    current = parent.task.relations.parent
  }
}

function parentChoices(state: CreationState): LoadedTask[] {
  return state.validated.workspace.tasks.filter((item) => {
    if (item.broken || item.archived) return false
    return state.config.levels.some((level) => {
      try { checkHierarchy(state, level.id, item.task.id); return true }
      catch (error) {
        if (!(error instanceof HierarchyError)) throw error
        // Invalid ancestor chains are not offered as parent choices. Creation
        // repeats the same gate and reports the reason if a stale choice is used.
        return false
      }
    })
  })
}

function automaticLevel(state: CreationState, parentId: string | null, fallback: Task['relations']['level']): Task['relations']['level'] {
  if (!parentId) return fallback
  let failure: HierarchyError | undefined
  for (const level of [...state.config.levels].sort((left, right) => left.rank - right.rank)) {
    try { checkHierarchy(state, level.id, parentId); return level.id }
    catch (error) {
      if (!(error instanceof HierarchyError)) throw error
      failure = error
    }
  }
  throw failure ?? new HierarchyError('No configured hierarchy level can be created under the selected parent.')
}

function contextOf(files: CreationFiles, state: CreationState): TaskCreationContext {
  const owner = state.config.members.find((member) => member.kind === 'human') ?? state.config.members[0]
  const levels = [...state.config.levels].sort((a, b) => a.rank - b.rank)
  const level = levels.find((item) => item.id === 'task') ?? levels[levels.length - 1]
  return {
    root: files.root,
    members: state.config.members.map(({ id, name }) => ({ id, name })),
    levels: levels.map(({ id, title, rank }) => ({ id, title, rank })),
    parents: parentChoices(state).map(({ task }) => ({ id: task.id, title: task.title, level: task.relations.level })),
    types: [...TaskType.options],
    priorities: [...Priority.options],
    defaults: { owner: owner.id, level: level.id, type: 'feature', priority: 'P2' },
  }
}

export function getTaskCreationContext(root: string): TaskCreationContext {
  const files = openFiles(root)
  return contextOf(files, readState(files))
}

/** Agent drafts are data, never scripts, and must be regular workspace files. */
export function readTaskCreationDraft(root: string, file: string): TaskCreationDraft {
  const files = openFiles(root)
  const absolute = files.contained(path.resolve(files.root, file))
  const fd = fs.openSync(absolute, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const maximum = 128 * 1024
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) {
      throw new Error('Task drafts must be regular, unlinked JSON files no larger than 128 KB.')
    }
    if (!sameIdentity(stat, fs.lstatSync(files.contained(absolute)))) throw new Error('Task draft changed while opening it.')
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size !== stat.size) throw new Error('Task draft changed while reading it.')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
    return taskCreationDraftSchema.parse(JSON.parse(text))
  } finally { fs.closeSync(fd) }
}

function slugFrom(title: string): string {
  return title.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'task'
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function markdownText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1')
}

function renderDocuments(task: Task, draft: TaskCreationDraft, actor: string, source: 'ui' | 'agent'): Map<string, string> {
  const date = task.dates.created
  const base = `taskId: ${task.id}\nupdated: "${date}"\nauthors: ${JSON.stringify([actor])}\n`
  const document = (kind: string, extra: string, body: string) => `---\ndoc: ${kind}\n${extra}${base}---\n\n${body}\n`
  const ordered = Object.fromEntries(TASK_KEY_ORDER.filter((key) => key in task).map((key) => [key, task[key]]))
  const acceptance = (draft.acceptance ?? []).map((text, index) =>
    `- [ ] \`CL-${String(index + 1).padStart(3, '0')}\` ${markdownText(text)}`)
  return new Map([
    ['task.json', `${JSON.stringify(ordered, null, 2)}\n`],
    ['skill.md', `---\n${base}---\n\n# Task-specific working knowledge\n\nNo task-specific working rules recorded.\n`],
    ['RequirementAnalysis.md', document('requirement-analysis', 'state: todo\nsource: []\n',
      `# ${markdownText(task.title)}\n\n${draft.description ?? 'Requirements have not yet been analyzed.'}`)],
    ['Plan.md', document('plan', 'state: todo\nmilestones: []\n',
      `# Plan\n\n## Progress log\n\n- ${date} (${markdownText(actor)}) Created task via ${source}; planning has not started.`)],
    ['Checklist.md', document('checklist', '', `# Acceptance checklist\n${acceptance.length ? `\n${acceptance.join('\n')}` : ''}`)],
    ['Reference.md', document('reference', 'links: []\n', '# References')],
  ])
}

interface OwnedEntry { file: string; stat: fs.Stats }

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile()
}

function assertOwned(files: CreationFiles, entry: OwnedEntry): void {
  const current = fs.lstatSync(files.contained(entry.file), { throwIfNoEntry: false })
  if (!current || !sameIdentity(current, entry.stat)) throw new Error(`Creation artifact ownership changed; leaving it untouched: ${entry.file}`)
}

function makeDirectory(files: CreationFiles, directory: string): void {
  const target = files.contained(directory)
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
  if (!fs.lstatSync(files.contained(target)).isDirectory()) throw new Error(`Expected a directory: ${target}`)
}

export function createTaskDocuments(
  root: string,
  input: TaskCreationDraft,
  options: { actor?: string; source?: 'ui' | 'agent' } = {},
): { taskId: string; directory: string; files: string[] } {
  const draft = taskCreationDraftSchema.parse(input)
  const settings = creationOptions.parse(options)
  const files = openFiles(root)
  readConfig(files)
  const cache = path.join(files.root, '.agentdesk', 'cache')
  makeDirectory(files, cache)
  // One workspace-wide lock, independent of configured task/archive paths.
  const lockPath = files.contained(path.join(cache, 'task-creation.lock'))
  let lock: number
  try { lock = fs.openSync(lockPath, 'wx', 0o600) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error('Task creation is busy or has a stale task-creation.lock. Inspect the owning process before manually recovering it; the lock was not removed.')
    }
    throw error
  }
  const lockEntry = { file: lockPath, stat: fs.fstatSync(lock) }
  const owned: OwnedEntry[] = []
  let published = false
  let stagedTask: string | undefined
  try {
    fs.writeFileSync(lock, `${JSON.stringify({ token: randomUUID(), pid: process.pid, at: new Date().toISOString() })}\n`)
    const currentFiles = openFiles(root)
    const state = readState(currentFiles)
    const context = contextOf(currentFiles, state)
    if (state.ids.count >= MAX_TASKS) throw new Error('Creating a task would exceed the 1,000 task limit.')
    const next = Math.max(0, ...state.ids.reserved) + 1
    if (next > 9999) throw new Error('The fixed T-XXXX task ID range is exhausted.')
    const taskId = TaskId.parse(`T-${String(next).padStart(4, '0')}`)
    const owner = draft.owner ?? context.defaults.owner
    if (!state.config.members.some((member) => member.id === owner)) throw new Error(`Owner "${owner}" is not a configured workspace member.`)
    const parent = draft.parentId ?? null
    const level = draft.level ?? automaticLevel(state, parent, context.defaults.level)
    checkHierarchy(state, level, parent)
    const actor = settings.actor ?? (settings.source === 'agent' ? 'copilot' : owner)
    const source = settings.source ?? 'ui'
    const now = new Date()
    const task = Task.parse({
      schemaVersion: SCHEMA_VERSION, id: taskId, slug: draft.slug ?? slugFrom(draft.title), title: draft.title,
      type: draft.type ?? context.defaults.type, status: 'backlog', priority: draft.priority ?? context.defaults.priority, owner,
      relations: { level, parent }, dates: { created: localDate(now) },
      lifecycle: {
        requirement: { state: 'todo' }, plan: { state: 'todo' }, design: { state: 'todo' },
        checklist: { state: 'todo' }, reference: { state: 'todo' },
      },
      progress: {}, today: {}, copilot: { phase: 'analyze', entryDoc: 'RequirementAnalysis.md' }, sync: {},
      history: [{ at: now.toISOString(), by: actor, field: 'created', from: null, to: taskId, note: `Created via ${source}.` }],
    })
    const documents = renderDocuments(task, draft, actor, source)
    const bytes = [...currentFiles.texts.values(), ...documents.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    if (bytes > MAX_BYTES) throw new Error('Creating this task would exceed the 16 MB workspace read limit.')
    const taskRoot = path.resolve(files.root, state.config.paths.tasks)
    makeDirectory(files, taskRoot)
    // Empty/missing containers reserve no IDs, so creating the container must
    // not conceal an intervening edit to any existing reservation.
    const baseline = inventory(openFiles(root), state.config)
    if (baseline.signature !== state.ids.signature) throw new Error('Task reservations changed during creation. Retry with fresh context.')
    const destination = files.contained(path.join(taskRoot, `${task.id}-${task.slug}`))
    if (fs.existsSync(destination)) throw new Error('The task destination is already occupied.')
    const stage = files.contained(path.join(cache, `task-create-${randomUUID()}`))
    stagedTask = path.join(stage, path.basename(destination))
    for (const directory of [stage, stagedTask, path.join(stagedTask, 'designs'), path.join(stagedTask, 'ref')]) {
      fs.mkdirSync(files.contained(directory))
      owned.push({ file: directory, stat: fs.lstatSync(directory) })
    }
    for (const [name, content] of documents) {
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Generated task document exceeds the 1 MB file limit.')
      const file = files.contained(path.join(stagedTask, name))
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        owned.push({ file, stat: fs.fstatSync(fd) })
        fs.writeFileSync(fd, content, 'utf8')
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
    }
    const previous = new Set(state.validated.issues.filter((item) => item.severity === 'error').map((item) => JSON.stringify(item)))
    currentFiles.overlay = { target: destination, staging: stagedTask }
    const validated = validateDocuments(files.root, undefined, currentFiles)
    const errors = validated.issues.filter((item) => item.severity === 'error' &&
      (item.taskId === taskId || !previous.has(JSON.stringify(item))))
    const loaded = validated.workspace.tasks.find((item) => item.task.id === taskId)
    if (!loaded || loaded.broken || errors.length) {
      throw new Error(`Task creation rejected: ${errors.map((item) => `${item.code}: ${item.message}`).join('; ') || 'new task could not be loaded'}`)
    }
    const fresh = openFiles(root)
    const config = readConfig(fresh)
    const configFile = path.join(files.root, '.agentdesk', 'config.json')
    if (hashOf(fresh.readFileSync(configFile, 'utf8')) !== hashOf(currentFiles.readFileSync(configFile, 'utf8')) ||
        inventory(fresh, config).signature !== baseline.signature) {
      throw new Error('Workspace configuration or task IDs changed during creation. Retry with fresh context.')
    }
    assertOwned(files, lockEntry)
    for (const entry of owned) assertOwned(files, entry)
    if (fs.existsSync(files.contained(destination))) throw new Error('The task destination is already occupied.')
    fs.renameSync(files.contained(stagedTask), files.contained(destination))
    published = true
    const directory = path.relative(files.root, destination).split(path.sep).join('/')
    return { taskId, directory, files: [...documents.keys()].map((name) => `${directory}/${name}`) }
  } finally {
    try {
      for (const entry of owned) {
        if (!published || !stagedTask || !inside(stagedTask, entry.file)) assertOwned(files, entry)
      }
      for (const entry of [...owned].reverse()) {
        if (published && stagedTask && inside(stagedTask, entry.file)) continue
        if (entry.stat.isDirectory()) fs.rmdirSync(files.contained(entry.file))
        else fs.unlinkSync(files.contained(entry.file))
      }
    } finally {
      try {
        assertOwned(files, lockEntry)
        fs.unlinkSync(files.contained(lockPath))
      } finally { fs.closeSync(lock) }
    }
  }
}
