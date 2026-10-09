import type { IpcMain, IpcMainInvokeEvent } from 'electron'

export class DesktopOperations {
  private active = 0
  private installing = false
  private restartRequired = false

  private assertAvailable(): void {
    if (this.restartRequired) throw new Error('Application services have stopped. Close and reopen Task Continuum before continuing.')
    if (this.installing) throw new Error('An application update is preparing to restart. Wait for it to finish before starting another operation.')
  }

  run(action: () => unknown): unknown {
    this.assertAvailable()
    this.active++
    let asynchronous = false
    try {
      const result = action()
      if (result instanceof Promise) {
        asynchronous = true
        return result.finally(() => { this.active-- })
      }
      return result
    } finally {
      if (!asynchronous) this.active--
    }
  }

  async runAsync<T>(action: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    this.active++
    try { return await action() } finally { this.active-- }
  }

  lock(): void {
    if (this.restartRequired) this.assertAvailable()
    if (this.installing) throw new Error('An application update is already preparing to restart.')
    if (this.active) throw new Error('Wait for current workspace, device and Agent Host operations to finish before updating.')
    this.installing = true
  }

  unlock(): void { this.installing = false }
  requireRestart(): void { this.restartRequired = true }
}

export const desktopOperations = new DesktopOperations()

export function handleDesktopOperation(ipc: Pick<IpcMain, 'handle'>, channel: string, action: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown): void {
  ipc.handle(channel, (event, ...values: unknown[]) => desktopOperations.run(() => action(event, ...values)))
}
