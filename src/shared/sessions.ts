import type { ChatMessage } from './chat'

export interface LocalSessionSummary {
  id: string
  source: 'copilot' | 'vscode'
  title: string
  updatedAt: string
  workingDirectory?: string
  messageCount?: number
}

export interface SessionSnapshot {
  session: LocalSessionSummary
  messages: ChatMessage[]
  omittedMessages?: number
  importedFrom?: LocalSessionSummary
}

export interface SessionListing {
  sessions: LocalSessionSummary[]
  warnings: string[]
}

export interface CopilotStatus {
  state: 'disconnected' | 'connecting' | 'ready' | 'auth-required' | 'error'
  workingDirectory: string
  login?: string
  version?: string
  error?: string
}

export interface SessionOptions {
  workingDirectory: string
  model?: string
}

export interface SendMessageRequest {
  sessionId: string
  requestId: string
  message: string
}

export type CopilotEvent =
  | { type: 'delta' | 'activity'; sessionId: string; requestId: string; text: string }
  | { type: 'complete'; sessionId: string; requestId: string }
  | { type: 'error'; sessionId: string; requestId: string; error: string }
  | { type: 'permission'; id: string; sessionId: string; kind: string; details: string }
  | { type: 'user-input'; id: string; sessionId: string; question: string; choices: string[]; allowFreeform: boolean }
  | { type: 'interaction-resolved'; id: string }

export interface ImportPreview extends SessionSnapshot {
  token: string
  truncated: boolean
}

export interface CopilotBridge {
  getStatus(): Promise<CopilotStatus>
  connect(): Promise<CopilotStatus>
  disconnect(): Promise<void>
  listSessions(): Promise<SessionListing>
  listModels(): Promise<{ id: string; name: string }[]>
  chooseDirectory(): Promise<string | null>
  createSession(options: SessionOptions): Promise<SessionSnapshot>
  resumeSession(id: string): Promise<SessionSnapshot>
  previewImport(id: string): Promise<ImportPreview>
  importSession(token: string, options: SessionOptions): Promise<SessionSnapshot>
  send(request: SendMessageRequest): Promise<void>
  abort(requestId: string): Promise<void>
  respond(id: string, response: boolean | string): Promise<void>
  onEvent(listener: (event: CopilotEvent) => void): () => void
}