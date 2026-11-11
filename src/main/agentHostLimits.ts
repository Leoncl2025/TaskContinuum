import { z } from 'zod'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

export const AGENT_HOST_LIMITS = {
  messageBytes: GiB,
  receiveBufferBytes: GiB + 16 * MiB,
  receiveBufferMessages: 1024,
  requestBytes: 16 * MiB,
  responseBufferBytes: GiB + 16 * MiB,
  responseBufferGlobalBytes: 2 * GiB,
  // A cached snapshot adds the exact target and schema envelope.
  cacheBytes: GiB + 64 * 1024,
} as const

export const AGENT_HOST_LIMIT_HEADER = 'x-taskcontinuum-ahp-limit'
export const AGENT_HOST_LIMIT_RPC_CODE = -32050

const limitDataSchema = z.object({
  code: z.literal('TC_AHP_LIMIT'),
  kind: z.enum(['message', 'receive-buffer', 'send-buffer', 'request', 'cache']),
  limitBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  actualBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
type LimitData = z.infer<typeof limitDataSchema>

export class AgentHostSizeLimitError extends Error {
  constructor(readonly kind: LimitData['kind'], readonly limitBytes: number, readonly actualBytes?: number) {
    const label = {
      message: 'Agent Host message/history snapshot',
      'receive-buffer': 'Agent Host receive backlog',
      'send-buffer': 'Agent Host outgoing backlog',
      request: 'Agent Host request',
      cache: 'Offline chat history',
    }[kind]
    const size = actualBytes === undefined ? '' : ` (${actualBytes} bytes)`
    const unit = limitBytes >= GiB && limitBytes % GiB === 0 ? GiB : MiB
    const unitName = unit === GiB ? 'GiB' : 'MiB'
    super(`${label}${size} exceeds the ${(limitBytes / unit).toFixed(limitBytes % unit ? 1 : 0)} ${unitName} limit (${limitBytes} bytes). No history was truncated, no replacement session was created, and no message was replayed.`)
    this.name = 'AgentHostSizeLimitError'
  }

  toData(): LimitData {
    return { code: 'TC_AHP_LIMIT', kind: this.kind, limitBytes: this.limitBytes, ...(this.actualBytes === undefined ? {} : { actualBytes: this.actualBytes }) }
  }
}

export function parseAgentHostSizeLimit(value: unknown): AgentHostSizeLimitError | undefined {
  const parsed = limitDataSchema.safeParse(value)
  return parsed.success ? new AgentHostSizeLimitError(parsed.data.kind, parsed.data.limitBytes, parsed.data.actualBytes) : undefined
}

export function decodeAgentHostSizeLimit(text: string): AgentHostSizeLimitError | undefined {
  if (text.length > 512) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  return parseAgentHostSizeLimit(value)
}

export function agentHostSizeLimit(error: unknown): AgentHostSizeLimitError | undefined {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof AgentHostSizeLimitError) return error
    if (error.name === 'RpcError' && 'code' in error && error.code === AGENT_HOST_LIMIT_RPC_CODE && 'data' in error) {
      const parsed = parseAgentHostSizeLimit(error.data)
      if (parsed) return parsed
    }
    error = error.cause
  }
  return undefined
}
