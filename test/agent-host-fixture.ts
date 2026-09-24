import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { chatReducer, terminalReducer, MessageKind } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatState, Message, RootState, SessionState, Snapshot, TerminalState } from '@microsoft/agent-host-protocol'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'
import { modelConfigFixture } from './agent-host-model-fixture'

export async function startAgentHostFixture(initializeMeta?: Record<string, unknown>) {
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
  let stallRoot = false
  let modelQueries = 0
  let failModels = false
  const terminals = new Map<string, TerminalState>()
  const failedTerminals = new Set<string>()
  const terminalSubscriptions = new Map<string, number>()
  const terminalDelays = new Map<string, Promise<void>>()
  const root: RootState = { agents: [
    { provider: 'copilotcli', displayName: 'Copilot', description: '', models: [{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }, { id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }, { id: 'disabled-model', name: 'Disabled', provider: 'copilotcli', policyState: 'disabled' as RootState['agents'][number]['models'][number]['policyState'] }] },
    { provider: 'private-provider', displayName: 'Private provider', description: '', models: [{ id: 'private-model', name: 'Private model', provider: 'private-provider' }] },
  ], activeSessions: 123, _meta: { privateMetadata: 'not shared' } }
  const snapshot = (resource: string): Snapshot => ({ resource, fromSeq: sequence, state: structuredClone(resource === 'ahp-root://' ? root : resource === chatId ? chat : terminals.get(resource) ?? session) })
  function addTerminal(resource: string, text = 'Full terminal output'): void {
    terminals.set(resource, { title: 'Terminal output', content: [{ type: 'unclassified', value: text }], lifecycle: { status: 'running' },
      claim: { kind: 'session', session: sessionId, chat: chatId } } as TerminalState)
  }
  function historyTerminals(count: number, fail = false, toolStatus: 'completed' | 'running' = 'completed'): string[] {
    const resources = Array.from({ length: count }, () => `ahp-terminal:/history-${randomUUID()}`)
    for (const [index, resource] of resources.entries()) {
      addTerminal(resource, `Full historical output ${index}`)
      if (fail) failedTerminals.add(resource)
    }
    chat = { ...chat, turns: [...chat.turns, ...resources.map((resource, index) => ({
      id: `history-${index}`, message: { text: 'Previous command', origin: { kind: MessageKind.User } }, state: 'complete',
      responseParts: [{ kind: 'toolCall', toolCall: { toolCallId: `tool-${index}`, toolName: 'terminal', displayName: 'Previous command',
        status: toolStatus, content: [{ type: 'terminal', resource, title: 'Terminal output', result: { preview: `Preview ${index}` } }] } }],
      usage: undefined,
    } as ChatState['turns'][number]))] }
    return resources
  }
  function terminalAction(resource: string, data: string): void {
    const state = terminals.get(resource)
    if (!state) throw new Error('Unknown fixture terminal.')
    const action = { type: 'terminal/data', data } as Parameters<typeof terminalReducer>[1]
    terminals.set(resource, terminalReducer(state, action))
    const envelope = { channel: resource, serverSeq: ++sequence, origin: undefined, action } as ActionEnvelope
    for (const [socket, subscribed] of subscriptions) if (subscribed.has(resource) && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: envelope }))
  }
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
      if (message.method === 'initialize') result = { protocolVersion: '0.9.0', serverSeq: sequence, snapshots: [], ...(initializeMeta ? { _meta: initializeMeta } : {}) }
      else if (message.method === 'listSessions') result = { items: [{ resource: sessionId, ...session, createdAt: chat.modifiedAt, modifiedAt: chat.modifiedAt }] }
      else if (message.method === 'subscribe') {
        if (message.params.channel === 'ahp-root://') {
          modelQueries++
          if (failModels) {
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Fixture model catalog failure.' } }))
            return
          }
        }
        if (stallRoot && message.params.channel === 'ahp-root://') return
        if (typeof message.params.channel === 'string' && message.params.channel.startsWith('ahp-terminal:/')) {
          const resource = message.params.channel
          terminalSubscriptions.set(resource, (terminalSubscriptions.get(resource) ?? 0) + 1)
          if (!terminals.has(resource) || failedTerminals.has(resource)) {
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Unspecified native terminal failure.' } }))
            return
          }
        }
        subscriptions.get(socket)!.add(message.params.channel)
        result = { snapshot: snapshot(message.params.channel) }
      }
      else if (message.method === 'unsubscribe') subscriptions.get(socket)!.delete(message.params.channel)
      else if (message.method === 'dispatchAction') {
        dispatches.push(message.params.action)
        if (loseNextSend) { loseNextSend = false; socket.terminate(); return }
        action(message.params.action)
      }
      const delayed = message.method === 'subscribe' ? terminalDelays.get(message.params.channel) : undefined
      if (delayed) {
        void delayed.then(() => { if (message.id !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })) })
        return
      }
      if (message.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint: AgentHostEndpoint = { schemaVersion: 2, type: 'standalone', pid: process.pid, instanceId: hostId, connectionToken: randomUUID(), protocolVersion: '0.9.0', endpoint: { type: 'tcp', host: '127.0.0.1', port: (server.address() as { port: number }).port } }
  const holdSnapshot = (resource: string) => {
    let release!: () => void
    terminalDelays.set(resource, new Promise<void>((resolve) => { release = resolve }))
    return () => { terminalDelays.delete(resource); release() }
  }
  return { endpoint, hostId, sessionId, chatId, dispatches, action, snapshot, addTerminal, historyTerminals, terminalAction,
    historyText: (count: number, text: string) => {
      chat = { ...chat, turns: Array.from({ length: count }, (_, index) => ({
        id: `history-${index}`, state: 'complete', message: { text: `Question ${index}`, origin: { kind: MessageKind.User } },
        responseParts: [{ kind: 'markdown', id: `answer-${index}`, content: text }], usage: undefined,
      } as ChatState['turns'][number])) }
    },
    modelQueries: () => modelQueries,
    failModels: (value: boolean) => { failModels = value },
    setModels: (models: RootState['agents'][number]['models']) => { root.agents[0].models = structuredClone(models) },
    failTerminal: (resource: string) => { failedTerminals.add(resource) },
    restoreTerminal: (resource: string) => { failedTerminals.delete(resource) },
    holdTerminal: holdSnapshot,
    holdModels: () => holdSnapshot('ahp-root://'),
    moveTerminalToOtherChat: (resource: string) => {
      const state = terminals.get(resource)
      if (!state) throw new Error('Unknown fixture terminal.')
      terminals.set(resource, { ...state, claim: { kind: 'session', session: sessionId, chat: 'ahp-chat:/private-other' } } as TerminalState)
    },
    terminalSubscriptions: (resource: string) => terminalSubscriptions.get(resource) ?? 0,
    drop: () => { for (const socket of sockets.clients) socket.terminate() }, loseNextSend: () => { loseNextSend = true }, stallRoot: () => { stallRoot = true }, draft: (text: string, selection: Pick<Message, 'model' | 'agent'> = {}) => { chat = { ...chat, draft: { ...selection, text, origin: { kind: MessageKind.User } } } }, close: async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}