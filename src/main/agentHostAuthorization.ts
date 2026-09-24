import { mkdir } from 'node:fs/promises'
import type { AgentHostTarget } from '../shared/agentHost'
import type { SessionOwner } from '../shared/sessionBindings'
import { agentHostKey } from './agentHostProtocol'
import { acquireRepositorySessionAuthorization } from './repositorySessionLinks'
import { canonicalPolicyRoot, onLocalSessionLinkChange, readLocalSessionLinkReceipts } from './linkedSessionPolicy'
import { sessionLinkEntries } from '../shared/sessionBindings'
import { AuthorizationWatch } from './shared/authorizationWatch'
import { logAgentHostDiagnostic, measureAgentHostDiagnostic } from './agentHostDiagnostics'

export interface AgentHostAuthorizationLease {
  owner: SessionOwner
  targets: AgentHostTarget[]
  localTargets: AgentHostTarget[]
  current(): boolean
}

export class AgentHostAuthorization {
  private readonly watch = new AuthorizationWatch()
  private readonly leases = new Map<string, AgentHostAuthorizationLease>()
  private readonly pending = new Map<string, Promise<AgentHostAuthorizationLease>>()
  private readonly unlisten: () => void
  private initialized?: Promise<void>
  private closed = false

  constructor(private readonly directory: string, private readonly owner: () => Promise<SessionOwner>) {
    this.unlisten = onLocalSessionLinkChange(() => this.watch.invalidate())
  }

  async acquire(root: string): Promise<AgentHostAuthorizationLease> {
    if (this.closed) throw new Error('Agent Host authorization is closed.')
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    const cached = this.leases.get(key)
    if (cached?.current()) return cached
    let loading = this.pending.get(key)
    if (!loading) {
      if (!this.leases.has(key) && this.leases.size + this.pending.size >= 32) throw new Error('Too many Agent Host authorization scopes.')
      loading = measureAgentHostDiagnostic('authorization.acquire', { scope: root, step: 'load' }, () => this.load(root))
        .then((lease) => { this.leases.set(key, lease); return lease }).finally(() => { this.pending.delete(key) })
      this.pending.set(key, loading)
    } else logAgentHostDiagnostic('authorization.acquire', { scope: root, step: 'cache', status: 'scheduled', reason: 'coalesced' })
    return loading
  }

  private async load(root: string): Promise<AgentHostAuthorizationLease> {
    this.initialized ??= (async () => {
      await mkdir(this.directory, { recursive: true })
      this.watch.observe(this.directory, false, (name) => ['local-session-link-receipts.json', 'remote-vscode-identity.json', 'git-workspace-enrollments.json'].includes(name))
    })()
    await this.initialized
    const canonical = await canonicalPolicyRoot(root)
    for (let attempt = 0; attempt < 3; attempt++) {
      const unchanged = this.watch.checkpoint()
      const [binding, owner, receipts] = await Promise.all([
        measureAgentHostDiagnostic('authorization.acquire', { scope: canonical, step: 'binding' }, () => acquireRepositorySessionAuthorization(canonical)),
        measureAgentHostDiagnostic('authorization.acquire', { scope: canonical, step: 'identity' }, () => this.owner()),
        measureAgentHostDiagnostic('authorization.acquire', { scope: canonical, step: 'receipts' }, () => readLocalSessionLinkReceipts(this.directory)),
      ])
      if (this.closed) throw new Error('Agent Host authorization is closed.')
      if (!unchanged()) {
        logAgentHostDiagnostic('authorization.acquire', { scope: canonical, step: 'retry', status: 'scheduled', attempt: attempt + 1, reason: 'inputs-changed' })
        continue
      }
      const links = sessionLinkEntries(binding.snapshot.document.bindings)
      const targets = links.map(([, link]) => ({ sessionId: link.sessionId, chatId: link.chatId, owner: link.owner }))
      const localTargets = links.flatMap(([taskId, link]) => link.owner.clientId === owner.clientId && receipts.some((receipt) =>
        receipt.root === canonical && receipt.taskId === taskId && receipt.owner.clientId === owner.clientId
          && agentHostKey({ ...receipt.identity, owner: receipt.owner }) === agentHostKey(link)) ? [{ sessionId: link.sessionId, chatId: link.chatId, owner: link.owner }] : [])
      return { owner, targets, localTargets, current: () => !this.closed && unchanged() && binding.current() }
    }
    throw new Error('Agent Host access changed while connecting. Retry after configuration settles.')
  }

  close(): void { this.closed = true; this.unlisten(); this.watch.close(); this.leases.clear() }
}
