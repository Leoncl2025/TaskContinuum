import { ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { UpdateBridge } from '../shared/updates'
import type { UpdateRestartGuard } from './updateRestartGuard'

type UpdateActions = Pick<UpdateBridge, 'getState' | 'check' | 'setAutoCheck' | 'openRelease' | 'download' | 'install'>

export function registerUpdateBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, updates: UpdateActions | Promise<UpdateActions>, restart: UpdateRestartGuard): void {
  const noArguments = z.tuple([])
  for (const action of ['getState', 'check', 'openRelease', 'download', 'install'] as const) {
    ipcMain.handle(`updates:${action}`, (event, ...values: unknown[]) => {
      requireWindow(event)
      noArguments.parse(values)
      return Promise.resolve(updates).then(async (service) => service[action]())
    })
  }
  ipcMain.handle('updates:setAutoCheck', (event, ...values: unknown[]) => {
    requireWindow(event)
    const [enabled] = z.tuple([z.boolean()]).parse(values)
    return Promise.resolve(updates).then((service) => service.setAutoCheck(enabled))
  })
  ipcMain.handle('updates:respondToInstall', (event, ...values: unknown[]) => {
    requireWindow(event)
    const [requestId, blockers] = z.tuple([z.uuid(), z.array(z.string().min(1).max(500)).max(32)]).parse(values)
    restart.respond(requestId, blockers)
  })
}
