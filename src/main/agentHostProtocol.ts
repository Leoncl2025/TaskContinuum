import { z } from 'zod'
import { remoteMachineSchema } from './vscodeRemoteProtocol'
import { agentHostModelConfigSchema, agentHostModelSelectionSchema } from '../shared/agentHostModelConfig'

export { agentHostModelSelectionSchema } from '../shared/agentHostModelConfig'
export const agentHostModelInfoSchema = z.object({ id: agentHostModelSelectionSchema.shape.id, name: z.string().min(1).max(512), provider: z.string().min(1).max(100), policyState: z.string().optional(), configSchema: agentHostModelConfigSchema.optional() })

export const agentHostIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/)
export const agentHostSessionIdSchema = z.string().max(512).regex(/^(ahp-session|copilotcli):\/[^\s?#]+$/)
export const agentHostChatIdSchema = z.string().max(512).regex(/^ahp-chat:\/[^\s?#]+$/)
export const agentHostTerminalIdSchema = z.string().max(1024).regex(/^(ahp-terminal|agenthost-terminal):\/[^\s?#]+$/)
export const agentHostIdentitySchema = z.object({ sessionId: agentHostSessionIdSchema, chatId: agentHostChatIdSchema }).strict()
export const agentHostTargetSchema = agentHostIdentitySchema.extend({ owner: z.object({ clientId: z.uuid(), machineName: remoteMachineSchema }).strict() }).strict()
export const agentHostSessionSchema = agentHostTargetSchema.extend({ title: z.string().max(2000), provider: z.string().max(100), updatedAt: z.string().max(100), canSend: z.boolean() }).strict()
export const agentHostCatalogSchema = z.object({ ownerId: z.uuid(), deviceId: z.uuid(), sessions: z.array(agentHostSessionSchema).max(1000) }).strict()

export const agentHostEndpointSchema = z.object({
  schemaVersion: z.literal(2), type: z.enum(['editor', 'standalone']), pid: z.number().int().positive(),
  instanceId: agentHostIdSchema, connectionToken: z.string().min(16).max(1024), protocolVersion: z.literal('0.9.0'),
  endpoint: z.discriminatedUnion('type', [
    z.object({ type: z.literal('tcp'), host: z.enum(['127.0.0.1', '::1']), port: z.number().int().min(1).max(65535) }).strict(),
    z.object({ type: z.literal('socket'), path: z.string().min(1).max(1024) }).strict(),
  ]), quality: z.string().optional(), tunnelName: z.string().optional(),
}).strict()
export type AgentHostEndpoint = z.infer<typeof agentHostEndpointSchema>

export { agentHostKey } from '../shared/agentHost'