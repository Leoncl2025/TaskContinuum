import { realpath } from 'node:fs/promises'
import type { SessionLink, SessionLinksDocument, SessionLinksSnapshot } from '../shared/sessionBindings'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { readTaskWorkspace } from './workspaceReader'
import { sessionLinkSchema, sessionLinkTaskIdSchema as taskIdSchema, sessionLinkKey as linkKey, sessionLinksDocumentSchema as documentSchema } from './sessionLinkSchema'
export { sessionOwnerSchema, sessionLinkSchema, sessionLinkKey } from './sessionLinkSchema'

export interface RepositorySessionLinksBackend {
  read(): Promise<SessionLinksSnapshot>
  update(expectedRevision: string | null, transform: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
  writeBinding?(taskId: string, target: SessionLink | null, expectedRevision: string | null, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
}
const backends = new Map<string, RepositorySessionLinksBackend>()

async function canonicalRoot(root: string): Promise<string> {
  const canonical = await realpath(root)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export async function registerRepositorySessionLinksBackend(root: string, backend: RepositorySessionLinksBackend): Promise<() => void> {
  const canonical = await canonicalRoot(root)
  if (backends.has(canonical)) throw new Error('This workspace already has a session links backend.')
  backends.set(canonical, backend)
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    if (backends.get(canonical) === backend) backends.delete(canonical)
  }
}

function bindingSnapshot(snapshot: SessionLinksSnapshot): SessionLinksSnapshot {
  return { document: documentSchema.parse(snapshot.document), revision: snapshot.revision, ...(snapshot.localOwner ? { localOwner: snapshot.localOwner } : {}) }
}

function requireBackend(root: string): RepositorySessionLinksBackend {
  const backend = backends.get(root)
  if (!backend) throw new Error('Enable Automatic workspace links before accessing session bindings. The immutable binding backend is not ready; legacy session configuration is not supported.')
  return backend
}

export async function readRepositorySessionLinks(root: string): Promise<SessionLinksSnapshot> {
  return bindingSnapshot(await requireBackend(await canonicalRoot(root)).read())
}

export function removeRepositorySessionLink(root: string, taskId: string, expectedRevision: string | null): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  return updateLink(root, taskId, null, expectedRevision)
}

export function updateRepositoryAgentHostLink(root: string, taskId: string, target: AgentHostTarget, expectedRevision: string | null): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  return updateLink(root, taskId, sessionLinkSchema.parse({ ...agentHostTargetSchema.parse(target), provider: 'agent-host' }), expectedRevision)
}

export function bindRepositoryAgentHostCreation(root: string, taskId: string, target: AgentHostTarget, expectedRevision: string | null, authorize?: () => Promise<void>): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  const selected = sessionLinkSchema.parse({ ...agentHostTargetSchema.parse(target), provider: 'agent-host' })
  const check = async () => {
    if (!(await readTaskWorkspace(root)).tasks.some((task) => task.id === taskId)) throw new Error('The task does not exist in this workspace. No binding was written.')
    await authorize?.()
  }
  return writeRepositorySessionLinks(root, expectedRevision, async (before) => {
    await check()
    const prior = before.bindings[taskId]
    if (prior && JSON.stringify(prior) !== JSON.stringify(selected)) throw new Error('The task already has a different session binding. Creation cannot replace it.')
    const existingTask = Object.entries(before.bindings).find(([id, link]) => id !== taskId && linkKey(link) === linkKey(selected))?.[0]
    if (existingTask) throw new Error(`This session is already linked to ${existingTask}. Detach it there before moving it.`)
    return { schemaVersion: 2, bindings: { ...before.bindings, [taskId]: selected } }
  }, check)
}

async function updateLink(root: string, taskId: string, selected: SessionLink | null, expectedRevision: string | null): Promise<SessionLinksSnapshot> {
  const canonical = await canonicalRoot(root)
  const backend = requireBackend(canonical)
  if (backend.writeBinding) return bindingSnapshot(await backend.writeBinding(taskId, selected, expectedRevision, async () => {
    if (backends.get(canonical) !== backend) throw new Error('The immutable binding backend changed. Reload and retry; no binding was written.')
  }))
  return writeRepositorySessionLinks(root, expectedRevision, (before) => {
    const prior = before.bindings[taskId]
    if (prior?.owner && selected && prior.sessionId === selected.sessionId && prior.provider === selected.provider && prior.owner.clientId !== selected.owner?.clientId) throw new Error('Session ownership cannot be changed by linking. Ownership transfer is not supported.')
    if (selected) {
      const existingTask = Object.entries(before.bindings).find(([id, link]) => id !== taskId && linkKey(link) === linkKey(selected))?.[0]
      if (existingTask) throw new Error(`This session is already linked to ${existingTask}. Detach it there before moving it.`)
    }
    const bindings = { ...before.bindings }
    if (selected === null) delete bindings[taskId]
    else bindings[taskId] = selected
    return { schemaVersion: 2, bindings }
  })
}

export async function writeRepositorySessionLinks(root: string, expectedRevision: string | null, update: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeCommit?: () => Promise<void>): Promise<SessionLinksSnapshot> {
  if (expectedRevision !== null && !/^[a-f\d]{64}$/.test(expectedRevision)) throw new Error('Invalid session link revision.')
  const canonical = await canonicalRoot(root)
  const backend = requireBackend(canonical)
  const requireCurrent = () => {
    if (backends.get(canonical) !== backend) throw new Error('The immutable binding backend changed. Reload and retry; no binding was written.')
  }
  return bindingSnapshot(await backend.update(expectedRevision, async (before) => {
    requireCurrent()
    const document = documentSchema.parse(await update(before))
    requireCurrent()
    return document
  }, async () => {
    requireCurrent()
    await beforeCommit?.()
    requireCurrent()
  }))
}