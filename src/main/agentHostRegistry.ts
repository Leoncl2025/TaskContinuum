import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { CreateSessionParams, SessionState } from '@microsoft/agent-host-protocol'
import { z } from 'zod'
import type { AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import type { AgentHostCreationHost } from '../shared/agentHostCreation'
import type { SessionOwner } from '../shared/sessionBindings'
import { AgentHostConnection } from './agentHostConnection'
import { agentHostChatIdSchema, agentHostIdSchema, agentHostKey, agentHostSessionIdSchema, agentHostSessionSchema, agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostEndpoint } from './agentHostProtocol'
import { connectLocalAgentHost, discoverAgentHosts } from './agentHostTransport'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { sessionOwnerSchema } from './repositorySessionLinks'
import { readJsonBounded } from './shared/storage'

export class AgentHostCreationError extends Error {}
export type AgentHostCreationInspection = { state: 'creating'; error: string } | { state: 'failed'; error: string } | { state: 'ready'; nativeLifecycle: 'creating' | 'ready'; session: AgentHostSession }
export interface PreparedAgentHostCreation {
  readonly dispatched: boolean
  create(authorize: () => Promise<void>): Promise<void>
  inspect(chatId?: string, nativeAcknowledged?: boolean): Promise<AgentHostCreationInspection>
  close(): Promise<void>
}

const creationChatSchema = z.object({
  resource: agentHostChatIdSchema, title: z.string(), status: z.number().int(), modifiedAt: z.iso.datetime(),
  interactivity: z.enum(['full', 'read-only', 'hidden']).optional(), workingDirectories: z.array(z.string()).max(1).optional(),
})
const creationSessionSchema = z.object({
  provider: z.literal('copilotcli'), title: z.string(), lifecycle: z.enum(['creating', 'failed', 'ready']),
  workingDirectories: z.array(z.string()).max(1).optional(), chats: z.array(creationChatSchema).max(1000),
  defaultChat: agentHostChatIdSchema.optional(), creationError: z.unknown().optional(),
})
const resolvedConfigSchema = z.object({
  schema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().max(100), z.object({ type: z.enum(['string', 'number', 'boolean', 'array', 'object']), enum: z.array(z.unknown()).optional() })),
    required: z.array(z.string().max(100)).max(32).optional(),
  }),
  values: z.record(z.string().max(100), z.unknown()),
})

function creationConfig(value: unknown): Record<string, unknown> {
  const result = resolvedConfigSchema.safeParse(value)
  if (!result.success) throw new AgentHostCreationError('The Host did not provide a supported native session configuration.')
  const { schema, values } = result.data
  if (Object.keys(values).length > 32 || Buffer.byteLength(JSON.stringify(values)) > 32768) throw new AgentHostCreationError('The Host session configuration exceeds the supported limit.')
  if (values.isolation !== 'folder') throw new AgentHostCreationError('The Host configuration did not honor explicit folder isolation. No native session was created outside the authorized folder.')
  const supported = new Set(['isolation', 'target', 'branch', 'baseBranch', 'autoApprove', 'mode'])
  const label = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ? ` (${name})` : ''
  for (const name of schema.required ?? []) {
    if (!supported.has(name) || !Object.hasOwn(values, name)) throw new AgentHostCreationError(`The Host requires session configuration${label(name)} that this creation flow cannot supply. Configure the Host explicitly before retrying.`)
  }
  for (const name of ['isolation', 'target', 'autoApprove', 'mode']) {
    if (Object.hasOwn(schema.properties, name) && !Object.hasOwn(values, name)) throw new AgentHostCreationError(`The Host did not resolve its native ${name} configuration. No implicit isolation or approval default was selected.`)
  }
  for (const [name, value] of Object.entries(values)) {
    const property = schema.properties[name]
    if (!supported.has(name) || !property || typeof value !== property.type || property.enum && !property.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      throw new AgentHostCreationError(`The Host resolved unsupported native session configuration${label(name)}. No configuration override was applied.`)
    }
    if (name === 'target' && value !== 'workspace'
      || name === 'autoApprove' && value !== false && value !== 'default' && value !== 'none'
      || name === 'mode' && value !== 'interactive' && value !== 'default') {
      throw new AgentHostCreationError('The Host resolved configuration with elevated approval settings or a different execution target. No permission override was applied.')
    }
  }
  return values
}

