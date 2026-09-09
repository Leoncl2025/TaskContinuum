import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { readRepositorySessionLinks, sessionOwnerSchema } from './repositorySessionLinks'
import type { SessionOwner, SessionLink } from '../shared/sessionBindings'
import { vscodeIdentitySchema } from './vscodeChatSchemas'

const receiptSchema = z.object({ root: z.string(), taskId: z.string(), owner: sessionOwnerSchema, identity: vscodeIdentitySchema }).strict()
const receiptsSchema = z.array(receiptSchema).max(1000)
let writing: Promise<unknown> = Promise.resolve()
export async function canonicalPolicyRoot(root: string): Promise<string> {
  const path = await realpath(root)
  return process.platform === 'win32' ? path.toLowerCase() : path
}
async function receipts(directory: string) {
  try { return receiptsSchema.parse(await readJsonBounded(join(directory, 'local-session-link-receipts.json'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local link receipts are invalid. Nothing was shared.')
    return []
  }
}
export async function recordLocalLink(directory: string, root: string, taskId: string, link: SessionLink | undefined, owner: SessionOwner): Promise<void> {
  const canonical = await canonicalPolicyRoot(root)
  const operation = writing.then(async () => {
    const next = (await receipts(directory)).filter((receipt) => receipt.root !== canonical || receipt.taskId !== taskId)
    if (link?.provider === 'vscode-copilot' && link.owner?.clientId === owner.clientId) next.push({ root: canonical, taskId, owner, identity: { nativeSessionId: link.sessionId, workspaceStorageId: link.workspaceStorageId } })
    await writeJsonAtomic(join(directory, 'local-session-link-receipts.json'), receiptsSchema.parse(next))
  })
  writing = operation.catch(() => undefined)
  await operation
}
export async function locallyLinkedSessions(directory: string, root: string, owner: SessionOwner) {
  const canonical = await canonicalPolicyRoot(root)
  const { document } = await readRepositorySessionLinks(canonical)
  return (await receipts(directory)).filter((receipt) => {
    const link = document.bindings[receipt.taskId]
    return receipt.root === canonical && receipt.owner.clientId === owner.clientId && link?.provider === 'vscode-copilot' && link.owner?.clientId === owner.clientId && link.sessionId === receipt.identity.nativeSessionId && link.workspaceStorageId === receipt.identity.workspaceStorageId
  }).map((receipt) => receipt.identity)
}