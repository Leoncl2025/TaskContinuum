import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import type { SessionOwner } from '../shared/sessionBindings'
import { AgentHostConnection } from './agentHostConnection'
import type { AgentHostRegistry } from './agentHostRegistry'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { agentHostKey, agentHostTargetSchema } from './agentHostProtocol'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions } from './linkedSessionPolicy'
import { readRepositorySessionLinks } from './repositorySessionLinks'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { AgentHostCreationClient } from './agentHostCreationClient'
import { LocalAgentHostCreationService } from './localAgentHostCreationService'

export class AgentHostManager {
  private readonly remote = new Map<string, AgentHostConnection>()
  private consentWrite: Promise<void> = Promise.resolve()
  readonly creations: AgentHostCreationClient
  readonly localCreations: LocalAgentHostCreationService

  constructor(private readonly directory: string, readonly local: AgentHostRegistry, private readonly devices: VSCodeDeviceClient, private readonly owner: () => Promise<SessionOwner>) {
    this.creations = new AgentHostCreationClient(directory, devices)
    this.localCreations = new LocalAgentHostCreationService(directory, local)
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
    const owner = await this.owner()
    if (target.owner.clientId === owner.clientId && await this.localCreations.authorizes(root, target).catch(() => false)) return
    const { document } = await readRepositorySessionLinks(root)
    if (!Object.values(document.bindings).some((link) => link.provider === 'agent-host' && agentHostKey(link) === agentHostKey(target))) throw new Error('The task no longer links this exact Agent Host chat.')
    if (target.owner.clientId === owner.clientId && !(await locallyLinkedAgentHostSessions(this.directory, root, owner)).some((link) => agentHostKey(link) === agentHostKey(target))) throw new Error('A Git-only edit cannot grant local Agent Host access. Confirm the link on its owner.')
  }

  async connection(root: string, value: AgentHostTarget): Promise<AgentHostConnection> {
    const target = agentHostTargetSchema.parse(value)
    await this.authorize(root, target)
    if (target.owner.clientId === (await this.owner()).clientId) return this.local.connection(target)
    const scope = createHash('sha256').update(await canonicalPolicyRoot(root)).digest('hex')
    const key = `${scope}:${agentHostKey(target)}`
    let connection = this.remote.get(key)
    if (!connection) {
      if (this.remote.size >= 32) throw new Error('Remote Agent Host connection limit reached.')
      connection = new AgentHostConnection(target, join(this.directory, 'agent-host-remotes', scope), async (signal) => {
        await this.authorize(root, target)
        return this.devices.agentHostTransport(root, target, signal)
      })
      this.remote.set(key, connection)
    }
    return connection
  }

  async close(): Promise<void> { await this.localCreations.close(); await this.creations.close(); await Promise.all([...this.remote.values()].map((connection) => connection.close())); await this.local.close(); await this.consentWrite; this.remote.clear() }
}