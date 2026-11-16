import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import type { SessionOwner } from '../shared/sessionBindings'
import { AgentHostConnection } from './agentHostConnection'
import { logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostRegistry } from './agentHostRegistry'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { agentHostKey, agentHostTargetSchema } from './agentHostProtocol'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { AgentHostCreationClient } from './agentHostCreationClient'
import { LocalAgentHostCreationService } from './localAgentHostCreationService'
import { routeAgentHostCreations } from './localTaskAgentHostWorker'
import type { LocalTaskAgentHostWorker } from './localTaskAgentHostWorker'
import { AgentHostAuthorization } from './agentHostAuthorization'

export const REMOTE_AGENT_HOST_LIMITS = {
  maxConnections: 32,
  maxConnectionsPerOwner: 8,
} as const

export class AgentHostManager {
  private readonly remote = new Map<string, AgentHostConnection>()
  private readonly closing = new Map<string, Promise<void>>()
  private closed = false
  private consentWrite: Promise<void> = Promise.resolve()
  readonly creations: AgentHostCreationClient
  readonly localCreations: LocalAgentHostCreationService
  readonly access: AgentHostAuthorization

  constructor(private readonly directory: string, readonly local: AgentHostRegistry, private readonly devices: VSCodeDeviceClient, private readonly owner: () => Promise<SessionOwner>, localTaskWorker?: LocalTaskAgentHostWorker, access?: AgentHostAuthorization) {
    this.creations = new AgentHostCreationClient(directory, localTaskWorker ? routeAgentHostCreations(devices, localTaskWorker) : devices)
    this.localCreations = new LocalAgentHostCreationService(directory, local)
    this.access = access ?? new AgentHostAuthorization(directory, owner)
  }

  get hasActiveWork(): boolean {
    return this.local.hasActiveWork || this.localCreations.hasActiveWork || this.creations.hasActiveWork
      || [...this.remote.values()].some((connection) => connection.hasActiveWork)
  }