export class AgentHostRegistry {
  private readonly connections = new Map<string, AgentHostConnection>()
  private readonly knownCreationHosts = new Map<string, AgentHostCreationHost>()

  constructor(private readonly directory: string, private readonly discovery: string[], private readonly owner: () => Promise<SessionOwner>) {}

  async creationOwner(): Promise<SessionOwner> { return sessionOwnerSchema.parse(await this.owner()) }

  async creationHosts(signal: AbortSignal): Promise<AgentHostCreationHost[]> {
    const endpoints = (await discoverAgentHosts(this.discovery)).slice(0, 128)
    const current = new Map<string, AgentHostCreationHost>()
    await Promise.all(endpoints.map(async (endpoint) => {
      const name = `Agent Host ${endpoint.instanceId.slice(0, 12)}`
      try {
        const connection = await this.creationClient(endpoint.instanceId, signal, endpoint)
        try {
          await this.requireCreationProvider(connection.client)
          current.set(endpoint.instanceId, { hostId: endpoint.instanceId, name, available: true })
        } finally { await connection.close() }
      } catch (error) {
        current.set(endpoint.instanceId, { hostId: endpoint.instanceId, name, available: false,
          error: error instanceof AgentHostCreationError ? error.message : 'This exact local Host is offline or does not support AHP 0.9.0.' })
      }
    }))
    for (const host of await this.unavailableCreationHosts()) if (!current.has(host.hostId) && current.size < 128) current.set(host.hostId, host)
    for (const [id, host] of this.knownCreationHosts) if (!current.has(id) && current.size < 128) current.set(id, { ...host, available: false, error: 'This exact original Agent Host is no longer running.' })
    this.knownCreationHosts.clear()
    for (const [id, host] of current) this.knownCreationHosts.set(id, host)
    return [...current.values()].sort((left, right) => left.hostId.localeCompare(right.hostId))
  }

