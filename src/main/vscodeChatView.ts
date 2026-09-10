import type { VSCodeChatDelivery, VSCodeChatParticipant, VSCodeChatView, VSCodeExecutionIdentity } from '../shared/vscodeChat'
import type { VSCodeSessionStore } from './vscodeSessions'
import { boundedHistory } from '../shared/boundedHistory'
import { deliveryPrompt } from './vscodeChatDelivery'

export function originalChatView(original: Awaited<ReturnType<VSCodeSessionStore['locateOriginal']>>, deliveries: VSCodeChatDelivery[], connection: {
  connected: boolean
  supportsSending: boolean
  participant?: VSCodeChatParticipant
  execution?: VSCodeExecutionIdentity
  bridgeError?: string
  readOnly?: boolean
  sessionOpen?: boolean
  autoOpenOnSend?: boolean
}): VSCodeChatView {
  const byRequest = new Map<string, VSCodeChatDelivery>()
  for (const delivery of deliveries) {
    const requestId = delivery.nativeRequestId ?? original.state.turns.find((turn) => turn.prompt === deliveryPrompt(delivery))?.id
    if (requestId) byRequest.set(requestId, delivery)
  }
  const messages = original.snapshot.messages.map((message) => {
    const delivery = message.nativeRequestId ? byRequest.get(message.nativeRequestId) : undefined
    if (!delivery) return message
    if (message.role === 'user') return { ...message, text: delivery.text, author: { name: delivery.participant.username, machineName: delivery.participant.machineName } }
    const turn = original.state.turns.find((item) => item.id === message.nativeRequestId)
    return { ...message, author: { name: message.author?.name ?? delivery.execution.agentName, machineName: delivery.execution.machineName },
      status: turn?.cancelled ? 'cancelled' as const : turn?.error ? 'error' as const : turn?.complete ? 'complete' as const : 'streaming' as const }
  })
  const responding = original.state.turns.at(-1)?.complete === false
  const blocked = deliveries.some((record) => record.state === 'pending' || record.state === 'uncertain')
  const connectionState = !connection.connected ? 'offline' : connection.supportsSending ? 'connected' : 'unsupported'
  let bridgeError = connection.bridgeError
  if (connectionState === 'unsupported') bridgeError = 'The running VS Code bridge does not support sending. Reload the updated companion and reconnect.'
  else if (connectionState === 'connected') {
    if (connection.readOnly) bridgeError = 'This remote invitation allows reading only.'
    else if (blocked) bridgeError = deliveries.some((record) => record.state === 'uncertain') ? 'A previous delivery has an unknown outcome. Check the original conversation before sending again.' : 'Delivering to the original VS Code session.'
    else if (connection.sessionOpen === false && !connection.autoOpenOnSend) bridgeError = 'Bridge connected, but this original session is not open. Use the Open action before sending.'
    else if (responding) bridgeError = 'The original Agent is still responding. Sending becomes available after its saved state is idle.'
    else if (original.state.mode?.kind !== 'agent') bridgeError = 'Select Agent mode in the original VS Code conversation before sending.'
    else if (original.state.hasDraft) bridgeError = 'The original VS Code conversation has a saved draft. Send or clear it there first.'
  }
  const eligible = Boolean(connection.connected && connection.supportsSending && !connection.readOnly && !responding && !blocked && !original.state.hasDraft && original.state.mode?.kind === 'agent')
  return { ...original.snapshot, ...boundedHistory(messages), deliveries, responding, connectionState,
    participant: connection.participant, execution: connection.execution,
    ...(connection.sessionOpen !== undefined ? { sessionOpen: connection.sessionOpen } : {}),
    ...(connection.autoOpenOnSend ? { canPrepareSend: eligible && connection.sessionOpen === false } : {}),
    canSend: eligible && connection.sessionOpen !== false, bridgeError,
  }
}