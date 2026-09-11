import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { chatReducer, MessageKind } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatState, SessionState, Snapshot } from '@microsoft/agent-host-protocol'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'

export async function startAgentHostFixture() {
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const hostId = randomUUID()
  const sessionId = `copilotcli:/${randomUUID()}`
  const chatId = `ahp-chat://default/${Buffer.from(sessionId).toString('base64url')}`
  let sequence = 1
  let chat: ChatState = { resource: chatId, title: 'Original Host chat', status: 1, modifiedAt: new Date().toISOString(), turns: [] }
  const session: SessionState = { provider: 'copilotcli', title: chat.title, status: 1, lifecycle: 'ready' as SessionState['lifecycle'], activeClients: [], chats: [{ resource: chatId, title: chat.title, status: 1, modifiedAt: chat.modifiedAt }, { resource: 'ahp-chat:/private-other', title: 'Unshared sibling title', status: 1, modifiedAt: chat.modifiedAt }], defaultChat: chatId }
  const subscriptions = new Map<import('ws').WebSocket, Set<string>>()
  const dispatches: unknown[] = []
  let loseNextSend = false
  const snapshot = (resource: string): Snapshot => ({ resource, fromSeq: sequence, state: resource === chatId ? structuredClone(chat) : structuredClone(session) })
  function action(value: Record<string, unknown>) {
    const envelope = { channel: chatId, serverSeq: ++sequence, origin: undefined, action: value } as unknown as ActionEnvelope
    chat = chatReducer(chat, envelope.action as Parameters<typeof chatReducer>[1])
    for (const [socket, subscribed] of subscriptions) if (subscribed.has(chatId) && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: envelope }))
  }
  sockets.on('connection', (socket) => {
    subscriptions.set(socket, new Set())
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      let result: unknown = {}
      if (message.method === 'initialize') result = { protocolVersion: '0.9.0', serverSeq: sequence, snapshots: [] }
      else if (message.method === 'listSessions') result = { items: [{ resource: sessionId, ...session, createdAt: chat.modifiedAt, modifiedAt: chat.modifiedAt }] }
      else if (message.method === 'subscribe') { subscriptions.get(socket)!.add(message.params.channel); result = { snapshot: snapshot(message.params.channel) } }
      else if (message.method === 'dispatchAction') {
        dispatches.push(message.params.action)
        if (loseNextSend) { loseNextSend = false; socket.terminate(); return }
        action(message.params.action)
      }
      if (message.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint: AgentHostEndpoint = { schemaVersion: 2, type: 'standalone', pid: process.pid, instanceId: hostId, connectionToken: randomUUID(), protocolVersion: '0.9.0', endpoint: { type: 'tcp', host: '127.0.0.1', port: (server.address() as { port: number }).port } }
  return { endpoint, hostId, sessionId, chatId, dispatches, action, snapshot, drop: () => { for (const socket of sockets.clients) socket.terminate() }, loseNextSend: () => { loseNextSend = true }, draft: (text: string) => { chat = { ...chat, draft: { text, origin: { kind: MessageKind.User } } } }, close: async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}