import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../shared/agentHostCreation'
import type { AgentHostCreationDevices } from './agentHostCreationClient'
import { agentHostCreateCommandSchema, agentHostCreateRequestSchema, creationRevisionSchema, creationTaskIdSchema } from './agentHostCreationProtocol'
import { AgentHostCreationRequestError, agentHostCreationWorkspaceId, describeAgentHostCreationWorkspace } from './agentHostCreationService'
import type { AgentHostCreationService } from './agentHostCreationService'
import type { AgentHostRegistry } from './agentHostRegistry'
import { canonicalPolicyRoot } from './linkedSessionPolicy'

type Guard = () => Promise<void>

export class LocalTaskAgentHostWorker {
  private readonly roots = new Map<string, string>()

  constructor(private readonly registry: AgentHostRegistry,
    private readonly service: () => AgentHostCreationService,
    private readonly allowed: (root: string) => Promise<boolean>) {}

  async owns(workerId: string): Promise<boolean> { return workerId === (await this.registry.creationOwner()).clientId }

  private async scope(root: string) {
    root = await canonicalPolicyRoot(root)
    const workspaceId = await agentHostCreationWorkspaceId(root)
    if (!this.roots.has(workspaceId) && this.roots.size >= 100) throw new Error('The local task creation workspace limit was reached.')
    this.roots.set(workspaceId, root)
    return { root, workspaceId }
  }

  async authorize(ownerId: string, workspaceId: string): Promise<string> {
    const root = this.roots.get(workspaceId)
    if (!root || !await this.owns(ownerId) || await canonicalPolicyRoot(root) !== root) {
      throw new AgentHostCreationRequestError(403, 'The original local execution owner or workspace is unavailable.')
    }
    if (!await this.allowed(root)) throw new AgentHostCreationRequestError(403, 'Enable local Agent Host access for this workspace before creating a task session.')
    return root
  }

  async worker(root: string, taskId: string): Promise<AgentHostWorker> {
    creationTaskIdSchema.parse(taskId)
    const owner = await this.registry.creationOwner()
    const worker: AgentHostWorker = { id: owner.clientId, owner, local: true, state: 'blocked', hosts: [], workspaces: [] }
    try {
      const scope = await this.scope(root)
      await this.authorize(owner.clientId, scope.workspaceId)
      await this.service().checkReady()
      const workspace = await describeAgentHostCreationWorkspace(scope.root, taskId, true)
      const hosts = await this.registry.creationHosts(AbortSignal.timeout(8000))
      await this.authorize(owner.clientId, scope.workspaceId)
      return { ...worker, state: 'connected', hosts, workspaces: [workspace] }
    } catch (error) {
      return { ...worker, error: (error instanceof Error ? error.message : 'Local task creation could not be prepared.').slice(0, 2000) }
    }
  }

  private async context(root: string, value: AgentHostCreateRequest, authorize: Guard) {
    const request = agentHostCreateRequestSchema.parse(value)
    const scope = await this.scope(root)
    if (request.workspaceId !== scope.workspaceId || !await this.owns(request.workerId)) {
      throw new AgentHostCreationRequestError(403, 'Local creation must use this device and the current task workspace.')
    }
    await this.authorize(request.workerId, scope.workspaceId)
    await authorize()
    return request
  }

  async create(root: string, value: AgentHostCreateRequest, authorize: Guard): Promise<AgentHostCreation> {
    const { workerId, ...command } = await this.context(root, value, authorize)
    const result = await this.service().begin(workerId, agentHostCreateCommandSchema.parse(command), 'local')
    return { ...result, workerId }
  }

  async status(root: string, value: AgentHostCreateRequest, authorize: Guard): Promise<AgentHostCreation> {
    const request = await this.context(root, value, authorize)
    const result = await this.service().status(request.workerId, { operationId: request.operationId, workspaceId: request.workspaceId }, 'local')
    return { ...result, workerId: request.workerId }
  }

  async bind(root: string, value: AgentHostCreateRequest, revision: string | null, authorize: Guard): Promise<AgentHostCreation> {
    const request = await this.context(root, value, authorize)
    const result = await this.service().bind(request.workerId, {
      operationId: request.operationId, workspaceId: request.workspaceId, expectedRevision: creationRevisionSchema.parse(revision),
    }, 'local')
    return { ...result, workerId: request.workerId }
  }

  async abandon(root: string, value: AgentHostCreateRequest, authorize: Guard): Promise<AgentHostCreation> {
    const { workerId, ...command } = await this.context(root, value, authorize)
    const result = await this.service().abandon(workerId, agentHostCreateCommandSchema.parse(command), 'local')
    return { ...result, workerId }
  }
}

export function routeAgentHostCreations(devices: AgentHostCreationDevices, local: LocalTaskAgentHostWorker): AgentHostCreationDevices {
  return {
    localAgentHostWorkers: async (root, taskId) => [await local.worker(root, taskId)],
    agentHostWorkers: (root, taskId) => devices.agentHostWorkers(root, taskId),
    agentHostWorker: async (root, workerId, taskId) => await local.owns(workerId) ? local.worker(root, taskId) : devices.agentHostWorker(root, workerId, taskId),
    agentHostCreate: async (root, request, authorize) => await local.owns(request.workerId) ? local.create(root, request, authorize) : devices.agentHostCreate(root, request, authorize),
    agentHostCreationStatus: async (root, request, authorize) => await local.owns(request.workerId) ? local.status(root, request, authorize) : devices.agentHostCreationStatus(root, request, authorize),
    agentHostBindCreation: async (root, request, revision, authorize) => await local.owns(request.workerId) ? local.bind(root, request, revision, authorize) : devices.agentHostBindCreation(root, request, revision, authorize),
    agentHostAbandonCreation: async (root, request, authorize) => await local.owns(request.workerId) ? local.abandon(root, request, authorize) : devices.agentHostAbandonCreation(root, request, authorize),
  }
}
