import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { WorkspaceDescriptor, WorkspaceSnapshot, WorkspaceState } from '../shared/workspace'
import { readTaskWorkspace } from './workspaceReader'
import { migrateRepositorySessionLinks, readRepositorySessionLinks, sessionLinkSchema, updateRepositorySessionLink } from './repositorySessionLinks'
import type { SessionLinksSnapshot } from '../shared/sessionBindings'

const descriptorSchema = z.object({ id: z.string().regex(/^[a-f\d]{64}$/), name: z.string().max(300), title: z.string().max(200), root: z.string().min(1).max(4096) })
const stateSchema = z.object({ currentId: z.string().nullable(), recent: z.array(descriptorSchema).max(10) })
const linkChangeSchema = z.object({
  workspaceId: z.string().regex(/^[a-f\d]{64}$/), taskId: z.string().regex(/^T-\d{4,}$/),
  sessionId: z.string().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).nullable(),
  vscodeWorkspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  expectedRevision: z.string().regex(/^[a-f\d]{64}$/).nullable(),
}).strict()
const migrationSchema = z.object({
  workspaceId: z.string().regex(/^[a-f\d]{64}$/),
  bindings: z.record(z.string().regex(/^T-\d{4,}$/), sessionLinkSchema),
}).strict()

function descriptor(snapshot: WorkspaceSnapshot): WorkspaceDescriptor {
  return { id: snapshot.id, name: snapshot.name, title: snapshot.title, root: snapshot.root }
}

export class WorkspaceStore {
  private readonly stateFile: string
  private readonly startupFolder?: string
  private state: WorkspaceState = { current: null, recent: [] }
  private loading?: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()

  constructor(stateDirectory: string, startupFolder?: string) {
    this.stateFile = join(stateDirectory, 'workspaces.json')
    this.startupFolder = startupFolder
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      let currentId: string | null = null
      try {
        if ((await stat(this.stateFile)).size > 65536) throw new Error('Workspace history exceeds its size limit.')
        const saved = stateSchema.parse(JSON.parse(await readFile(this.stateFile, 'utf8')))
        this.state.recent = saved.recent
        currentId = saved.currentId
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state.warning = 'Saved workspace history could not be read. Open a workspace folder to continue.'
      }
      const root = this.startupFolder ?? this.state.recent.find((item) => item.id === currentId)?.root
      if (!root) return
      try {
        const current = await readTaskWorkspace(root)
        this.state = { current, recent: [descriptor(current), ...this.state.recent.filter((item) => item.id !== current.id)].slice(0, 10) }
        if (this.startupFolder) await this.save(this.state)
      } catch (error) {
        this.state.warning = `The previous workspace could not be opened: ${error instanceof Error ? error.message : 'Folder unavailable.'}`
      }
    })()
    return this.loading
  }

  private async save(next: WorkspaceState): Promise<void> {
    const content = JSON.stringify({ currentId: next.current?.id ?? null, recent: next.recent }, null, 2) + '\n'
    await mkdir(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.stateFile)
    } finally { await rm(temporary, { force: true }) }
  }

  private update<Result>(action: () => Promise<Result>): Promise<Result> {
    const work = this.pending.then(async () => { await this.load(); return action() })
    this.pending = work.catch(() => undefined)
    return work
  }

  async getState(): Promise<WorkspaceState> {
    await this.pending
    await this.load()
    return structuredClone(this.state)
  }

  private async open(root: string): Promise<WorkspaceState> {
    const current = await readTaskWorkspace(root)
    const next: WorkspaceState = { current, recent: [descriptor(current), ...this.state.recent.filter((item) => item.id !== current.id)].slice(0, 10) }
    await this.save(next)
    this.state = next
    return structuredClone(next)
  }

  openFolder(root: string): Promise<WorkspaceState> { return this.update(() => this.open(root)) }

  openRecent(id: unknown): Promise<WorkspaceState> {
    return this.update(async () => {
      const selected = this.state.recent.find((item) => typeof id === 'string' && item.id === id)
      if (!selected) throw new Error('That workspace is not in the recent list. Use Open workspace folder.')
      return this.open(selected.root)
    })
  }

  refresh(): Promise<WorkspaceState> {
    return this.update(async () => this.state.current ? this.open(this.state.current.root) : structuredClone(this.state))
  }

  useDemo(): Promise<WorkspaceState> {
    return this.update(async () => {
      const next = { current: null, recent: this.state.recent }
      await this.save(next)
      this.state = next
      return structuredClone(next)
    })
  }

  private selectedWorkspace(workspaceId: unknown): WorkspaceSnapshot {
    const workspace = this.state.current
    if (!workspace || workspace.id !== workspaceId) throw new Error('The active workspace changed. Reopen the task before changing its session link.')
    return workspace
  }

  getSessionLinks(workspaceId: unknown): Promise<SessionLinksSnapshot> {
    return this.update(() => readRepositorySessionLinks(this.selectedWorkspace(workspaceId).root))
  }

  updateSessionLink(value: unknown): Promise<SessionLinksSnapshot> {
    return this.update(async () => {
      const request = linkChangeSchema.parse(value)
      const workspace = this.selectedWorkspace(request.workspaceId)
      if (request.sessionId !== null && !(await readTaskWorkspace(workspace.root)).tasks.some((task) => task.id === request.taskId)) {
        throw new Error('This task no longer exists in the selected workspace.')
      }
      return updateRepositorySessionLink(workspace.root, request.taskId, request.sessionId, request.expectedRevision, request.vscodeWorkspaceStorageId)
    })
  }

  migrateSessionLinks(value: unknown): Promise<SessionLinksSnapshot> {
    return this.update(async () => {
      const request = migrationSchema.parse(value)
      const workspace = this.selectedWorkspace(request.workspaceId)
      const taskIds = new Set((await readTaskWorkspace(workspace.root)).tasks.map((task) => task.id))
      if (Object.keys(request.bindings).some((id) => !taskIds.has(id))) throw new Error('A local session link refers to a task that no longer exists.')
      return migrateRepositorySessionLinks(workspace.root, request.bindings)
    })
  }
}