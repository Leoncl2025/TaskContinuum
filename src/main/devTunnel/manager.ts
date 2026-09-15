import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DevTunnelStatus } from '../../shared/devTunnel'
import { readJsonBounded, writeJsonAtomic } from '../shared/storage'
import { DevTunnelCli } from './cli'
import { SdkTunnelCloud } from './cloud'
import type { TunnelCloud, CloudConnection } from './cloud'
import { DeviceSshKeys } from './identity'
import { devTunnelIdSchema, devTunnelRouteSchema, sshFingerprint } from './protocol'
import type { DevTunnelRoute } from './protocol'
import { openSessionSshBridge, startSessionSshHost } from './sessionSsh'

const publicationSchema = z.object({ tunnelId: devTunnelIdSchema, sshPort: z.number().int().min(1024).max(65535), accountId: z.string().min(1).max(300), enabled: z.boolean().optional() }).strict()
type Publication = z.infer<typeof publicationSchema>

export class ManagedDevTunnels {
  private operation?: { abort: AbortController; promise: Promise<void> }
  private failedOperation?: 'signing-in' | 'starting'
  private publication?: Publication
  private host?: Awaited<ReturnType<typeof startSessionSshHost>>
  private cloudHost?: CloudConnection
  private state: DevTunnelStatus = { installed: false, state: 'idle' }
  private readonly file: string
  private readonly clients = new Set<() => void>()
  private recovery?: ReturnType<typeof setInterval>
  private restoreGrants?: () => Promise<void>
  private recoveryEnabled = false
  private retryAfter = 0
  private failures = 0

  constructor(directory: string, readonly keys: DeviceSshKeys, private readonly cli = new DevTunnelCli(), private readonly cloud: TunnelCloud = new SdkTunnelCloud(cli)) {
    this.file = join(directory, 'dev-tunnel-publication.json')
  }

  async status(refresh = false): Promise<DevTunnelStatus> {
    if (refresh && !this.operation) {
      try {
        const login = await this.cli.status()
        this.state.installed = login.installed
        this.state.account = login.account
        if (login.accountId && this.failedOperation === 'signing-in') {
          this.failedOperation = undefined
          this.state.state = 'idle'
          this.state.error = undefined
        }
        if (this.cloudHost && this.publication?.accountId !== login.accountId) await this.stop()
      } catch (error) { this.state.error = error instanceof Error ? error.message : 'Dev Tunnel status unavailable.' }
    }
    if (this.cloudHost && !this.cloudHost.connected()) { this.state.state = 'offline'; this.state.error = 'The private publication disconnected. Waiting to reconnect; no message will be replayed.' }
    return structuredClone(this.state)
  }