  private async consents(): Promise<string[]> {
    try { return z.array(z.string().max(4096)).max(100).parse(await readJsonBounded(join(this.directory, 'agent-host-consents.json'), 512 * 1024)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Agent Host access preferences are unreadable.')
      return []
    }
  }

  async hasConsent(root: string): Promise<boolean> { return (await this.consents()).includes(await canonicalPolicyRoot(root)) }

  async allow(root: string): Promise<void> {
    const canonical = await canonicalPolicyRoot(root)
    const operation = this.consentWrite.then(async () => { const prior = await this.consents(); if (!prior.includes(canonical)) await writeJsonAtomic(join(this.directory, 'agent-host-consents.json'), [...prior, canonical]) })
    this.consentWrite = operation.catch(() => undefined)
    await operation
  }

  async list(root: string) {
    const local = await this.hasConsent(root) ? await this.local.list() : { sessions: [], warnings: ['Local Agent Host access is not enabled for this workspace.'] }
    const remote = await this.devices.agentHostSessions(root)
    return { sessions: [...local.sessions, ...remote.sessions], warnings: [...local.warnings, ...remote.warnings] }
  }

  async verifyLink(root: string, value: AgentHostTarget): Promise<AgentHostTarget> {
    const target = agentHostTargetSchema.parse(value)
    if (target.owner.clientId === (await this.owner()).clientId) {
      if (!await this.hasConsent(root)) throw new Error('Enable Agent Host access from the session picker before linking.')
      const verified = await this.local.describe(target)
      return agentHostTargetSchema.parse({ sessionId: verified.sessionId, chatId: verified.chatId, owner: await this.owner() })
    }
    const verified = (await this.devices.agentHostSessions(root)).sessions.find((session) => agentHostKey(session) === agentHostKey(target))
    if (!verified) throw new Error('This exact Agent Host chat is not available from its authenticated owner.')
    return { sessionId: verified.sessionId, chatId: verified.chatId, owner: verified.owner }
  }

  async authorize(root: string, value: AgentHostTarget): Promise<void> {
    const target = agentHostTargetSchema.parse(value)
    let lease
    try { lease = await this.access.acquire(root) }
    catch (error) {
      if (target.owner.clientId === (await this.owner()).clientId && await this.localCreations.authorizes(root, target)) return
      throw error
    }
    const isLocal = target.owner.clientId === lease.owner.clientId
    if ((isLocal ? lease.localTargets : lease.targets).some((link) => agentHostKey(link) === agentHostKey(target))) return
    if (isLocal && await this.localCreations.authorizes(root, target)) return
    if (isLocal && lease.targets.some((link) => agentHostKey(link) === agentHostKey(target))) throw new Error('A Git-only edit cannot grant local Agent Host access. Confirm the link on its owner.')
    throw new Error('The task no longer links this exact Agent Host chat.')
  }

  async connection(root: string, value: AgentHostTarget): Promise<AgentHostConnection> {
    const target = agentHostTargetSchema.parse(value)
    await this.authorize(root, target)
    if (target.owner.clientId === (await this.owner()).clientId) return this.local.connection(target)
    const scope = createHash('sha256').update(await canonicalPolicyRoot(root)).digest('hex')
    if (this.closed) throw new Error('Agent Host manager is closed.')
    const key = `${scope}:${agentHostKey(target)}`
    const pendingClose = this.closing.get(key)
    if (pendingClose) await pendingClose
    if (this.closed) throw new Error('Agent Host manager is closed.')
    let connection = this.remote.get(key)
    if (connection) {
      this.remote.delete(key)
      this.remote.set(key, connection)
      return connection
    }
    this.trimRemoteOwner(target.owner.clientId)
    if (this.remote.size >= REMOTE_AGENT_HOST_LIMITS.maxConnections && !this.evictRemote(false) && !this.evictRemote(true)) {
      throw new Error('Remote Agent Host connection limit reached.')
    }
    connection = new AgentHostConnection(target, join(this.directory, 'agent-host-remotes', scope), async (signal, traceId) => {
      const started = performance.now()
      try {
        await this.authorize(root, target)
        logAgentHostDiagnostic('device.transport', { target, traceId, status: 'ok', step: 'authorization', elapsedMs: performance.now() - started })
      } catch (error) {
        logAgentHostDiagnostic('device.transport', { target, traceId, status: 'error', step: 'authorization', elapsedMs: performance.now() - started, error })
        throw error
      }
      return this.devices.agentHostTransport(root, target, signal, traceId)
    })
    this.remote.set(key, connection)
    return connection
  }

  private trimRemoteOwner(ownerClientId: string): void {
    let ownerCount = 0
    for (const existing of this.remote.values()) {
      if (existing.target.owner.clientId === ownerClientId) ownerCount++
    }
    while (ownerCount >= REMOTE_AGENT_HOST_LIMITS.maxConnectionsPerOwner) {
      const victim = [...this.remote.entries()].find(([, existing]) => existing.target.owner.clientId === ownerClientId && existing.canEvict())
      if (!victim) break
      this.evictEntry(victim[0], victim[1])
      ownerCount--
    }
  }

  private evictRemote(allowRemoteChatActivity: boolean): boolean {
    for (const [key, existing] of this.remote) {
      if (!existing.canEvict({ allowRemoteChatActivity })) continue
      this.evictEntry(key, existing)
      return true
    }
    return false
  }

  private evictEntry(key: string, connection: AgentHostConnection): void {
    this.remote.delete(key)
    const operation = connection.close().catch(() => undefined).finally(() => {
      if (this.closing.get(key) === operation) this.closing.delete(key)
    })
    this.closing.set(key, operation)
  }

  async close(): Promise<void> {
    this.closed = true
    this.access.close()
    await this.localCreations.close()
    await this.creations.close()
    const active = [...this.remote.values()]
    this.remote.clear()
    await Promise.all([...active.map((connection) => connection.close()), ...this.closing.values()])
    await this.local.close()
    await this.consentWrite
  }
}