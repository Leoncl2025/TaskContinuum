import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { WorkspaceDescriptor, WorkspaceRepositoryPushPlan, WorkspaceRepositoryStatus, WorkspaceSnapshot, WorkspaceState } from '../shared/workspace'
import { readTaskWorkspace } from './workspaceReader'
import { readRepositorySessionLinks, removeRepositorySessionLink, sessionOwnerSchema, updateRepositoryAgentHostLink } from './repositorySessionLinks'
import type { SessionLinksSnapshot, SessionOwner } from '../shared/sessionBindings'
import { readClientIdentity } from './clientIdentity'
import { recordLocalLink } from './linkedSessionPolicy'
import type { AgentHostTarget } from '../shared/agentHost'
import { agentHostChatIdSchema, agentHostKey, agentHostSessionIdSchema, agentHostTargetSchema } from './agentHostProtocol'
import { createWorkspaceRepositorySchema, repositoryPushRequestSchema, workspaceRepositoryIdSchema, WorkspaceRepositoryService } from './workspaceRepository'
import { createTaskDocuments, getTaskCreationContext } from './taskDocuments/create'
import type { CreateWorkspaceTaskResult, WorkspaceTaskCreationContext } from '../shared/taskCreation'
import { createWorkspaceTaskRequestSchema, taskAgentInstructions, taskAgentInstructionsRequestSchema } from './workspaceTaskCreation'

const descriptorSchema = z.object({ id: z.string().regex(/^[a-f\d]{64}$/), name: z.string().max(300), title: z.string().max(200), root: z.string().min(1).max(4096) })
const stateSchema = z.object({ currentId: z.string().nullable(), recent: z.array(descriptorSchema).max(10) })
const linkRequestSchema = z.object({
  workspaceId: z.string().regex(/^[a-f\d]{64}$/), taskId: z.string().regex(/^T-\d{4,}$/),
  expectedRevision: z.string().regex(/^[a-f\d]{64}$/).nullable(),
}).strict()
const linkChangeSchema = z.union([
  linkRequestSchema.extend({
    sessionId: agentHostSessionIdSchema,
    agentHost: z.object({ chatId: agentHostChatIdSchema }).strict(),
    owner: sessionOwnerSchema,
  }),
  linkRequestSchema.extend({ sessionId: z.null() }),
])

function descriptor(snapshot: WorkspaceSnapshot): WorkspaceDescriptor {
  return { id: snapshot.id, name: snapshot.name, title: snapshot.title, root: snapshot.root }
}

function visibleLinks(snapshot: SessionLinksSnapshot, localOwner?: SessionOwner): SessionLinksSnapshot {
  return { document: snapshot.document, revision: snapshot.revision, ...(localOwner ? { localOwner } : {}) }
}

