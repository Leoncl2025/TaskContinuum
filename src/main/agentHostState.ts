import { chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatAction, ChatState, Message, ResponsePart, Snapshot } from '@microsoft/agent-host-protocol'
import { agentHostTerminalIdSchema } from './agentHostProtocol'

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