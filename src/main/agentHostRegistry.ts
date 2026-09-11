import { randomUUID } from 'node:crypto'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { SessionState } from '@microsoft/agent-host-protocol'
import type { AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import type { SessionOwner } from '../shared/sessionBindings'
import { AgentHostConnection } from './agentHostConnection'
import { agentHostKey, agentHostSessionSchema, agentHostTargetSchema } from './agentHostProtocol'
import { connectLocalAgentHost, discoverAgentHosts } from './agentHostTransport'

export class AgentHostRegistry {
  private readonly connections = new Map<string, AgentHostConnection>()

  constructor(private readonly directory: string, private readonly discovery: string[], private readonly owner: () => Promise<SessionOwner>) {}

  async list(): Promise<{ sessions: AgentHostSession[]; warnings: string[] }> {
    const owner = await this.owner()
    const sessions: AgentHostSession[] = []
    const warnings: string[] = []
    for (const endpoint of await discoverAgentHosts(this.discovery)) {
      const abort = new AbortController()
      let client: AhpClient | undefined
      try {
        client = new AhpClient(await connectLocalAgentHost(endpoint, abort.signal), { requestTimeoutMs: 5000 })
        client.connect()
        await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
        let cursor: string | undefined
        do {
          const catalog = await client.request('listSessions', { channel: 'ahp-root://', limit: 100, ...(cursor ? { cursor } : {}) })
          for (const item of catalog.items) {
            if (sessions.length >= 1000) break
            if (item.provider !== 'copilotcli') continue
            const result = await client.request('subscribe', { channel: item.resource })
            const state = result.snapshot?.state as SessionState | undefined
            for (const chat of state?.chats ?? []) {
              if (chat.interactivity === 'hidden' || sessions.length >= 1000) continue
              sessions.push(agentHostSessionSchema.parse({ hostId: endpoint.instanceId, sessionId: item.resource, chatId: chat.resource, owner,
                title: (chat.title || item.title || 'Untitled chat').slice(0, 2000), provider: item.provider, updatedAt: chat.modifiedAt, canSend: chat.interactivity !== 'read-only' }))
            }
            await client.unsubscribe(item.resource)
          }
          if (catalog.nextCursor === cursor) break
          cursor = catalog.nextCursor
        } while (cursor && sessions.length < 1000)
      } catch { warnings.push('A local Agent Host could not be read. Check that it is running and supports AHP 0.9.0.') }
      finally { abort.abort(); await client?.shutdown() }
    }
    return { sessions, warnings }
  }

  async connection(value: AgentHostTarget): Promise<AgentHostConnection> {
    const target = agentHostTargetSchema.parse(value)
    if (target.owner.clientId !== (await this.owner()).clientId) throw new Error('The Agent Host belongs to a different execution device.')
    const key = agentHostKey(target)
    let connection = this.connections.get(key)
    if (!connection) {
      if (this.connections.size >= 64) throw new Error('Agent Host connection limit reached.')
      connection = new AgentHostConnection(target, this.directory, async (signal) => {
        const endpoint = (await discoverAgentHosts(this.discovery)).find((item) => item.instanceId === target.hostId)
        if (!endpoint) throw new Error('The exact original Agent Host is not running. No replacement Host was selected.')
        return connectLocalAgentHost(endpoint, signal)
      })
      this.connections.set(key, connection)
    }
    return connection
  }

  async describe(target: AgentHostTarget): Promise<AgentHostSession> {
    const connection = await this.connection(target)
    await connection.open()
    const state = connection.snapshot(target.sessionId).state as SessionState
    if (state.provider !== 'copilotcli') throw new Error('This build supports Copilot Agent Host sessions only.')
    const chat = connection.view.chat!
    return agentHostSessionSchema.parse({ ...target, title: (chat.title || state.title || 'Untitled chat').slice(0, 2000), provider: state.provider, updatedAt: chat.modifiedAt, canSend: chat.interactivity !== 'read-only' && chat.interactivity !== 'hidden' })
  }

  async close(): Promise<void> { await Promise.all([...this.connections.values()].map((connection) => connection.close())); this.connections.clear() }
}