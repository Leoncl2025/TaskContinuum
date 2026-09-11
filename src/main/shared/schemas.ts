import { z } from 'zod'
import { chatContentSchema, chatImageReferencesSchema } from '../../shared/chatAttachments'

export const identifier = z.string().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
export const actorSchema = z.object({ kind: z.enum(['user', 'agent', 'host']), id: identifier, name: z.string().min(1).max(160), machineId: identifier, machineName: z.string().min(1).max(160) }).strict()
export const permissionsSchema = z.array(z.enum(['read', 'send', 'approve', 'stop', 'checkpoint', 'manage'])).max(6)
export const descriptorSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), workspaceId: z.uuid(), taskId: z.string().regex(/^T-\d{4,}$/), mode: z.enum(['live', 'checkpoint']),
  owner: z.object({ machineId: identifier, machineName: z.string().min(1).max(160), agentId: identifier, nativeSessionId: identifier, epoch: z.number().int().positive() }).strict(),
  createdAt: z.iso.datetime(), parent: z.object({ sessionId: z.uuid(), checkpointId: z.uuid(), mode: z.literal('semantic') }).strict().optional(),
}).strict()
export const eventSchema = z.object({
  sessionId: z.uuid(), epoch: z.number().int().positive(), seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at: z.iso.datetime(), actor: actorSchema,
  type: z.enum(['history', 'message', 'started', 'delta', 'activity', 'completed', 'failed', 'interrupted', 'permission', 'question', 'resolved']),
  commandId: identifier.optional(), text: z.string().max(200000).optional(), role: z.enum(['user', 'assistant']).optional(),
  images: chatImageReferencesSchema.optional(),
  interactionId: identifier.optional(), permissionKind: z.string().max(100).optional(), choices: z.array(z.string().max(8000)).max(100).optional(), allowFreeform: z.boolean().optional(),
}).strict()
export const grantSchema = z.object({ id: identifier, actor: actorSchema.extend({ kind: z.literal('user') }), permissions: permissionsSchema, tokenHash: z.string().regex(/^[a-f\d]{64}$/) }).strict()
export const enrollmentSchema = z.object({
  schemaVersion: z.literal(1), session: descriptorSchema, actor: actorSchema, permissions: permissionsSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  endpoint: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), port: z.number().int().min(1024).max(65535) }).strict(),
    z.object({ kind: z.literal('ssh'), host: z.string().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), remotePort: z.number().int().min(1024).max(65535) }).strict(),
  ]),
}).strict()
export const commandSchema = chatContentSchema.safeExtend({ id: identifier })
export const responseSchema = z.object({ id: identifier, answer: z.union([z.boolean(), z.string().min(1).max(8000)]) }).strict()