import { randomUUID } from 'node:crypto'
import type { DesktopOperations } from './desktopOperations'

interface RestartDependencies {
  operations: DesktopOperations
  requestRenderer(requestId: string): void
  resumeRenderer(restartRequired: boolean): void
  rendererAvailable(): boolean
  hasActiveWork(): boolean
  cleanup(): Promise<void>
  timeoutMs?: number
}

export class UpdateRestartGuard {
  private active = false
  private aborted = false
  private pending?: { id: string; resolve(): void; reject(error: Error): void }

  constructor(private readonly dependencies: RestartDependencies) {}

  get preparing(): boolean { return this.active }

  respond(requestId: string, blockers: string[]): void {
    const pending = this.pending
    if (!pending || requestId !== pending.id) throw new Error('This update restart request is no longer current.')
    this.pending = undefined
    if (blockers.length) pending.reject(new Error(blockers.join(' ')))
    else pending.resolve()
  }

  abort(): void {
    this.aborted = true
    this.pending?.reject(new Error('The original window closed before the update restart was ready. Nothing was installed.'))
    this.pending = undefined
  }

  async install(installer: () => void | Promise<void>): Promise<void> {
    const { operations } = this.dependencies
    operations.lock()
    this.active = true
    this.aborted = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cleanupStarted = false
    try {
      this.assertReady()
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID()
        this.pending = { id, resolve, reject }
        timer = setTimeout(() => reject(new Error('The window did not confirm a safe restart. Retry after the application is responsive.')), this.dependencies.timeoutMs ?? 10_000)
        this.dependencies.requestRenderer(id)
      })
      clearTimeout(timer)
      this.pending = undefined
      this.assertReady()
      cleanupStarted = true
      await this.dependencies.cleanup()
      this.assertReady()
      await installer()
      // Keep operations locked until the installer exits this process.
    } catch (error) {
      this.active = false
      if (cleanupStarted) operations.requireRestart()
      else operations.unlock()
      this.dependencies.resumeRenderer(cleanupStarted)
      if (cleanupStarted) throw new Error(`${error instanceof Error ? error.message : 'The update could not complete.'} Application services have stopped. Close and reopen Task Continuum before continuing.`, { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      this.pending = undefined
    }
  }

  private assertReady(): void {
    if (this.aborted || !this.dependencies.rendererAvailable()) throw new Error('The original application window is unavailable. Restart the application before updating.')
    if (this.dependencies.hasActiveWork()) throw new Error('Wait for Agent Host turns, session creation, file transfers and pending or unknown message delivery before updating.')
  }
}
