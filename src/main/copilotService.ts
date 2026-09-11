import { randomUUID } from 'node:crypto'
import { chatContentSchema } from '../shared/chatAttachments'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'
import type { GetAuthStatusResponse, GetStatusResponse, MessageOptions, PermissionRequestResult, ResumeSessionConfig, SessionConfig, SessionEvent, SessionMetadata } from '@github/copilot-sdk'
import type { ChatMessage } from '../shared/chat'
import type { CopilotEvent, CopilotStatus, LocalSessionSummary, SendMessageRequest, SessionOptions, SessionSnapshot } from '../shared/sessions'

type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>>

export interface RuntimeSession {
  sessionId: string
  on(listener: (event: SessionEvent) => void): () => void
  send(options: MessageOptions): Promise<string>
  abort(): Promise<void>
  getEvents(): Promise<SessionEvent[]>
  disconnect(): Promise<void>
}

export interface CopilotRuntime {
  start(): Promise<void>
  stop(): Promise<Error[]>
  forceStop(): Promise<void>
  getAuthStatus(): Promise<GetAuthStatusResponse>
  getStatus(): Promise<GetStatusResponse>
  listSessions(): Promise<SessionMetadata[]>
  listModels(): Promise<{ id: string; name: string }[]>
  createSession(options: SessionConfig): Promise<RuntimeSession>
  resumeSession(id: string, options: ResumeSessionConfig): Promise<RuntimeSession>
}

interface ActiveRequest {
  session: RuntimeSession
  finish(error?: Error): void
  refreshTimeout(): void
}

interface Interaction {
  sessionId: string
  kind: 'permission' | 'user-input'
  settle(value: boolean | string): void
}

