import { z } from 'zod'
import { agentHostChatIdSchema } from './agentHostProtocol'
import { collaborationErrorCodeSchema } from '../shared/sessionCollaboration'

export const TOOL_RELAY_METHOD = 'taskcontinuum/tools/invoke'
export const TOOL_RELAY_CAPABILITY = { taskcontinuumToolRelay: 1 } as const
export const toolRelayCapabilitySchema = z.object({ taskcontinuumToolRelay: z.literal(1) })
export const TOOL_RELAY_LIMITS = { timeoutMs: 30_000, executionMs: 25_000, responseBytes: 256 * 1024, perSocket: 4, global: 16 } as const

export const toolRelayRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  turnId: z.uuid(),
  toolCallId: z.string().min(1).max(512),
  toolName: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
}).strict()
export type ToolRelayRequest = z.infer<typeof toolRelayRequestSchema>

const toolRelayFailureSchema = z.object({
  error: z.object({ code: collaborationErrorCodeSchema, message: z.string().min(1).max(512) }).strict(),
}).strict()
export const toolRelayResultSchema = z.union([
  z.object({ result: z.record(z.string(), z.unknown()), untrustedContent: z.literal(true).optional() }).strict(),
  toolRelayFailureSchema,
])
export type ToolRelayResult = z.infer<typeof toolRelayResultSchema>

export const toolRelayResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.int().negative(), result: toolRelayResultSchema }).strict(),
  z.object({
    jsonrpc: z.literal('2.0'), id: z.int().negative(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).strict(),
  }).strict(),
])

export type RelayToolToCaller = (request: ToolRelayRequest, verify: () => void) => Promise<ToolRelayResult>
export type ExecuteRelayedTool = (request: ToolRelayRequest, verify: () => Promise<void>) => Promise<ToolRelayResult>
