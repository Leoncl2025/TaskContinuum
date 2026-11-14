import { chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatAction, ChatState, ChatTurnsLoadedAction, Message, ResponsePart, Snapshot } from '@microsoft/agent-host-protocol'
import { agentHostTerminalIdSchema } from './agentHostProtocol'

export const CHAT_HISTORY_PAGE_LIMITS = { turns: 20, bytes: 512 * 1024 } as const

export class AgentHostHistoryCursorError extends Error {}

export class AgentHostChatState {
  private state?: ChatState
  private sequence = -1
  private readonly turnIds = new Set<string>()
  private readonly historicalTerminals = new Set<string>()

  constructor(readonly resource: string) {
    if (!/^ahp-chat:\/[^\s?#]+$/.test(resource)) throw new Error('An exact Agent Host chat resource is required.')
  }

  get lastSequence(): number { return this.sequence }
  get value(): ChatState | undefined { return this.state ? structuredClone(this.state) : undefined }
  get loaded(): boolean { return this.state !== undefined }
  get completedTurns(): number { return this.state?.turns.length ?? 0 }
  get oldestTurnId(): string | undefined { return this.state?.turns[0]?.id }
  get nativeHistoryCursor(): string | undefined { return this.state?.turnsNextCursor }
  get sendState() {
    return {
      activeTurnId: this.state?.activeTurn?.id,
      hasDraft: Boolean(this.state?.draft?.text || this.state?.draft?.attachments?.length),
      hasQueuedMessages: Boolean(this.state?.queuedMessages?.length),
      readOnly: this.state?.interactivity === 'read-only' || this.state?.interactivity === 'hidden',
    }
  }
  hasTurn(id: string): boolean { return this.state?.activeTurn?.id === id || this.turnIds.has(id) }
  get selection(): Pick<Message, 'agent' | 'model'> | undefined {
    const message = this.state?.draft ?? this.state?.turns.at(-1)?.message
    return message ? structuredClone({ agent: message.agent, model: message.model }) : undefined
  }
  get terminalResources(): { referenced: Set<string>; active: Set<string> } {
    const referenced = new Set(this.historicalTerminals)
    const active = new Set<string>()
    for (const part of this.state?.activeTurn?.responseParts ?? []) {
      const resources = this.terminalsIn(part)
      for (const resource of resources) {
        referenced.add(resource)
        if (part.kind === 'toolCall' && (part.toolCall.status === 'running' || part.toolCall.status === 'auth-required')) active.add(resource)
      }
    }
    return { referenced, active }
  }
  toSnapshot(): Snapshot | undefined {
    return this.state ? { resource: this.resource, fromSeq: this.sequence, state: structuredClone(this.state) } : undefined
  }

  historySnapshot(beforeTurnId?: string): { snapshot: Snapshot; totalTurns?: number; beforeTurnId?: string } {
    if (!this.state) throw new Error('Agent Host chat needs a snapshot before loading history.')
    const end = beforeTurnId === undefined ? this.state.turns.length : this.state.turns.findIndex((turn) => turn.id === beforeTurnId)
    if (end < 0) throw new AgentHostHistoryCursorError('The original history cursor is no longer available.')
    let start = end
    let bytes = 0
    while (start > 0 && end - start < CHAT_HISTORY_PAGE_LIMITS.turns) {
      const size = Buffer.byteLength(JSON.stringify(this.state.turns[start - 1]), 'utf8')
      if (start < end && bytes + size > CHAT_HISTORY_PAGE_LIMITS.bytes) break
      bytes += size
      start--
    }
    const turns = this.state.turns.slice(start, end)
    const state: ChatState = beforeTurnId === undefined ? { ...this.state, turns } : {
      resource: this.resource, title: this.state.title, modifiedAt: this.state.modifiedAt, status: this.state.status, turns,
      ...(this.state.turnsNextCursor ? { turnsNextCursor: this.state.turnsNextCursor } : {}),
    }
    const hasMore = start > 0 || Boolean(this.state.turnsNextCursor)
    if (hasMore && !turns.length) throw new Error('The native Agent Host did not load an earlier history page.')
    return {
      snapshot: { resource: this.resource, fromSeq: this.sequence, state: structuredClone(state) },
      ...(!this.state.turnsNextCursor ? { totalTurns: this.state.turns.length } : {}),
      ...(hasMore ? { beforeTurnId: turns[0].id } : {}),
    }
  }

  prependHistory(snapshot: Snapshot, beforeTurnId: string): void {
    const page = new AgentHostChatState(this.resource)
    page.snapshot(snapshot)
    if (!this.state || this.state.turns[0]?.id !== beforeTurnId) throw new AgentHostHistoryCursorError('The displayed history changed while loading an earlier page.')
    const turns = page.state!.turns
    const ids = new Set<string>()
    for (const turn of turns) {
      if (ids.has(turn.id)) throw new Error('Agent Host returned duplicate history turns.')
      ids.add(turn.id)
    }
    this.state = chatReducer(this.state, {
      type: 'chat/turnsLoaded' as ChatTurnsLoadedAction['type'], turns, turnsNextCursor: page.state!.turnsNextCursor,
    })
    this.indexHistory()
  }

  retainEarlierHistory(previous: AgentHostChatState): string[] {
    if (!this.state || !previous.state) throw new Error('Both history windows must be loaded before retaining cached turns.')
    const first = this.state.turns[0]?.id
    const overlap = previous.state.turns.findIndex((turn) => turn.id === first)
    if (overlap <= 0) return []
    const turns = structuredClone(previous.state.turns.slice(0, overlap))
    this.state = { ...this.state, turns: [...turns, ...this.state.turns] }
    this.indexHistory()
    return turns.map((turn) => turn.id)
  }

  private terminalsIn(part: ResponsePart): string[] {
    if (part.kind !== 'toolCall' || !('content' in part.toolCall)) return []
    return (part.toolCall.content ?? []).flatMap((item) => item.type === 'terminal' && agentHostTerminalIdSchema.safeParse(item.resource).success ? [item.resource] : [])
  }

  private indexHistory(): void {
    this.turnIds.clear()
    this.historicalTerminals.clear()
    for (const turn of this.state?.turns ?? []) {
      this.turnIds.add(turn.id)
      for (const part of turn.responseParts) for (const resource of this.terminalsIn(part)) this.historicalTerminals.add(resource)
    }
  }

  snapshot(snapshot: Snapshot): void {
    if (snapshot.resource !== this.resource || !Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 0) throw new Error('Agent Host returned a different chat snapshot.')
    const state = snapshot.state as ChatState
    if (state.resource !== this.resource || !Array.isArray(state.turns) || typeof state.title !== 'string') throw new Error('Agent Host returned an invalid chat state.')
    if (snapshot.fromSeq < this.sequence) return
    this.state = structuredClone(state)
    this.sequence = snapshot.fromSeq
    this.indexHistory()
  }

  apply(envelope: ActionEnvelope): boolean {
    if (envelope.channel !== this.resource) throw new Error('Agent Host event belongs to another chat.')
    if (!Number.isSafeInteger(envelope.serverSeq) || envelope.serverSeq < 0) throw new Error('Agent Host event has an invalid sequence.')
    if (envelope.serverSeq <= this.sequence) return false
    if (!this.state) throw new Error('Agent Host chat needs a snapshot before incremental events.')
    if (!envelope.action.type.startsWith('chat/')) throw new Error('Agent Host returned a non-chat action for this chat.')
    const history = this.state.turns
    this.state = chatReducer(this.state, structuredClone(envelope.action) as ChatAction)
    if (history !== this.state.turns) this.indexHistory()
    this.sequence = envelope.serverSeq
    return true
  }
}