import { z } from 'zod'
import { vscodeIdentitySchema } from './vscodeChatSchemas'
import { deliverySchema, executionIdentitySchema, participantSchema } from './vscodeChatDelivery'
import { devTunnelRouteSchema, sshPublicKeySchema } from './devTunnel/protocol'

export const remoteClientSchema = participantSchema.extend({ clientId: z.uuid() }).strict()
export const remoteIdentityFileSchema = z.object({ schemaVersion: z.literal(1), provider: z.literal('vscode-copilot'), participant: remoteClientSchema, sshPublicKey: sshPublicKeySchema.optional() }).strict()
export const sshHostAliasSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/)
export const remoteMachineSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/)
export const vscodeTargetSchema = vscodeIdentitySchema.extend({ remoteMachineName: remoteMachineSchema.optional() }).strict()
export const remoteGrantSchema = z.object({ id: z.uuid(), participant: remoteClientSchema, canSend: z.boolean(), expiresAt: z.iso.datetime() }).strict()
export const remoteInvitationSchema = z.object({
  schemaVersion: z.literal(1), provider: z.literal('vscode-copilot'),
  grant: remoteGrantSchema, instanceId: z.uuid(), identity: vscodeIdentitySchema,
  execution: executionIdentitySchema.extend({ machineName: remoteMachineSchema }).strict(),
  title: z.string().min(1).max(160), vscodeVersion: z.string().regex(/^1\.136\./).max(100),
  port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict()
export type RemoteVSCodeInvitation = z.infer<typeof remoteInvitationSchema>
export const remoteInvitationFileSchema = remoteInvitationSchema.extend({ devTunnel: devTunnelRouteSchema.optional() }).strict()
export const remoteHandshakeSchema = remoteInvitationSchema.omit({ schemaVersion: true, provider: true, title: true, port: true, token: true }).strict()
const remoteMessageSchema = z.object({
  id: z.string().min(1).max(240), role: z.enum(['user', 'assistant']), text: z.string().max(60000),
  status: z.enum(['complete', 'streaming', 'cancelled', 'error']), nativeRequestId: z.string().min(1).max(240).optional(),
  author: z.object({ name: z.string().min(1).max(300), machineName: z.string().min(1).max(300).optional() }).strict().optional(),
}).strict()
export const remoteViewSchema = z.object({
  session: z.object({ id: z.string().min(1).max(200), source: z.literal('vscode'), title: z.string().max(160), updatedAt: z.iso.datetime(), messageCount: z.number().int().nonnegative().optional() }).strict(),
  messages: z.array(remoteMessageSchema).max(500).refine((messages) => messages.reduce((size, message) => size + message.text.length, 0) <= 60000),
  deliveries: z.array(deliverySchema).max(500), participant: remoteClientSchema, execution: executionIdentitySchema,
  canSend: z.boolean(), responding: z.boolean(), connectionState: z.enum(['offline', 'connected', 'unsupported']),
  canOpenRemote: z.boolean().optional(),
  bridgeError: z.string().max(1500).optional(), omittedMessages: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(),
}).strict()
export const remoteHistorySchema = z.object({ instanceId: z.uuid(), grantId: z.uuid(), identity: vscodeIdentitySchema, view: remoteViewSchema }).strict()

export function sameRemoteTarget(left: z.infer<typeof vscodeTargetSchema>, right: z.infer<typeof vscodeTargetSchema>): boolean {
  return left.nativeSessionId === right.nativeSessionId && left.workspaceStorageId === right.workspaceStorageId
    && left.remoteMachineName?.toLowerCase() === right.remoteMachineName?.toLowerCase()
}