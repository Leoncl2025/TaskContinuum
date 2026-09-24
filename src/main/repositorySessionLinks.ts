import { realpath } from 'node:fs/promises'
import { sessionLinkEntries, taskSessionLinks, type SessionLink, type SessionLinksDocument, type SessionLinksSnapshot } from '../shared/sessionBindings'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { readTaskWorkspace } from './workspaceReader'
import { sessionLinkSchema, sessionLinkTaskIdSchema as taskIdSchema, sessionLinkKey as linkKey, sessionLinksDocumentSchema as documentSchema } from './sessionLinkSchema'
export { sessionOwnerSchema, sessionLinkSchema, sessionLinkKey } from './sessionLinkSchema'

export interface RepositorySessionLinksBackend {
  read(): Promise<SessionLinksSnapshot>
  readForAuthorization?(): Promise<SessionLinksSnapshot>
  acquireAuthorization?(): Promise<SessionLinksAuthorization>
  update(expectedRevision: string | null, transform: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
  writeBinding?(taskId: string, targets: SessionLink | SessionLink[] | null, expectedRevision: string | null, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
}
export interface SessionLinksAuthorization {
  snapshot: SessionLinksSnapshot
  current(): boolean
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

function canonicalBindings(document: SessionLinksDocument): Record<string, SessionLink[]> {
  return Object.fromEntries(Object.keys(document.bindings).map((taskId) => [taskId, taskSessionLinks(document.bindings, taskId)]))
}

function requireBackend(root: string): RepositorySessionLinksBackend {
  const backend = backends.get(root)
  if (!backend) throw new Error('Enable Automatic workspace links before accessing session bindings. The immutable binding backend is not ready; legacy session configuration is not supported.')
  return backend
}

export async function readRepositorySessionLinks(root: string): Promise<SessionLinksSnapshot> {
  return bindingSnapshot(await requireBackend(await canonicalRoot(root)).read())
}

export async function readRepositorySessionLinksForAuthorization(root: string): Promise<SessionLinksSnapshot> {
  const canonical = await canonicalRoot(root)
  const backend = requireBackend(canonical)
  const snapshot = await (backend.readForAuthorization ? backend.readForAuthorization() : backend.read())
  if (backends.get(canonical) !== backend) throw new Error('The immutable binding backend changed during authorization.')
  return bindingSnapshot(snapshot)
}

export async function acquireRepositorySessionAuthorization(root: string): Promise<SessionLinksAuthorization> {
  const canonical = await canonicalRoot(root)
  const backend = requireBackend(canonical)
  const lease = backend.acquireAuthorization ? await backend.acquireAuthorization()
    : { snapshot: await backend.read(), current: () => false }
  if (backends.get(canonical) !== backend) throw new Error('The immutable binding backend changed during authorization.')
  return { snapshot: bindingSnapshot(lease.snapshot), current: () => backends.get(canonical) === backend && lease.current() }
}

export function removeRepositorySessionLink(root: string, taskId: string, expectedRevision: string | null, detachTarget?: AgentHostTarget): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  return updateLink(root, taskId, null, expectedRevision, detachTarget ? agentHostTargetSchema.parse(detachTarget) : undefined)
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
    const prior = taskSessionLinks(before.bindings, taskId)
    const existing = sessionLinkEntries(before.bindings).find(([, link]) => linkKey(link) === linkKey(selected))
    if (existing) {
      if (existing[0] !== taskId) throw new Error(`This session is already linked to ${existing[0]}. Detach it there before moving it.`)
      if (JSON.stringify(existing[1]) !== JSON.stringify(selected)) throw new Error('This session already has a different chat claim. Creation cannot replace it.')
      return before
    }
    return { schemaVersion: '2.1', bindings: { ...canonicalBindings(before), [taskId]: [...prior, selected] } }
  }, check)
}

async function updateLink(root: string, taskId: string, selected: SessionLink | null, expectedRevision: string | null, detachTarget?: AgentHostTarget): Promise<SessionLinksSnapshot> {
  const canonical = await canonicalRoot(root)
  const backend = requireBackend(canonical)
  if (backend.writeBinding) {
    const before = bindingSnapshot(await backend.read())
    const targets = changedTaskTargets(before.document, taskId, selected, detachTarget)
    return bindingSnapshot(await backend.writeBinding(taskId, targets.length ? targets : null, expectedRevision, async () => {
      if (backends.get(canonical) !== backend) throw new Error('The immutable binding backend changed. Reload and retry; no binding was written.')
    }))
  }
  return writeRepositorySessionLinks(root, expectedRevision, (before) => {
    const next = changedTaskTargets(before, taskId, selected, detachTarget)
    const bindings = canonicalBindings(before)
    if (!next.length) delete bindings[taskId]
    else bindings[taskId] = next
    return { schemaVersion: '2.1', bindings }
  })
}

function changedTaskTargets(before: SessionLinksDocument, taskId: string, selected: SessionLink | null, detachTarget?: AgentHostTarget): SessionLink[] {
  const prior = taskSessionLinks(before.bindings, taskId)
  if (!selected) {
    if (!detachTarget) {
      if (prior.length > 1) throw new Error('This task has multiple linked sessions. Specify the exact session to detach.')
      return []
    }
    const parsed = agentHostTargetSchema.parse(detachTarget)
    const matches = prior.filter((link) => link.sessionId === parsed.sessionId && link.chatId === parsed.chatId && link.owner.clientId === parsed.owner.clientId)
    if (matches.length !== 1) throw new Error('The task does not link this exact Agent Host chat.')
    return prior.filter((link) => link !== matches[0])
  }
  const claim = sessionLinkEntries(before.bindings).find(([, link]) => linkKey(link) === linkKey(selected))
  if (claim) {
    if (claim[0] !== taskId) throw new Error(`This session is already linked to ${claim[0]}. Detach it there before moving it.`)
    if (JSON.stringify(claim[1]) !== JSON.stringify(selected)) throw new Error('This session already has a different chat claim. Detach it before linking another chat.')
    return prior
  }
  return [...prior, selected]
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