  private async unavailableCreationHosts(): Promise<AgentHostCreationHost[]> {
    const hosts: AgentHostCreationHost[] = []
    const metadata = z.object({ instanceId: agentHostIdSchema, pid: z.number().int().positive(), protocolVersion: z.string().max(40).optional(), schemaVersion: z.number().optional() })
    for (const directory of this.discovery) {
      const info = await lstat(directory).catch(() => undefined)
      if (!info?.isDirectory() || info.isSymbolicLink()) continue
      for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 128)) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || hosts.length >= 128) continue
        try {
          const file = join(directory, entry.name)
          const info = await lstat(file)
          if (info.isSymbolicLink() || info.nlink !== 1) continue
          const value = metadata.parse(await readJsonBounded(file, 16384))
          let error: string | undefined
          if (value.protocolVersion !== '0.9.0' || value.schemaVersion !== 2) error = 'This Host discovery version is unsupported. Creation requires AHP 0.9.0 and a version 2 descriptor.'
          else try { process.kill(value.pid, 0) } catch { error = 'This advertised Agent Host process is offline.' }
          if (error) hosts.push({ hostId: value.instanceId, name: `Agent Host ${value.instanceId.slice(0, 12)}`, available: false, error })
        } catch { continue }
      }
    }
    return hosts
  }

  private async creationClient(hostId: string, signal: AbortSignal, advertised?: AgentHostEndpoint) {
    agentHostIdSchema.parse(hostId)
    const abort = new AbortController()
    const cancellation = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(10000)])
    const endpoint = advertised ?? (await discoverAgentHosts(this.discovery)).find((item) => item.instanceId === hostId)
    if (!endpoint) throw new AgentHostCreationError('The exact selected Agent Host is not running. No replacement Host was selected.')
    let client: AhpClient | undefined
    const close = async () => { abort.abort(); await client?.shutdown() }
    try {
      client = new AhpClient(await connectLocalAgentHost(endpoint, cancellation), { requestTimeoutMs: 5000 })
      client.connect()
      const initialized = await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      if (initialized.protocolVersion !== '0.9.0') throw new AgentHostCreationError('The selected Host does not support AHP 0.9.0.')
      return { client, signal: cancellation, close }
    } catch (error) { await close(); throw error }
  }

  private async requireCreationProvider(client: AhpClient): Promise<void> {
    const result = await client.request('subscribe', { channel: 'ahp-root://' })
    const root = z.object({ agents: z.array(z.object({ provider: z.string() })).max(128) }).safeParse(result.snapshot?.state)
    if (result.snapshot?.resource !== 'ahp-root://' || !root.success || !root.data.agents.some((agent) => agent.provider === 'copilotcli')) {
      throw new AgentHostCreationError('The selected Host does not advertise the supported copilotcli provider.')
    }
    await client.unsubscribe('ahp-root://')
  }

  async prepareCreation(hostId: string, sessionId: string, root: string, signal: AbortSignal): Promise<PreparedAgentHostCreation> {
    agentHostSessionIdSchema.parse(sessionId)
    if (!sessionId.startsWith('copilotcli:/')) throw new AgentHostCreationError('Creation requires a native copilotcli session identity.')
    const canonical = await canonicalPolicyRoot(root)
    const owner = await this.creationOwner()
    const connection = await this.creationClient(hostId, signal)
    try {
      await this.requireCreationProvider(connection.client)
      const workingDirectory = pathToFileURL(canonical).href
      const resolved = await connection.client.request('resolveSessionConfig', { channel: 'ahp-root://', provider: 'copilotcli', workingDirectory, config: { isolation: 'folder' } })
      const config = creationConfig(resolved)
      const command: CreateSessionParams = { channel: sessionId, provider: 'copilotcli', workingDirectories: [workingDirectory], config }
      let dispatched = false
      return {
        get dispatched() { return dispatched },
        create: async (authorize) => {
          if (dispatched) throw new AgentHostCreationError('Native creation cannot be replayed.')
          await authorize()
          connection.signal.throwIfAborted()
          dispatched = true
          if (await connection.client.request('createSession', command) !== null) throw new AgentHostCreationError('The native creation acknowledgement was not recognized. Query the original operation; do not create a replacement.')
        },
        inspect: (chatId, nativeAcknowledged) => this.inspectCreatedSession(connection.client, hostId, sessionId, canonical, owner, chatId, nativeAcknowledged),
        close: connection.close,
      }
    } catch (error) { await connection.close(); throw error }
  }

  async inspectCreation(hostId: string, sessionId: string, root: string, signal: AbortSignal, chatId?: string, nativeAcknowledged = false): Promise<AgentHostCreationInspection> {
    agentHostSessionIdSchema.parse(sessionId)
    const owner = await this.creationOwner()
    const connection = await this.creationClient(hostId, signal)
    try { return await this.inspectCreatedSession(connection.client, hostId, sessionId, root, owner, chatId, nativeAcknowledged) }
    finally { await connection.close() }
  }

  private async inspectCreatedSession(client: AhpClient, hostId: string, sessionId: string, root: string, owner: SessionOwner, expectedChatId?: string, nativeAcknowledged = false): Promise<AgentHostCreationInspection> {
    const result = await client.request('subscribe', { channel: sessionId })
    const parsed = creationSessionSchema.safeParse(result.snapshot?.state)
    if (result.snapshot?.resource !== sessionId || !parsed.success) throw new AgentHostCreationError('The exact native session could not be verified. No creation was replayed.')
    const state = parsed.data
    if (state.lifecycle === 'failed') return { state: 'failed', error: 'The native Host reported that session creation failed. No prompt was submitted.' }
    if (state.creationError !== undefined && state.creationError !== null) throw new AgentHostCreationError('The native session reports a creation error. It was not accepted or bound.')
    // Copilot's _reserveChatBacking defers materialization until first send; a durable create ACK permits that provisional state.
    if (state.lifecycle === 'creating' && !nativeAcknowledged) return { state: 'creating', error: 'Native lifecycle is creating, but the native create acknowledgement was not durably confirmed. The outcome remains uncertain; creation will not be replayed.' }
    await this.verifyCreationDirectory(state.workingDirectories, root)
    const chatId = expectedChatId ?? state.defaultChat
    const summary = state.chats.find((chat) => chat.resource === chatId)
    if (!chatId || !summary || summary.interactivity === 'read-only' || summary.interactivity === 'hidden') throw new AgentHostCreationError('The created session has no verified usable default chat.')
    if (summary.workingDirectories) await this.verifyCreationDirectory(summary.workingDirectories, root)
    const chatResult = await client.request('subscribe', { channel: chatId })
    const chat = creationChatSchema.extend({ turns: z.array(z.unknown()) }).safeParse(chatResult.snapshot?.state)
    if (chatResult.snapshot?.resource !== chatId || !chat.success || chat.data.resource !== chatId || chat.data.interactivity === 'read-only' || chat.data.interactivity === 'hidden') {
      throw new AgentHostCreationError('The created chat snapshot does not match the verified session chat.')
    }
    if (chat.data.workingDirectories) await this.verifyCreationDirectory(chat.data.workingDirectories, root)
    return { state: 'ready', nativeLifecycle: state.lifecycle, session: agentHostSessionSchema.parse({ hostId, sessionId, chatId, owner, title: 'New Copilot chat', provider: 'copilotcli', updatedAt: chat.data.modifiedAt, canSend: true }) }
  }

  private async verifyCreationDirectory(directories: string[] | undefined, root: string): Promise<void> {
    try {
      if (directories?.length !== 1 || new URL(directories[0]).protocol !== 'file:' || await canonicalPolicyRoot(fileURLToPath(directories[0])) !== await canonicalPolicyRoot(root)) throw new Error('Mismatch.')
    } catch { throw new AgentHostCreationError('The native session working directory does not match the authorized workspace. It was not bound or recreated.') }
  }

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

  private async restoredEndpoint(target: AgentHostTarget, endpoints: AgentHostEndpoint[], signal: AbortSignal): Promise<AgentHostEndpoint> {
    const candidates = await Promise.all(endpoints.map(async (endpoint) => {
      try {
        const probe = await this.creationClient(endpoint.instanceId, signal, endpoint)
        try {
          const { snapshot } = await probe.client.request('subscribe', { channel: target.sessionId })
          const session = snapshot?.state as SessionState | undefined
          if (snapshot?.resource !== target.sessionId || session?.provider !== 'copilotcli'
            || !session.chats?.some((chat) => chat.resource === target.chatId && chat.interactivity !== 'hidden')) return undefined
          const chat = await probe.client.request('subscribe', { channel: target.chatId })
          return chat.snapshot?.resource === target.chatId ? endpoint : undefined
        } finally { await probe.close() }
      } catch { return undefined }
    }))
    signal.throwIfAborted()
    const matches = candidates.filter((endpoint) => endpoint !== undefined)
    if (matches.length !== 1) throw new Error(matches.length ? 'The original chat is available on multiple local Agent Hosts. Explicitly confirm its Host before reconnecting.'
      : 'The original chat is unavailable on the current local Agent Hosts. No replacement session was selected.')
    return matches[0]
  }

  async connection(value: AgentHostTarget): Promise<AgentHostConnection> {
    const target = agentHostTargetSchema.parse(value)
    if (target.owner.clientId !== (await this.owner()).clientId) throw new Error('The Agent Host belongs to a different execution device.')
    const key = agentHostKey(target)
    let connection = this.connections.get(key)
    if (!connection) {
      if (this.connections.size >= 64) throw new Error('Agent Host connection limit reached.')
      connection = new AgentHostConnection(target, this.directory, async (signal) => {
        const endpoints = await discoverAgentHosts(this.discovery)
        const endpoint = endpoints.find((item) => item.instanceId === target.hostId) ?? await this.restoredEndpoint(target, endpoints, signal)
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