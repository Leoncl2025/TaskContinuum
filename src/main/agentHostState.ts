import { chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatAction, ChatState, Snapshot } from '@microsoft/agent-host-protocol'

export class AgentHostChatState {
  private state?: ChatState
  private sequence = -1

  constructor(readonly resource: string) {
    if (!/^ahp-chat:\/[^\s?#]+$/.test(resource)) throw new Error('An exact Agent Host chat resource is required.')
  }

  get lastSequence(): number { return this.sequence }
  get value(): ChatState | undefined { return this.state ? structuredClone(this.state) : undefined }

  snapshot(snapshot: Snapshot): void {
    if (snapshot.resource !== this.resource || !Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 0) throw new Error('Agent Host returned a different chat snapshot.')
    const state = snapshot.state as ChatState
    if (state.resource !== this.resource || !Array.isArray(state.turns) || typeof state.title !== 'string') throw new Error('Agent Host returned an invalid chat state.')
    if (snapshot.fromSeq < this.sequence) return
    this.state = structuredClone(state)
    this.sequence = snapshot.fromSeq
  }

  apply(envelope: ActionEnvelope): boolean {
    if (envelope.channel !== this.resource) throw new Error('Agent Host event belongs to another chat.')
    if (!Number.isSafeInteger(envelope.serverSeq) || envelope.serverSeq < 0) throw new Error('Agent Host event has an invalid sequence.')
    if (envelope.serverSeq <= this.sequence) return false
    if (!this.state) throw new Error('Agent Host chat needs a snapshot before incremental events.')
    if (!envelope.action.type.startsWith('chat/')) throw new Error('Agent Host returned a non-chat action for this chat.')
    this.state = chatReducer(this.state, envelope.action as ChatAction)
    this.sequence = envelope.serverSeq
    return true
  }
}