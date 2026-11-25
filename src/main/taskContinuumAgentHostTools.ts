import { z } from 'zod'
import type { SessionState, ToolCallResult, ToolDefinition, ToolResultTextContent } from '@microsoft/agent-host-protocol'
import type { AgentHostConnection, AgentHostEvent } from './agentHostConnection'
import { agentHostChatIdSchema } from './agentHostProtocol'
import { logAgentHostDiagnostic } from './agentHostDiagnostics'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { COLLABORATION_LIMITS, CollaborationError } from '../shared/sessionCollaboration'
import type { AgentHostTarget } from '../shared/agentHost'
import { invokeTaskContinuumTool, taskContinuumToolFailure, taskContinuumTools } from './taskContinuumTools'
import type { TaskContinuumToolServices } from './taskContinuumTools'
import { toolRelayRequestSchema } from './taskContinuumToolRelay'
import type { ToolRelayRequest, ToolRelayResult } from './taskContinuumToolRelay'

const executionRequest = z.object({
  kind: z.literal('toolClientExecution'),
  id: z.string().min(1).max(2048),
  chat: agentHostChatIdSchema,
  turnId: z.string().min(1).max(512),
  clientId: z.string(),
  toolCall: z.object({
    status: z.literal('running'),
    toolCallId: z.string().min(1).max(512),
    toolName: z.string().min(1).max(128),
    contributor: z.object({ kind: z.literal('client'), clientId: z.string() }),
    toolInput: z.unknown(),
  }),
})
type ToolExecution = z.infer<typeof executionRequest>

export interface NativeToolChannel {
  clientId: string
  state: Pick<SessionState, 'chats' | 'activeClients' | 'inputNeeded'>
  claimCall(key: string): boolean
  publish(tools: ToolDefinition[]): number
  remove(): void
  complete(request: ToolExecution, result: ToolCallResult): void
}

type WorkspaceTools = (root: string, source: AgentHostTarget, beforeAccept: () => Promise<void>) => TaskContinuumToolServices
type View = { root: string; connection: AgentHostConnection; authorize: (root: string) => Promise<void> }
type RemoteView = { root?: never; connection: AgentHostConnection; authorize: () => Promise<void> }
type Registration = {
  connection: AgentHostConnection
  channel: NativeToolChannel
  clientSeq: number
  pending: Map<string, ToolExecution>
}

const definitions = taskContinuumTools.map(({ definition }) => definition)
const accessDenied = () => new CollaborationError('ACCESS_DENIED', '')

function isOwnedToolExecution(request: unknown, clientId: string): request is ToolExecution {
  const parsed = executionRequest.safeParse(request)
  return parsed.success && parsed.data.clientId === clientId && parsed.data.toolCall.contributor.clientId === clientId
}

function decodeArguments(input: unknown): unknown {
  if (input === undefined) return {}
  if (typeof input !== 'string' || Buffer.byteLength(input) > COLLABORATION_LIMITS.maxToolRequestBytes) {
    throw new CollaborationError('INVALID_REQUEST', '')
  }
  try { return JSON.parse(input) }
  catch { throw new CollaborationError('INVALID_REQUEST', '') }
}

export class TaskContinuumAgentHostTools {
  private readonly sessions = new Map<string, NativeSessionTools>()
  private running = 0

  constructor(private readonly tools: WorkspaceTools) {}

  private acquireExecution = (): (() => void) | undefined => {
    if (this.running >= COLLABORATION_LIMITS.maxConcurrentOperations) return undefined
    this.running++
    return () => { this.running-- }
  }

  attach(root: string, connection: AgentHostConnection, authorize: (root: string) => Promise<void>): () => void {
    return this.attachView({ root, connection, authorize }).close
  }

  attachRemote(connection: AgentHostConnection, authorize: () => Promise<void>) {
    return this.attachView({ connection, authorize })
  }

  private attachView(view: View | RemoteView) {
    if (!view.connection.isNative) return { close: () => {}, published: undefined }
    const id = view.connection.target.sessionId
    let session = this.sessions.get(id)
    if (!session) {
      session = new NativeSessionTools(this.tools, this.acquireExecution)
      this.sessions.set(id, session)
    }
    const detach = session.attach(view)
    const close = () => {
      detach()
      if (session.empty && this.sessions.get(id) === session) this.sessions.delete(id)
    }
    return { close, published: session.publishing }
  }

  async executeForCaller(root: string, source: AgentHostTarget, request: ToolRelayRequest, verify: () => Promise<void>): Promise<ToolRelayResult> {
    await verify()
    const result = await invokeTaskContinuumTool(this.tools(root, source, verify), request.toolName, request.arguments)
    await verify()
    return result
  }
}

