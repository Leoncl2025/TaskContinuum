import type { TaskRecord } from './tasks'
import type { ChatImageAttachment, ChatImageReference } from './chatAttachments'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  images?: (ChatImageAttachment | ChatImageReference)[]
  status: 'complete' | 'streaming' | 'cancelled' | 'error'
  nativeRequestId?: string
  author?: { name: string; machineName?: string }
}

export interface ChatRequest {
  sessionId: string
  task: TaskRecord
  message: string
  images?: ChatImageAttachment[]
  history: ReadonlyArray<ChatMessage>
  signal: AbortSignal
}

export type ChatEvent = { type: 'delta'; text: string } | { type: 'activity'; text: string } | { type: 'complete' }

// UI/session boundary, not a raw LLM API. Live adapters belong in the backend slice.
export interface ChatAdapter {
  readonly label: string
  readonly kind: 'demo' | 'live'
  stream(request: ChatRequest): AsyncIterable<ChatEvent>
}