export class WorkspaceStore {
  private readonly stateFile: string
  private readonly startupFolder?: string
  private state: WorkspaceState = { current: null, recent: [] }
  private loading?: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly stateDirectory: string, startupFolder?: string, private readonly verifyAgentHost?: (root: string, target: AgentHostTarget) => Promise<AgentHostTarget>, private readonly repositories = new WorkspaceRepositoryService()) {
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

  createRepository(value: unknown): Promise<WorkspaceState> {
    return this.update(async () => {
      const request = createWorkspaceRepositorySchema.parse(value)
      const root = await this.repositories.create(request)
      try { return await this.open(root) } catch (error) {
        throw new Error(`The repository was created at ${root}, but could not be selected or saved. Use Open existing to recover it. ${error instanceof Error ? error.message : 'Workspace history could not be saved.'}`)
      }
    })
  }

  getRepositoryStatus(value: unknown): Promise<WorkspaceRepositoryStatus> {
    return this.update(() => this.repositories.status(this.repositoryWorkspace(workspaceRepositoryIdSchema.parse(value))))
  }

  getTaskCreationContext(value: unknown): Promise<WorkspaceTaskCreationContext> {
    return this.update(async () => {
      const workspace = this.repositoryWorkspace(workspaceRepositoryIdSchema.parse(value))
      return { workspaceId: workspace.id, ...getTaskCreationContext(workspace.root) }
    })
  }

  createTask(value: unknown): Promise<CreateWorkspaceTaskResult> {
    return this.update(async () => {
      const request = createWorkspaceTaskRequestSchema.parse(value)
      const workspace = this.repositoryWorkspace(request.workspaceId)
      const created = createTaskDocuments(workspace.root, request.draft, { source: 'ui' })
      try {
        return { state: await this.open(workspace.root), taskId: created.taskId }
      } catch (error) {
        throw new Error(`Task ${created.taskId} was created at ${created.directory}, but the workspace could not be refreshed. Use Refresh workspace instead of creating it again. ${error instanceof Error ? error.message : 'Workspace history could not be saved.'}`)
      }
    })
  }

  getTaskAgentInstructions(value: unknown, cliPath?: string): Promise<string> {
    return this.update(async () => {
      const request = taskAgentInstructionsRequestSchema.parse(value)
      const workspace = this.repositoryWorkspace(request.workspaceId)
      return taskAgentInstructions(getTaskCreationContext(workspace.root), request, cliPath)
    })
  }

  getRepositoryCreationUrl(value: unknown): Promise<string> {
    return this.update(async () => this.repositories.creationUrl(this.repositoryWorkspace(workspaceRepositoryIdSchema.parse(value))))
  }

  getRepositoryPushPlan(value: unknown): Promise<WorkspaceRepositoryPushPlan> {
    return this.update(async () => {
      const request = repositoryPushRequestSchema.parse(value)
      return this.repositories.preparePush(this.repositoryWorkspace(request.workspaceId), request.remoteUrl)
    })
  }

  verifyRepositoryPublication(value: unknown): Promise<{ url: string }> {
    return this.update(async () => {
      const request = repositoryPushRequestSchema.parse(value)
      return this.repositories.verifyPublication(this.repositoryWorkspace(request.workspaceId), request.remoteUrl)
    })
  }

  private repositoryWorkspace(workspaceId: string): WorkspaceSnapshot {
    const workspace = this.state.current
    if (!workspace || workspace.id !== workspaceId) throw new Error('The active workspace changed. Select the intended workspace before continuing.')
    return workspace
  }

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

  closeWorkspace(): Promise<WorkspaceState> {
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
    return this.update(async () => visibleLinks(await readRepositorySessionLinks(this.selectedWorkspace(workspaceId).root), await this.localOwner()))
  }

  private async localOwner(): Promise<SessionOwner> {
    const { clientId, machineName } = await readClientIdentity(this.stateDirectory)
    return { clientId, machineName }
  }

  updateSessionLink(value: unknown): Promise<SessionLinksSnapshot> {
    return this.update(async () => {
      const request = linkChangeSchema.parse(value)
      const workspace = this.selectedWorkspace(request.workspaceId)
      if (request.sessionId !== null && !(await readTaskWorkspace(workspace.root)).tasks.some((task) => task.id === request.taskId)) {
        throw new Error('This task no longer exists in the selected workspace.')
      }
      const localOwner = await this.localOwner()
      let saved: SessionLinksSnapshot
      if (request.sessionId === null) {
        saved = await removeRepositorySessionLink(workspace.root, request.taskId, request.expectedRevision)
      } else {
        if (!this.verifyAgentHost) throw new Error('Agent Host links require a verified target and its owner. The Agent Host verifier is unavailable.')
        const target = agentHostTargetSchema.parse({ ...request.agentHost, sessionId: request.sessionId, owner: request.owner })
        const verified = agentHostTargetSchema.parse(await this.verifyAgentHost(workspace.root, target))
        if (agentHostKey(verified) !== agentHostKey(target)) throw new Error('The verified Agent Host identity changed.')
        saved = await updateRepositoryAgentHostLink(workspace.root, request.taskId, verified, request.expectedRevision)
      }
      await recordLocalLink(this.stateDirectory, workspace.root, request.taskId, saved.document.bindings[request.taskId], localOwner)
      return visibleLinks(saved, localOwner)
    })
  }
}