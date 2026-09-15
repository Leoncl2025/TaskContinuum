import { z } from 'zod'
import type { SessionLink } from '../shared/sessionBindings'
import { agentHostTargetSchema } from './agentHostProtocol'
import { remoteMachineSchema } from './vscodeRemoteProtocol'

export const sessionLinkTaskIdSchema = z.string().regex(/^T-\d{4,}$/)
export const sessionLinkIdSchema = z.string().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
export const sessionOwnerSchema = z.object({ clientId: z.uuid(), machineName: remoteMachineSchema }).strict()
export const sessionLinkSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github-copilot'), sessionId: sessionLinkIdSchema, owner: sessionOwnerSchema.optional() }).strict(),
  z.object({ provider: z.literal('vscode-copilot'), sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/), remoteMachineName: remoteMachineSchema.optional(), owner: sessionOwnerSchema.optional() }).strict(),
  agentHostTargetSchema.extend({ provider: z.literal('agent-host') }).strict(),
])

export function sessionLinkKey(link: SessionLink): string {
  if (link.provider === 'agent-host') return `${link.provider}:${link.owner.clientId}:${link.hostId}:${link.sessionId}`
  return `${link.provider}:${link.owner?.clientId ?? (link.provider === 'vscode-copilot' ? link.remoteMachineName?.toLowerCase() ?? '' : '')}:${link.provider === 'vscode-copilot' ? `${link.workspaceStorageId}:` : ''}${link.sessionId}`
}

export const sessionLinksDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  bindings: z.record(sessionLinkTaskIdSchema, sessionLinkSchema),
}).strict().superRefine((value, context) => {
  const sessions = new Set<string>()
  for (const binding of Object.values(value.bindings)) {
    if (sessions.has(sessionLinkKey(binding))) context.addIssue({ code: 'custom', message: 'A session can be linked to only one task.' })
    sessions.add(sessionLinkKey(binding))
  }
  if (Object.keys(value.bindings).length > 1000) context.addIssue({ code: 'custom', message: 'The session link limit is 1,000 tasks.' })
})