  async startRecovery(restoreGrants: () => Promise<void>): Promise<void> {
    this.restoreGrants = restoreGrants
    try { this.recoveryEnabled = publicationSchema.parse(await readJsonBounded(this.file, 4096)).enabled === true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.state.state = 'offline'; this.state.error = 'Saved publication is unreadable. It was not replaced.'; return }
    }
    const recover = () => {
      if (!this.recoveryEnabled || this.operation || this.cloudHost?.connected() || Date.now() < this.retryAfter) return
      void this.publish().catch(() => { this.failures++; this.retryAfter = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)) })
    }
    if (!this.recovery) { this.recovery = setInterval(recover, 5000); this.recovery.unref() }
    recover()
  }

  private run(state: 'signing-in' | 'starting', action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.operation) return Promise.reject(new Error('A Dev Tunnel operation is already running. Cancel it before starting another.'))
    const abort = new AbortController()
    this.state.state = state
    this.state.error = undefined
    this.failedOperation = undefined
    const timeout = setTimeout(() => abort.abort(), state === 'signing-in' ? 300000 : 60000)
    timeout.unref()
    const promise = action(abort.signal).catch((error: unknown) => {
      this.failedOperation = state
      this.state.state = 'offline'
      this.state.error = error instanceof Error ? error.message : 'Dev Tunnel operation failed.'
      throw error
    }).finally(() => { clearTimeout(timeout); if (this.operation?.abort === abort) this.operation = undefined })
    this.operation = { abort, promise }
    return promise
  }

  login(): Promise<void> {
    if (this.cloudHost) return Promise.reject(new Error('Stop this publication before changing its company sign-in.'))
    return this.run('signing-in', async (signal) => {
      await this.cli.login(signal)
      const login = await this.cli.status(signal)
      if (!login.account) throw new Error('Company sign-in did not complete.')
      this.state = { installed: true, account: login.account, state: 'idle' }
    })
  }

  publish(): Promise<void> {
    if (this.cloudHost?.connected()) return Promise.resolve()
    return this.run('starting', async (signal) => {
      const login = await this.cli.status(signal)
      if (!login.accountId) throw new Error('Sign in with your company account before publishing.')
      let saved: Publication | undefined
      try { saved = publicationSchema.parse(await readJsonBounded(this.file, 4096)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The saved publication is invalid and was not replaced.')
      }
      if (saved && saved.accountId !== login.accountId) throw new Error('This publication belongs to a different company identity. Sign in with its original owner.')
      const key = await this.keys.get('host')
      const recovering = !!this.host
      const previousCloud = this.cloudHost
      this.cloudHost = undefined
      await previousCloud?.close()
      const ssh = this.host ?? await startSessionSshHost(key, saved?.sshPort)
      this.host = ssh
      try {
        signal.throwIfAborted()
        const tunnelId = saved?.tunnelId ?? await this.cli.create(`taskcontinuum-${randomUUID().replaceAll('-', '')}`, signal)
        this.publication = { tunnelId, sshPort: ssh.port, accountId: login.accountId, enabled: saved?.enabled ?? false }
        this.state.tunnelId = tunnelId
        await writeJsonAtomic(this.file, this.publication)
        await this.cli.inspect(tunnelId, signal)
        this.cloudHost = await this.cloud.host(tunnelId, ssh.port, signal)
        signal.throwIfAborted()
        await this.restoreGrants?.()
        signal.throwIfAborted()
        this.publication.enabled = true
        await writeJsonAtomic(this.file, this.publication)
        this.recoveryEnabled = true
        this.failures = 0
        this.retryAfter = 0
        this.state = { installed: true, account: login.account, state: 'hosting', tunnelId, hostFingerprint: sshFingerprint(key.publicKey) }
      } catch (error) {
        if (!recovering) await this.releaseHost()
        else { const cloud = this.cloudHost; this.cloudHost = undefined; await cloud?.close() }
        throw error
      }
    })
  }

  publicEndpoint(): { tunnelId: string; sshPort: number; hostPublicKey: string } | undefined {
    if (this.state.state !== 'hosting' || !this.host || !this.publication || !this.cloudHost?.connected()) return undefined
    return { tunnelId: this.publication.tunnelId, sshPort: this.host.port, hostPublicKey: this.host.publicKey }
  }

  authorize(grant: { id: string; expiresAt: string }, clientPublicKey: string, bridgePort: number, device = false): DevTunnelRoute {
    if (!this.host || !this.publication || !this.cloudHost?.connected()) throw new Error('Publish this machine before creating a Dev Tunnel invitation.')
    const route = devTunnelRouteSchema.parse({ kind: 'dev-tunnel', tunnelId: this.publication.tunnelId, sshPort: this.host.port, hostPublicKey: this.host.publicKey, clientPublicKey })
    this.host.allow(grant.id, clientPublicKey, bridgePort, grant.expiresAt, device)
    return route
  }

  revoke(grantId: string): void { this.host?.revoke(grantId) }

  async connect(route: DevTunnelRoute, grantId: string, bridgePort: number, signal: AbortSignal): Promise<{ port: number; close(): void }> {
    const selected = devTunnelRouteSchema.parse(route)
    const key = await this.keys.get('client')
    if (selected.clientPublicKey !== key.publicKey) throw new Error('This invitation belongs to a different SSH device key. Export this desktop identity and pair again.')
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, deadline.signal])
    const timeout = setTimeout(() => deadline.abort(), 45000)
    timeout.unref()
    const outer = await this.cloud.connect(selected.tunnelId, selected.sshPort, combined).catch((error: unknown) => { clearTimeout(timeout); throw error })
    try {
      const inner = await openSessionSshBridge(outer.stream, { key, hostPublicKey: selected.hostPublicKey, grantId, targetPort: bridgePort, signal: combined })
      clearTimeout(timeout)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        this.clients.delete(close)
        signal.removeEventListener('abort', close)
        inner.close()
        void outer.close().catch(() => undefined)
      }
      this.clients.add(close)
      signal.addEventListener('abort', close, { once: true })
      combined.throwIfAborted()
      return { port: inner.port, close }
    } catch (error) { clearTimeout(timeout); await outer.close().catch(() => undefined); throw error }
  }

  private async releaseHost(): Promise<void> {
    const cloud = this.cloudHost
    const ssh = this.host
    this.cloudHost = undefined
    this.host = undefined
    await ssh?.close()
    await cloud?.close()
  }

  async cancel(): Promise<void> {
    const operation = this.operation
    if (!operation) return
    operation.abort.abort()
    await operation.promise.catch(() => undefined)
    if (!this.operation && !this.cloudHost) { this.state.state = 'idle'; this.state.error = undefined }
  }

  async stop(): Promise<void> {
    this.recoveryEnabled = false
    await this.cancel()
    await this.releaseHost()
    if (this.publication) { this.publication.enabled = false; await writeJsonAtomic(this.file, this.publication) }
    this.state.state = 'idle'
    this.state.error = undefined
  }

  reset(): Promise<void> {
    this.recoveryEnabled = false
    return this.run('starting', async (signal) => {
      await this.releaseHost()
      signal.throwIfAborted()
      await rm(this.file, { force: true })
      this.publication = undefined
      this.state = { installed: this.state.installed, account: this.state.account, state: 'idle' }
    })
  }

  async close(): Promise<void> {
    clearInterval(this.recovery)
    this.recoveryEnabled = false
    for (const close of this.clients) close()
    await this.cancel()
    await this.releaseHost()
  }
}