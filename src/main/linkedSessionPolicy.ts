import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { readRepositorySessionLinks, sessionOwnerSchema } from './repositorySessionLinks'
import { sessionLinkEntries, taskSessionLinks, type SessionLinksDocument, type SessionOwner, type SessionLink } from '../shared/sessionBindings'
import { agentHostIdentitySchema, agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostTarget } from '../shared/agentHost'

const receiptSchema = z.object({ root: z.string(), taskId: z.string(), owner: sessionOwnerSchema, identity: agentHostIdentitySchema }).strict()
const receiptsSchema = z.object({ schemaVersion: z.literal(2), receipts: z.array(receiptSchema).max(1000) }).strict()
let writing: Promise<unknown> = Promise.resolve()
export async function canonicalPolicyRoot(root: string): Promise<string> {
  const path = await realpath(root)
  return process.platform === 'win32' ? path.toLowerCase() : path
}
async function receipts(directory: string) {
  try { return receiptsSchema.parse(await readJsonBounded(join(directory, 'local-session-link-receipts.json'))).receipts } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local Agent Host link receipts are invalid. Schema v2 logical session receipts are required; old receipts are not migrated. Close Task Continuum and explicitly reset local-session-link-receipts.json before confirming links. Nothing was shared.')
    return []
  }
}
export async function recordLocalLink(
  directory: string,
  root: string,
  taskId: string,
  link: SessionLink | SessionLink[] | undefined,
  owner: SessionOwner,
  detachTarget?: AgentHostTarget,
): Promise<void> {
  const storedOwner = sessionOwnerSchema.parse({ clientId: owner.clientId, machineName: owner.machineName })
  const canonical = await canonicalPolicyRoot(root)
  const selected = Array.isArray(link)
    ? link.length <= 1 ? link[0] : (() => { throw new Error('Confirm one exact Agent Host session at a time.') })()
    : link
  const operation = writing.then(async () => {
    const parsedDetach = detachTarget ? agentHostTargetSchema.parse(detachTarget) : undefined
    const next = (await receipts(directory)).filter((receipt) => {
      if (receipt.root !== canonical || receipt.taskId !== taskId) return true
      if (selected?.provider === 'agent-host') {
        if (selected.owner.clientId !== storedOwner.clientId) return true
        return receipt.owner.clientId !== storedOwner.clientId || receipt.identity.sessionId !== selected.sessionId
      }
      if (parsedDetach) {
        return receipt.owner.clientId !== parsedDetach.owner.clientId
          || receipt.identity.sessionId !== parsedDetach.sessionId || receipt.identity.chatId !== parsedDetach.chatId
      }
      return false
    })
    if (selected?.provider === 'agent-host' && selected.owner.clientId === storedOwner.clientId) next.push({ root: canonical, taskId, owner: storedOwner, identity: { sessionId: selected.sessionId, chatId: selected.chatId } })
    await writeJsonAtomic(join(directory, 'local-session-link-receipts.json'), receiptsSchema.parse({ schemaVersion: 2, receipts: next }))
  })
  writing = operation.catch(() => undefined)
  await operation
}
export async function unregisteredLocalLinks(directory: string, root: string, bindings: SessionLinksDocument['bindings'], owner: SessionOwner) {
  const canonical = await canonicalPolicyRoot(root)
  const existing = await receipts(directory)
  return sessionLinkEntries(bindings).filter(([taskId, link]) => link.provider === 'agent-host' && link.owner.clientId === owner.clientId
    && !existing.some((receipt) => receipt.root === canonical && receipt.taskId === taskId && receipt.owner.clientId === owner.clientId
      && receipt.identity.sessionId === link.sessionId && receipt.identity.chatId === link.chatId))
}

export async function locallyLinkedAgentHostSessions(directory: string, root: string, owner: SessionOwner): Promise<AgentHostTarget[]> {
  const canonical = await canonicalPolicyRoot(root)
  const { document } = await readRepositorySessionLinks(canonical)
  return (await receipts(directory)).flatMap((receipt) => {
    const link = taskSessionLinks(document.bindings, receipt.taskId).find((candidate) =>
      candidate.provider === 'agent-host' && candidate.owner.clientId === owner.clientId
      && candidate.sessionId === receipt.identity.sessionId && candidate.chatId === receipt.identity.chatId)
    return receipt.root === canonical && receipt.owner.clientId === owner.clientId && link
      ? [{ ...receipt.identity, owner: link.owner }] : []
  })
}