export function checkedString(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${label}.`)
  return value
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : 'The local Copilot runtime failed.').slice(0, 2000)
}

function summary(metadata: SessionMetadata): LocalSessionSummary {
  return { id: metadata.sessionId, source: 'copilot', title: metadata.summary || 'Copilot conversation',
    updatedAt: metadata.modifiedTime.toISOString(), workingDirectory: metadata.context?.workingDirectory }
}

export function messagesFromEvents(events: SessionEvent[]): ChatMessage[] {
  return events.flatMap((event): ChatMessage[] => {
    if (event.type !== 'user.message' && event.type !== 'assistant.message') return []
    if ('parentToolCallId' in event.data && event.data.parentToolCallId) return []
    return [{ id: event.id, role: event.type === 'user.message' ? 'user' : 'assistant', text: event.data.content, status: 'complete' }]
  })
}

async function deadline<Value>(work: Promise<Value>, milliseconds: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The local Copilot runtime timed out.')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

export class CopilotService {
  private readonly createClient: () => CopilotRuntime
  private readonly listeners = new Set<(event: CopilotEvent) => void>()
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly summaries = new Map<string, LocalSessionSummary>()
  private readonly active = new Map<string, ActiveRequest>()
  private readonly interactions = new Map<string, Interaction>()
  private readonly requestTimeout: number
  private client?: CopilotRuntime
  private connecting?: Promise<CopilotStatus>
  private epoch = 0
  private status: CopilotStatus

  constructor(options: { createClient?: () => CopilotRuntime; workingDirectory?: string; requestTimeout?: number } = {}) {
    const workingDirectory = options.workingDirectory ?? process.cwd()
    this.status = { state: 'disconnected', workingDirectory }
    this.requestTimeout = options.requestTimeout ?? 10 * 60 * 1000
    this.createClient = options.createClient ?? (() => new CopilotClient({
      connection: RuntimeConnection.forStdio(), workingDirectory, useLoggedInUser: true, logLevel: 'error',
    }))
  }

  getStatus(): CopilotStatus { return { ...this.status } }

  onEvent(listener: (event: CopilotEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: CopilotEvent): void { for (const listener of this.listeners) listener(event) }

  connect(): Promise<CopilotStatus> {
    if (this.connecting) return this.connecting
    if (this.status.state === 'ready') return Promise.resolve(this.getStatus())
    const epoch = this.epoch
    this.status = { state: 'connecting', workingDirectory: this.status.workingDirectory }
    this.connecting = (async () => {
      try {
        const client = this.client ?? this.createClient()
        this.client = client
        await deadline(client.start(), 30000)
        const [auth, runtime] = await deadline(Promise.all([client.getAuthStatus(), client.getStatus()]), 15000)
        if (epoch !== this.epoch) return this.getStatus()
        this.status = { state: auth.isAuthenticated ? 'ready' : 'auth-required', workingDirectory: this.status.workingDirectory,
          login: auth.login, version: runtime.version, error: auth.isAuthenticated ? undefined : 'Copilot CLI sign-in is required.' }
      } catch (error) {
        if (epoch === this.epoch) {
          this.status = { state: 'error', workingDirectory: this.status.workingDirectory, error: messageOf(error) }
          await this.client?.forceStop().catch(() => undefined)
          this.client = undefined
        }
      } finally { if (epoch === this.epoch) this.connecting = undefined }
      return this.getStatus()
    })()
    return this.connecting
  }

  private runtime(): CopilotRuntime {
    if (!this.client || this.status.state !== 'ready') throw new Error('Connect an authenticated local Copilot runtime first.')
    return this.client
  }

  async listSessions(): Promise<LocalSessionSummary[]> {
    const items = (await this.runtime().listSessions()).filter((item) => !item.isRemote).map(summary)
    for (const item of items) this.summaries.set(item.id, item)
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async listModels(): Promise<{ id: string; name: string }[]> {
    return (await this.runtime().listModels()).map(({ id, name }) => ({ id, name }))
  }

  private configuration(): SessionConfig {
    return {
      streaming: true, includeSubAgentStreamingEvents: false,
      onPermissionRequest: (request, invocation) => {
        if (![...this.active.values()].some((entry) => entry.session.sessionId === invocation.sessionId) || !this.listeners.size) {
          return { kind: 'user-not-available' }
        }
        return this.ask<PermissionRequestResult>(invocation.sessionId, 'permission', (id) => ({
          type: 'permission', id, sessionId: invocation.sessionId, kind: request.kind, details: JSON.stringify(request, null, 2),
        }), (value) => value === true ? { kind: 'approve-once' } : { kind: 'reject', feedback: 'The user did not approve this operation.' })
      },
      onUserInputRequest: (request, invocation) => this.ask<UserInputResponse>(invocation.sessionId, 'user-input', (id) => ({
        type: 'user-input', id, sessionId: invocation.sessionId, question: request.question,
        choices: request.choices ?? [], allowFreeform: request.allowFreeform !== false,
      }), (value) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error('The user did not answer the question.')
        if (request.allowFreeform === false && !request.choices?.includes(value)) throw new Error('Choose one of the offered answers.')
        return { answer: value, wasFreeform: !request.choices?.includes(value) }
      }),
    }
  }

  private ask<Value>(sessionId: string, kind: Interaction['kind'], event: (id: string) => CopilotEvent, convert: (value: boolean | string) => Value): Promise<Value> {
    if (!this.listeners.size || ![...this.active.values()].some((entry) => entry.session.sessionId === sessionId)) {
      return Promise.reject(new Error('No active user is available.'))
    }
    const id = randomUUID()
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => settle(false), 5 * 60 * 1000)
      const settle = (value: boolean | string) => {
        clearTimeout(timer)
        this.interactions.delete(id)
        for (const active of this.active.values()) if (active.session.sessionId === sessionId) active.refreshTimeout()
        this.emit({ type: 'interaction-resolved', id })
        try { resolve(convert(value)) } catch (error) { reject(error) }
      }
      this.interactions.set(id, { sessionId, kind, settle })
      for (const active of this.active.values()) if (active.session.sessionId === sessionId) active.refreshTimeout()
      this.emit(event(id))
    })
  }

  respond(id: unknown, response: unknown): void {
    const interaction = this.interactions.get(checkedString(id, 'interaction ID'))
    if (!interaction) throw new Error('This request is no longer pending.')
    if (interaction.kind === 'permission' && typeof response !== 'boolean') throw new Error('Invalid permission decision.')
    if (interaction.kind === 'user-input' && response !== false) checkedString(response, 'answer', 8000)
    interaction.settle(response as boolean | string)
  }

  async createSession(options: SessionOptions): Promise<SessionSnapshot> {
    const runtime = this.runtime()
    const requested = checkedString(options?.workingDirectory, 'working directory', 4096)
    if (!isAbsolute(requested)) throw new Error('Choose an absolute working directory.')
    const workingDirectory = await realpath(requested)
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error('The working directory must be a folder.')
    const model = options.model === undefined ? undefined : checkedString(options.model, 'model ID')
    const session = await runtime.createSession({ ...this.configuration(), workingDirectory, model })
    this.sessions.set(session.sessionId, session)
    const metadata: LocalSessionSummary = { id: session.sessionId, source: 'copilot', title: 'New Copilot conversation', workingDirectory, updatedAt: new Date().toISOString() }
    this.summaries.set(session.sessionId, metadata)
    return { session: metadata, messages: [] }
  }

  async resumeSession(value: unknown): Promise<SessionSnapshot> {
    const id = checkedString(value, 'session ID')
    const runtime = this.runtime()
    if ([...this.active.values()].some((entry) => entry.session.sessionId === id)) throw new Error('This conversation is still responding.')
    if (!this.summaries.has(id)) await this.listSessions()
    const metadata = this.summaries.get(id)
    if (!metadata) throw new Error('This local Copilot conversation was not found.')
    const session = this.sessions.get(id) ?? await runtime.resumeSession(id, { ...this.configuration(), continuePendingWork: false })
    this.sessions.set(id, session)
    return { session: metadata, messages: messagesFromEvents(await session.getEvents()) }
  }

  async restoreOwnedSession(value: string, options: SessionOptions, allowEmptyRecreate: boolean): Promise<SessionSnapshot> {
    const id = checkedString(value, 'owned session ID')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error('Invalid owned session ID.')
    const runtime = this.runtime()
    const workingDirectory = await realpath(checkedString(options.workingDirectory, 'working directory', 4096))
    if (!(await stat(workingDirectory)).isDirectory()) throw new Error('The working directory must be a folder.')
    let session: RuntimeSession
    try {
      session = await runtime.resumeSession(id, { ...this.configuration(), workingDirectory, continuePendingWork: false })
    } catch (error) {
      if (!allowEmptyRecreate || !(error instanceof Error) || !error.message.includes(`Session not found: ${id}`)) throw error
      session = await runtime.createSession({ ...this.configuration(), sessionId: id, workingDirectory, model: options.model })
    }
    if (session.sessionId !== id) throw new Error('The provider returned a different owned session ID.')
    const messages = messagesFromEvents(await session.getEvents())
    const metadata: LocalSessionSummary = { id, source: 'copilot', title: 'Shared Copilot conversation', workingDirectory, updatedAt: new Date().toISOString() }
    this.sessions.set(id, session)
    this.summaries.set(id, metadata)
    return { session: metadata, messages }
  }

  send(request: SendMessageRequest, prompt = request?.message): Promise<void> {
    this.runtime()
    const sessionId = checkedString(request?.sessionId, 'session ID')
    const requestId = checkedString(request?.requestId, 'request ID')
    const content = chatContentSchema.parse({ text: request?.message, images: request?.images })
    const outgoingPrompt = prompt || 'Please inspect the attached images.'
    checkedString(outgoingPrompt, 'prompt', 100000)
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Open a local Copilot conversation before sending.')
    if (this.active.has(requestId) || [...this.active.values()].some((entry) => entry.session.sessionId === sessionId)) {
      throw new Error('This conversation already has an active request.')
    }
    return new Promise<void>((resolve, reject) => {
      const streamed = new Set<string>()
      let lastMessage: string | undefined
      let finished = false
      let unsubscribe = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      const refreshTimeout = () => {
        clearTimeout(timer)
        if (finished || [...this.interactions.values()].some((interaction) => interaction.sessionId === sessionId)) return
        timer = setTimeout(() => {
          void session.abort().catch(() => undefined)
          finish(new Error('Copilot stopped reporting progress. The response was stopped after the inactivity timeout.'))
        }, this.requestTimeout)
      }
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        unsubscribe()
        this.active.delete(requestId)
        for (const interaction of this.interactions.values()) if (interaction.sessionId === sessionId) interaction.settle(false)
        this.emit(error ? { type: 'error', sessionId, requestId, error: messageOf(error) } : { type: 'complete', sessionId, requestId })
        if (error) reject(error)
        else resolve()
      }
      const delta = (id: string, text: string) => {
        if (!text) return
        this.emit({ type: 'delta', sessionId, requestId, text: `${lastMessage !== undefined && lastMessage !== id ? '\n\n' : ''}${text}` })
        lastMessage = id
      }
      this.active.set(requestId, { session, finish, refreshTimeout })
      unsubscribe = session.on((event) => {
        if (finished) return
        if (/^(assistant\.|tool\.|subagent\.|hook\.|session\.compaction_)/.test(event.type)) refreshTimeout()
        if ('parentToolCallId' in event.data && event.data.parentToolCallId) return
        if (event.type === 'assistant.message_delta') {
          streamed.add(event.data.messageId)
          delta(event.data.messageId, event.data.deltaContent)
        } else if (event.type === 'assistant.message' && !streamed.has(event.data.messageId)) delta(event.data.messageId, event.data.content)
        else if (event.type === 'tool.execution_start') this.emit({ type: 'activity', sessionId, requestId, text: `Running ${event.data.toolName}` })
        else if (event.type === 'session.error') finish(new Error(event.data.message))
        else if (event.type === 'session.idle') finish()
      })
      refreshTimeout()
      void session.send({ prompt: outgoingPrompt, displayPrompt: request.message,
        ...(content.images?.length ? { attachments: content.images.map((image) => ({ type: 'blob' as const, data: image.data, mimeType: image.mimeType, displayName: image.name })) } : {}),
      }).catch((error: unknown) => finish(new Error(messageOf(error))))
    })
  }

  async abort(value: unknown): Promise<void> {
    const active = this.active.get(checkedString(value, 'request ID'))
    if (!active) return
    for (const interaction of this.interactions.values()) if (interaction.sessionId === active.session.sessionId) interaction.settle(false)
    await active.session.abort()
    active.finish()
  }

  cancelAll(): void {
    for (const active of [...this.active.values()]) {
      void active.session.abort().catch(() => undefined)
      active.finish(new Error('The desktop connection was closed.'))
    }
    for (const interaction of this.interactions.values()) interaction.settle(false)
  }

  async disconnect(): Promise<void> {
    this.epoch++
    this.cancelAll()
    const client = this.client
    this.client = undefined
    this.connecting = undefined
    this.sessions.clear()
    this.summaries.clear()
    this.status = { state: 'disconnected', workingDirectory: this.status.workingDirectory }
    if (client) {
      try { await deadline(client.stop(), 5000) } catch { await client.forceStop() }
    }
  }
}