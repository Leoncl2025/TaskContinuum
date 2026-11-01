import type { UpdateState } from '../../shared/updates'
import type { DistributionCapability } from './distribution'
import type { UpdatePreferences } from './preferences'
import { fetchLatestRelease, isNewer, RELEASES_URL, releaseUrl, stableVersion } from './release'
import type { ReleaseCandidate } from './release'
import type { UpdateInstaller } from './updater'

export interface UpdateClock {
  now(): Date
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(timer: unknown): void
}

const realClock: UpdateClock = {
  now: () => new Date(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export interface UpdateServiceOptions {
  currentVersion: string
  capability: DistributionCapability
  preferences: UpdatePreferences
  installer?: UpdateInstaller
  fetchRelease?: (signal: AbortSignal) => Promise<ReleaseCandidate>
  openExternal: (url: string) => Promise<unknown>
  prepareInstall: (installer: () => Promise<void>) => Promise<void>
  clock?: UpdateClock
  startupDelayMs?: number
  intervalMs?: number
}

export class UpdateService {
  private value: UpdateState
  private selected?: ReleaseCandidate
  private downloaded = false
  private closed = false
  private started = false
  private timer?: unknown
  private busy?: 'checking' | 'downloading' | 'installing'
  private checkPromise?: Promise<UpdateState>
  private installerFailure = 0
  private preferenceQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private readonly abort = new AbortController()
  private readonly clock: UpdateClock
  private readonly removeErrorListener?: () => void

  private constructor(private readonly options: UpdateServiceOptions) {
    this.clock = options.clock ?? realClock
    const capability = options.capability
    this.value = {
      phase: 'idle', currentVersion: options.currentVersion, distribution: capability.distribution,
      canInstall: capability.canInstall && !!options.installer, autoCheck: false, reason: capability.reason,
    }
    this.removeErrorListener = options.installer?.onError?.(error => {
      if (!this.closed) {
        this.installerFailure++
        this.downloaded = false
        this.patch({ phase: 'error', error: error.message, progress: undefined })
      }
    })
  }

  static async create(options: UpdateServiceOptions): Promise<UpdateService> {
    const service = new UpdateService(options)
    try {
      stableVersion(options.currentVersion)
      service.value.autoCheck = await options.preferences.load()
    } catch (error) {
      service.value.phase = 'error'
      service.value.error = `Update configuration could not be loaded: ${message(error)}`
      service.value.autoCheck = false
    }
    return service
  }

  getState(): Promise<UpdateState> { return Promise.resolve(this.state()) }
  state(): UpdateState { return { ...this.value, release: this.value.release ? { ...this.value.release } : undefined } }

  listen(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private patch(value: Partial<UpdateState>): void {
    if (this.closed) return
    this.value = { ...this.value, ...value }
    for (const listener of this.listeners) {
      try { listener(this.state()) } catch (error) { console.error('Update state notification failed:', error) }
    }
  }

  check(): Promise<UpdateState> {
    if (this.closed) return Promise.reject(new Error('Update service is closed.'))
    if (this.checkPromise) return this.checkPromise
    if (this.busy || this.downloaded || this.value.phase === 'installing') return this.getState()
    this.busy = 'checking'
    this.selected = undefined
    this.patch({
      phase: 'checking', release: undefined, error: undefined, progress: undefined,
      canInstall: this.options.capability.canInstall && !!this.options.installer, reason: this.options.capability.reason,
    })
    this.checkPromise = (async () => {
      let downloadSelected = false
      try {
        const release = await (this.options.fetchRelease ?? fetchLatestRelease)(this.abort.signal)
        if (this.closed) return this.state()
        // Even injected/network implementations cannot authorize noncanonical URLs.
        if (release.url !== releaseUrl(release.tag)) throw new Error('Invalid release URL.')
        if (isNewer(release.version, this.value.currentVersion)) {
          this.selected = { ...release }
          const { version, name, notes, url } = release
          this.patch({
            phase: 'available', release: { version, name, notes, url }, checkedAt: this.clock.now().toISOString(),
            canInstall: this.value.canInstall && release.hasInstaller,
            reason: !release.hasInstaller ? 'This release has no full installer and update metadata. Update manually.' : this.value.reason,
          })
          downloadSelected = this.value.canInstall && this.value.autoCheck
        } else {
          this.patch({ phase: 'up-to-date', release: undefined, checkedAt: this.clock.now().toISOString() })
        }
      } catch (error) {
        this.patch({ phase: 'error', error: message(error), checkedAt: this.clock.now().toISOString() })
      } finally {
        this.busy = undefined
        this.checkPromise = undefined
      }
      if (downloadSelected && !this.closed) {
        await this.download().catch((error: unknown) => console.error('Automatic update download failed:', error))
      }
      return this.state()
    })()
    return this.checkPromise
  }

  setAutoCheck(enabled: boolean): Promise<UpdateState> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Automatic checking must be a boolean.'))
    const action = this.preferenceQueue.then(async () => {
      if (this.closed) throw new Error('Update service is closed.')
      if (this.busy === 'installing') throw new Error('Wait until update installation finishes before changing preferences.')
      try {
        await this.options.preferences.save(enabled)
        this.patch({ autoCheck: enabled, error: undefined })
        this.cancelTimer()
        this.schedule(this.options.startupDelayMs ?? 30_000)
      } catch (error) {
        this.patch({ error: `Update preferences could not be saved: ${message(error)}` })
        throw error
      }
    })
    this.preferenceQueue = action.catch(() => {})
    return action.then(() => this.state())
  }

  async openRelease(): Promise<void> {
    if (this.closed) throw new Error('Update service is closed.')
    await this.options.openExternal(this.selected ? releaseUrl(this.selected.tag) : RELEASES_URL)
  }

  flushPreferences(): Promise<void> { return this.preferenceQueue }

  async download(): Promise<void> {
    if (this.closed || this.busy || this.downloaded) throw new Error('An update operation is already running or the service is closed.')
    const selected = this.selected
    const installer = this.options.installer
    if (!this.value.canInstall || !installer) throw new Error(this.value.reason ?? 'This installation requires manual updates.')
    if (!selected?.hasInstaller) throw new Error('The selected release does not contain a full installer and update metadata. Open the release to update manually.')
    this.busy = 'downloading'
    this.downloaded = false
    const failure = this.installerFailure
    this.patch({ phase: 'downloading', progress: 0, error: undefined })
    try {
      await installer.download({ ...selected }, percent => {
        if (this.busy === 'downloading' && Number.isFinite(percent)) {
          this.patch({ progress: Math.max(this.value.progress ?? 0, Math.min(100, Math.max(0, percent))) })
        }
      })
      if (this.closed) return
      if (failure !== this.installerFailure) throw new Error(this.value.error ?? 'Installer download failed.')
      this.downloaded = true
      this.patch({ phase: 'downloaded', progress: 100, error: undefined })
    } catch (error) {
      this.downloaded = false
      this.patch({ phase: 'error', progress: undefined, error: message(error) })
      throw error
    } finally {
      this.busy = undefined
    }
  }

  async install(): Promise<void> {
    if (this.closed || this.busy || !this.downloaded || !this.options.installer) throw new Error('No verified update is ready to install.')
    this.busy = 'installing'
    this.patch({ phase: 'installing', error: undefined })
    let invoked = false
    try {
      await this.options.prepareInstall(async () => {
        if (invoked || this.closed || !this.downloaded) throw new Error('The update installer is no longer available.')
        invoked = true
        this.downloaded = false
        await this.options.installer!.install()
      })
      if (!invoked) throw new Error('Update installation was not approved.')
    } catch (error) {
      this.patch({ phase: !invoked && this.downloaded ? 'downloaded' : 'error', error: message(error) })
      throw error
    } finally {
      this.busy = undefined
    }
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.schedule(this.options.startupDelayMs ?? 30_000)
  }

  private schedule(delay: number): void {
    if (!this.started || this.closed || !this.value.autoCheck || this.value.distribution === 'development') return
    this.cancelTimer()
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.check().catch((error: unknown) => {
        if (!this.closed) this.patch({ phase: 'error', error: message(error) })
      }).finally(() => this.schedule(this.options.intervalMs ?? 6 * 60 * 60 * 1000))
    }, delay)
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  close(): void {
    this.closed = true
    this.cancelTimer()
    this.abort.abort()
    this.removeErrorListener?.()
    this.listeners.clear()
    this.options.installer?.close()
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'The update operation failed.' }
