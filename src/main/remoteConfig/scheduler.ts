export const REMOTE_SYNC_INTERVAL_MS = 15000

export interface RemoteSyncStatus {
  state: 'idle' | 'running' | 'error' | 'stopped'
  reasons: readonly string[]
  error?: string
}

export interface RemoteSyncSchedulerOptions {
  cycle(context: { signal: AbortSignal; reasons: readonly string[] }): Promise<void>
  onStatus?(status: RemoteSyncStatus): void
}

export class RemoteSyncScheduler {
  private timer?: ReturnType<typeof setInterval>
  private controller?: AbortController
  private work?: Promise<void>
  private readonly due = new Set<string>()
  private enabled = false
  private stopping?: Promise<void>

  constructor(private readonly options: RemoteSyncSchedulerOptions) {}

  start(): void {
    if (this.enabled || this.stopping) return
    this.enabled = true
    this.timer = setInterval(() => this.request('interval'), REMOTE_SYNC_INTERVAL_MS)
    this.timer.unref?.()
    this.request('start')
  }

  request(reason = 'change'): void {
    if (!this.enabled) return
    if (this.due.size < 31) this.due.add(reason.slice(0, 128))
    else this.due.add('coalesced')
    if (this.work) return
    // Install the promise before invoking callbacks, which may themselves request work.
    this.work = Promise.resolve().then(() => this.run()).finally(() => {
      this.work = undefined
      if (this.enabled && this.due.size) this.request('follow-up')
    })
  }

  private emit(status: RemoteSyncStatus): void {
    // Observers must not break serialization or create unhandled timer rejections.
    try { this.options.onStatus?.(status) } catch { /* An observer is not the sync worker. */ }
  }

  private async run(): Promise<void> {
    if (!this.enabled) return
    const reasons = [...this.due]
    this.due.clear()
    const controller = new AbortController()
    this.controller = controller
    this.emit({ state: 'running', reasons })
    try {
      await this.options.cycle({ signal: controller.signal, reasons })
      if (this.enabled) this.emit({ state: 'idle', reasons })
    } catch (error) {
      if (this.enabled) {
        this.emit({
          state: 'error',
          reasons,
          error: error instanceof Error ? error.message : 'Remote synchronization failed.',
        })
        // An error is not a new request. A tick/edit already received still gets one follow-up.
      }
    } finally {
      if (this.controller === controller) this.controller = undefined
    }
  }

  async whenIdle(): Promise<void> {
    while (this.work) await this.work
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.enabled = false
    clearInterval(this.timer)
    this.timer = undefined
    this.due.clear()
    this.controller?.abort()
    this.stopping = this.whenIdle().then(() => {
      this.emit({ state: 'stopped', reasons: [] })
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }
}