class NativeSessionTools {
  private readonly views = new Set<View | RemoteView>()
  private registration?: Registration
  private refreshing?: Promise<void>
  private dirty = false
  private timer?: ReturnType<typeof setInterval>
  private readonly rejectedClients = new WeakMap<AgentHostConnection, string>()

  constructor(private readonly tools: WorkspaceTools, private readonly acquireExecution: () => (() => void) | undefined) {}

  get empty(): boolean { return this.views.size === 0 }
  get publishing(): Promise<void> | undefined { return this.refreshing }

  attach(view: View | RemoteView): () => void {
    this.views.add(view)
    const unlisten = view.connection.listen((event) => this.onEvent(view.connection, event))
    this.timer ??= setInterval(() => this.refresh(), 5000)
    this.timer.unref()
    this.refresh()
    return () => {
      unlisten()
      this.views.delete(view)
      if (this.registration?.connection === view.connection && ![...this.views].some((entry) => entry.connection === view.connection)) this.unregister()
      if (this.empty) { clearInterval(this.timer); this.timer = undefined }
      else this.refresh()
    }
  }

  private onEvent(connection: AgentHostConnection, event: AgentHostEvent): void {
    if (event.type === 'state' || event.type === 'snapshot' && event.snapshot.resource === connection.target.sessionId) this.refresh()
    if (event.type !== 'action' || event.envelope.channel !== connection.target.sessionId || connection !== this.registration?.connection) return
    const registration = this.registration
    const { action, origin, rejectionReason } = event.envelope
    if (action.type === 'session/activeClientSet' && origin?.clientId === registration.channel.clientId && origin.clientSeq === registration.clientSeq) {
      if (rejectionReason !== undefined) {
        this.rejectedClients.set(connection, registration.channel.clientId)
        this.registration = undefined
        logAgentHostDiagnostic('connection.tools', { target: connection.target, status: 'error', step: 'dispatch' })
      } else logAgentHostDiagnostic('connection.tools', { target: connection.target, status: 'ok', step: 'dispatch', count: definitions.length })
    } else if (action.type === 'session/activeClientRemoved' && action.clientId === registration.channel.clientId && rejectionReason === undefined) {
      this.rejectedClients.set(connection, registration.channel.clientId)
      this.registration = undefined
      this.refresh()
    } else if (action.type === 'session/inputNeededSet' && !origin && rejectionReason === undefined) {
      this.execute(registration, action.request)
    } else if (action.type === 'session/chatRemoved' || action.type === 'session/chatUpdated' && action.changes.interactivity !== undefined) {
      this.refresh()
    }
  }

  private refresh(): void {
    this.dirty = true
    if (this.refreshing) return
    this.refreshing = (async () => {
      while (this.dirty && !this.empty) {
        this.dirty = false
        await this.reconcile()
      }
    })().catch((error: unknown) => {
      logAgentHostDiagnostic('connection.tools', { status: 'error', step: 'authorization', error })
    }).finally(() => { this.refreshing = undefined; if (this.dirty && !this.empty) this.refresh() })
  }

  private async reconcile(): Promise<void> {
    let selected: { connection: AgentHostConnection; channel: NativeToolChannel } | undefined
    const candidates = [...this.views]
    // Keep an existing contributor when possible; VS Code fans out one session's tools to its chats.
    candidates.sort((a, b) => Number(b.connection === this.registration?.connection) - Number(a.connection === this.registration?.connection))
    for (const view of candidates) {
      const { connection } = view
      const channel = connection.nativeToolChannel()
      if (!channel || connection.readOnly || this.rejectedClients.get(connection) === channel.clientId) continue
      try {
        if (view.root === undefined) await view.authorize()
        else await view.authorize(await canonicalPolicyRoot(view.root))
      } catch { continue }
      if (!this.views.has(view) || connection.readOnly || connection.nativeToolChannel()?.clientId !== channel.clientId) continue
      selected = { connection, channel }
      break
    }
    if (selected?.channel.clientId === this.registration?.channel.clientId) return
    this.unregister()
    if (selected) {
      const clientSeq = selected.channel.publish(definitions)
      this.registration = { ...selected, clientSeq, pending: new Map() }
    }
  }

