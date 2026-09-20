import { z } from 'zod'
import type { SessionLink } from '../shared/sessionBindings'
import { agentHostTargetSchema } from './agentHostProtocol'
import { remoteMachineSchema } from './vscodeRemoteProtocol'

export const sessionLinkTaskIdSchema = z.string().regex(/^T-\d{4,}$/)
export const sessionOwnerSchema = z.object({ clientId: z.uuid(), machineName: remoteMachineSchema }).strict()
export const sessionLinkSchema = agentHostTargetSchema.extend({ provider: z.literal('agent-host') }).strict()

export function sessionLinkKey(link: SessionLink): string {
  return `${link.provider}:${link.owner.clientId}:${link.sessionId}`
}

export const sessionLinksDocumentSchema = z.object({
  schemaVersion: z.literal('2.1', { error: 'Task session bindings require schema v2.1. Previous bindings are unsupported and are not migrated. Use a fresh workspace binding configuration and link existing native sessions again.' }),
  bindings: z.record(sessionLinkTaskIdSchema, z.array(sessionLinkSchema).min(1).max(1000)),
}).strict().superRefine((value, context) => {
  const sessions = new Set<string>()
  let links = 0
  for (const bindings of Object.values(value.bindings)) {
    for (const binding of bindings) {
      links++
      if (sessions.has(sessionLinkKey(binding))) context.addIssue({ code: 'custom', message: 'A session can be linked only once.' })
      sessions.add(sessionLinkKey(binding))
    }
  }
  if (Object.keys(value.bindings).length > 1000) context.addIssue({ code: 'custom', message: 'The session link limit is 1,000 tasks.' })
  if (links > 1000) context.addIssue({ code: 'custom', message: 'The session link limit is 1,000 sessions.' })
})
