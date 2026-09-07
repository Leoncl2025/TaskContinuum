import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { SharedEnrollment, SharedEvent, SharedView } from '../../shared/sharedSessions'
import { SharedJournal } from './journal'
import { actorSchema, descriptorSchema, eventSchema, permissionsSchema } from './schemas'
import { openSshTunnel } from './ssh'

export type SharedClientUpdate = { event?: SharedEvent; online?: boolean; error?: string; lastSyncedAt?: string }

export class SharedSessionClient {
  readonly journal: SharedJournal
  private online = false
  private error?: string
  private lastSyncedAt?: string
  private controller?: AbortController
  private receiving?: Promise<void>
  private connecting?: Promise<SharedView>
  private tunnel?: { port: number; close(): void }
  private port?: number
  private loaded = false
  private readonly listeners = new Set<(update: SharedClientUpdate) => void>()

  constructor(readonly enrollment: SharedEnrollment, cacheFile: string) {
    this.journal = new SharedJournal(cacheFile, enrollment.session)
    this.journal.subscribe((event) => { this.lastSyncedAt = new Date().toISOString(); this.emit({ event, lastSyncedAt: this.lastSyncedAt }) })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await this.journal.load()
    this.loaded = true
  }
  onUpdate(listener: (update: SharedClientUpdate) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(update: SharedClientUpdate): void { for (const listener of this.listeners) listener(update) }
  get view(): SharedView { return { session: this.enrollment.session, events: this.journal.snapshot(), actor: this.enrollment.actor, permissions: this.enrollment.permissions, online: this.online, error: this.error, lastSyncedAt: this.lastSyncedAt } }

  private async request(path: string, value?: unknown): Promise<Response> {
    if (!this.port) throw new Error('The session is offline. Messages remain unsent drafts.')
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, { method: value === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.enrollment.token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      const result = await response.json() as { error?: unknown }
      throw new Error(typeof result.error === 'string' ? result.error : `Session request failed (${response.status}).`)
    }
    return response
  }

  connect(): Promise<SharedView> {
    if (this.connecting) return this.connecting
    this.connecting = this.connectOnce().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connectOnce(): Promise<SharedView> {
    await this.disconnect()
    await this.load()
    const controller = new AbortController()
    this.controller = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.enrollment.endpoint.kind === 'ssh') this.tunnel = await openSshTunnel(this.enrollment.endpoint.host, this.enrollment.endpoint.remotePort)
      controller.signal.throwIfAborted()
      this.port = this.tunnel?.port ?? (this.enrollment.endpoint.kind === 'local' ? this.enrollment.endpoint.port : undefined)
      const info = z.object({ session: descriptorSchema, actor: actorSchema, permissions: permissionsSchema }).parse(await (await this.request('/session')).json())
      controller.signal.throwIfAborted()
      if (!isDeepStrictEqual(info.session, descriptorSchema.parse(this.enrollment.session)) || info.actor.id !== this.enrollment.actor.id || info.actor.machineId !== this.enrollment.actor.machineId) throw new Error('The enrolled session or participant identity does not match the Host.')
      this.enrollment.permissions = info.permissions
      timer = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`http://127.0.0.1:${this.port}/events?after=${this.journal.lastSeq}&epoch=${this.enrollment.session.owner.epoch}`, { redirect: 'error', headers: { Authorization: `Bearer ${this.enrollment.token}` }, signal: controller.signal })
      if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) { clearTimeout(timer); throw new Error('The session event stream could not be opened.') }
      let ready!: () => void
      let failed!: (error: Error) => void
      const replayed = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
      this.receiving = (async () => {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error('The owner machine disconnected.')
            clearTimeout(timer)
            timer = setTimeout(() => controller.abort(), 20000)
            pending += decoder.decode(chunk.value, { stream: true })
            let boundary = pending.indexOf('\n\n')
            while (boundary >= 0) {
              if (boundary > 1024 * 1024) throw new Error('The session event frame exceeded its limit.')
              const line = pending.slice(0, boundary)
              pending = pending.slice(boundary + 2)
              if (line.startsWith('data: ')) {
                const packet = JSON.parse(line.slice(6)) as { kind?: unknown; event?: unknown; lastSeq?: unknown }
                if (packet.kind === 'event') await this.journal.accept(eventSchema.parse(packet.event))
                else if (packet.kind === 'ready') {
                  if (packet.lastSeq !== this.journal.lastSeq) throw new Error('The replay prefix is incomplete.')
                  controller.signal.throwIfAborted()
                  this.online = true
                  this.error = undefined
                  this.emit({ online: true })
                  ready()
                }
                else if (packet.kind !== 'ready' && packet.kind !== 'heartbeat') throw new Error('Unrecognized session stream packet.')
              }
              boundary = pending.indexOf('\n\n')
            }
            if (pending.length > 1024 * 1024) throw new Error('The session event frame exceeded its limit.')
          }
          throw new Error('The live session connection was cancelled or timed out.')
        } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined) }
      })().catch((error: unknown) => {
        failed(error instanceof Error ? error : new Error('The event replay failed.'))
        if (this.controller === controller) {
          this.online = false
          this.error = error instanceof Error ? error.message : 'The session disconnected.'
          this.emit({ online: false, error: this.error })
          this.tunnel?.close()
          this.tunnel = undefined
          this.port = undefined
        }
      })
      await replayed
    } catch (error) {
      clearTimeout(timer)
      controller.abort()
      this.online = false
      this.error = error instanceof Error ? error.message : 'The owner machine is unavailable.'
      this.tunnel?.close()
      this.tunnel = undefined
      this.port = undefined
      this.emit({ online: false, error: this.error })
    }
    return this.view
  }

  async command(id: string, text: string): Promise<void> {
    if (!this.online) throw new Error('The session is offline. The message was not sent.')
    await this.request('/commands', { id, text })
  }
  async respond(id: string, answer: boolean | string): Promise<void> { if (!this.online) throw new Error('The session is offline.'); await this.request('/responses', { id, answer }) }
  async stop(commandId: string): Promise<void> { if (!this.online) throw new Error('The session is offline.'); await this.request('/stop', { commandId }) }
  async checkpoint(): Promise<unknown> { if (!this.online) throw new Error('The owner must be online to export a new checkpoint.'); return (await this.request('/checkpoint', {})).json() }
  async enroll(value: unknown): Promise<unknown> { return (await this.request('/enroll', value)).json() }
  async stopHost(): Promise<void> { await this.request('/shutdown', {}) }
  async disconnect(): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    controller?.abort()
    await this.receiving
    this.receiving = undefined
    this.tunnel?.close()
    this.tunnel = undefined
    this.port = undefined
    this.online = false
    this.emit({ online: false })
  }
}