  private unregister(): void {
    const prior = this.registration
    if (prior) {
      for (const [key, request] of prior.pending) this.finish(prior, key, request,
        taskContinuumToolFailure(new CollaborationError('UNAVAILABLE', 'The TaskContinuum tool session closed or changed.')))
    }
    this.registration = undefined
    if (!prior || prior.connection.nativeToolChannel()?.clientId !== prior.channel.clientId) return
    try { prior.channel.remove() }
    catch (error) { logAgentHostDiagnostic('connection.tools', { target: prior.connection.target, status: 'error', step: 'dispatch', error }) }
  }

  private activeRequest(registration: Registration, request: ToolExecution): boolean {
    if (registration !== this.registration) return false
    const live = registration.connection.nativeToolChannel()
    return live?.clientId === registration.channel.clientId
      && live.state.activeClients.some((client) => client.clientId === live.clientId)
      && live.state.chats.some((chat) => chat.resource === request.chat)
      && (live.state.inputNeeded ?? []).some((entry) =>
        entry.kind === 'toolClientExecution' && entry.id === request.id && entry.chat === request.chat
        && entry.turnId === request.turnId && entry.toolCall.toolCallId === request.toolCall.toolCallId
        && entry.toolCall.status === 'running' && entry.toolCall.toolName === request.toolCall.toolName
        && entry.toolCall.toolInput === request.toolCall.toolInput
        && entry.clientId === live.clientId && entry.toolCall.contributor?.kind === 'client'
        && entry.toolCall.contributor.clientId === live.clientId)
  }

  private execute(registration: Registration, value: unknown): void {
    if (!isOwnedToolExecution(value, registration.channel.clientId) || !this.activeRequest(registration, value)) return
    const key = JSON.stringify([value.chat, value.turnId, value.toolCall.toolCallId])
    if (!registration.channel.claimCall(key)) return
    registration.pending.set(key, value)
    const release = this.acquireExecution()
    if (!release) {
      this.finish(registration, key, value, taskContinuumToolFailure(new CollaborationError('BUSY', '')))
      return
    }
    void (async () => {
      const current = () => {
        if (!this.activeRequest(registration, value)) throw accessDenied()
      }
      const views = [...this.views].filter(({ connection }) => connection.target.chatId === value.chat)
      const connection = views[0]?.connection
      if (!connection) throw accessDenied()
      const route = connection.nativeToolRoute(value.turnId)
      const args = decodeArguments(value.toolCall.toolInput)
      if (route !== 'local') {
        const request = toolRelayRequestSchema.parse({
          channel: value.chat, turnId: value.turnId, toolCallId: value.toolCall.toolCallId,
          toolName: value.toolCall.toolName, arguments: args,
        })
        const reply = await route(request, () => {
          current()
          if (connection.nativeToolRoute(value.turnId) !== route) throw accessDenied()
        })
        this.finish(registration, key, value, reply)
        return
      }
      const localViews = views.filter((view): view is View => view.root !== undefined)
      const rootKey = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root
      const roots = new Set(localViews.map(({ root }) => rootKey(root)))
      if (roots.size !== 1) throw accessDenied()
      const view = localViews[0]
      const root = await canonicalPolicyRoot(view.root)
      const verify = async () => {
        if (!this.activeRequest(registration, value) || !this.views.has(view)) throw accessDenied()
        try { await view.authorize(root) } catch { throw accessDenied() }
        if (view.connection.nativeToolRoute(value.turnId) !== 'local'
          || !this.activeRequest(registration, value) || !this.views.has(view)
          || [...this.views].some((entry) => entry.root !== undefined && entry.connection.target.chatId === value.chat
            && !roots.has(rootKey(entry.root)))) throw accessDenied()
      }
      await verify()
      const result = await invokeTaskContinuumTool(this.tools(root, view.connection.target, verify), value.toolCall.toolName, args)
      await verify()
      this.finish(registration, key, value, result)
    })().catch((error: unknown) => this.finish(registration, key, value, taskContinuumToolFailure(error))).finally(release)
  }

  private finish(registration: Registration, key: string, value: ToolExecution, payload: ToolRelayResult): void {
    if (!registration.pending.delete(key) || !this.activeRequest(registration, value)) return
    const error = 'error' in payload ? payload.error : undefined
    try {
      registration.channel.complete(value, {
        success: error === undefined,
        pastTenseMessage: error ? 'TaskContinuum could not complete the request' : 'TaskContinuum completed the request',
        content: [{ type: 'text' as ToolResultTextContent['type'], text: JSON.stringify(payload) }], structuredContent: payload,
        ...(error ? { error } : {}),
      })
    } catch (error) {
      logAgentHostDiagnostic('connection.tools', { target: registration.connection.target, status: 'error', step: 'response', error })
    }
  }
}
