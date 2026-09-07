import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import type { SendMessageRequest, SessionOptions } from '../shared/sessions'
import { checkedString, CopilotService } from './copilotService'
import { LocalSessionHost } from './localSessionHost'
import { VSCodeSessionStore } from './vscodeSessions'

export function registerCopilotBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentWindow: () => BrowserWindow | undefined) {
  const service = new CopilotService()
  const host = new LocalSessionHost(service, new VSCodeSessionStore(), app.getPath('userData'))
  const directories = new Set([resolve(service.getStatus().workingDirectory)])
  service.onEvent((event) => {
    const window = currentWindow()
    if (window && !window.isDestroyed()) window.webContents.send('copilot:event', event)
  })

  function options(value: unknown): SessionOptions {
    const input = value as SessionOptions | undefined
    const workingDirectory = checkedString(input?.workingDirectory, 'working directory', 4096)
    if (!directories.has(resolve(workingDirectory))) throw new Error('Choose the working directory using the folder picker first.')
    return { workingDirectory, model: input?.model }
  }

  function handle(channel: string, action: (window: BrowserWindow, ...args: unknown[]) => unknown): void {
    ipcMain.handle(`copilot:${channel}`, (event, ...args: unknown[]) => action(requireWindow(event), ...args))
  }

  handle('status', () => service.getStatus())
  handle('connect', () => service.connect())
  handle('disconnect', async () => { host.cancelAll(); await service.disconnect() })
  handle('sessions', () => host.listSessions())
  handle('models', () => service.listModels())
  handle('choose-directory', async (window) => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose Copilot working directory', properties: ['openDirectory'], defaultPath: service.getStatus().workingDirectory })
    const directory = result.canceled ? null : result.filePaths[0] ?? null
    if (directory) directories.add(resolve(directory))
    return directory
  })
  handle('create', (_window, value) => service.createSession(options(value)))
  handle('resume', (_window, id) => host.resumeSession(id))
  handle('preview-import', async (_window, id) => {
    const preview = await host.previewImport(id)
    if (preview.session.workingDirectory) directories.add(resolve(preview.session.workingDirectory))
    return preview
  })
  handle('import', (_window, token, value) => host.importSession(token, options(value)))
  handle('send', (_window, request) => host.send(request as SendMessageRequest))
  handle('abort', (_window, id) => host.abort(id))
  handle('respond', (_window, id, response) => service.respond(id, response))

  return {
    requireDirectory: (value: unknown) => options({ workingDirectory: value }).workingDirectory,
    allowDirectory: (root: string) => { directories.add(resolve(root)) },
    cancelAll: () => host.cancelAll(),
    disconnect: async () => { host.cancelAll(); await service.disconnect() },
  }
}