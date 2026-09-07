import { ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { VSCodeSessionStore } from './vscodeSessions'
import { vscodeIdentitySchema } from './vscodeChatCompanion'
import { connectOriginalVSCode, openOriginalVSCode, readOriginalVSCode, sendOriginalVSCode } from './vscodeChatClient'
import { z } from 'zod'

export function registerVSCodeChatBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentWindow: () => BrowserWindow | undefined) {
  const store = new VSCodeSessionStore()
  let watcher: FSWatcher | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  const close = () => { generation++; watcher?.close(); watcher = undefined; clearTimeout(timer); clearInterval(refresh) }
  ipcMain.handle('vscode-chat:read', async (event, value: unknown) => {
    requireWindow(event)
    return readOriginalVSCode(store, vscodeIdentitySchema.parse(value))
  })
  ipcMain.handle('vscode-chat:connect', async (event, value: unknown) => {
    requireWindow(event)
    await connectOriginalVSCode(store, vscodeIdentitySchema.parse(value), (uri) => shell.openExternal(uri))
  })
  ipcMain.handle('vscode-chat:open', async (event, value: unknown) => {
    requireWindow(event)
    await openOriginalVSCode(store, vscodeIdentitySchema.parse(value))
  })
  ipcMain.handle('vscode-chat:send', async (event, value: unknown, commandId: unknown, text: unknown) => {
    requireWindow(event)
    return sendOriginalVSCode(store, vscodeIdentitySchema.parse(value), z.uuid().parse(commandId), z.string().trim().min(1).max(4000).parse(text))
  })
  ipcMain.handle('vscode-chat:watch', async (event, value: unknown) => {
    requireWindow(event)
    close()
    if (value === null) return
    const identity = vscodeIdentitySchema.parse(value)
    const current = generation
    const original = await store.locateOriginal(identity)
    if (current !== generation) return
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const window = currentWindow()
        if (current === generation && window && !window.isDestroyed()) window.webContents.send('vscode-chat:changed', identity)
      }, 150)
    }
    watcher = watch(dirname(original.file), { persistent: false }, (_type, filename) => {
      if (!filename || filename.toString() === basename(original.file)) changed()
    })
    watcher.on('error', changed)
    refresh = setInterval(changed, 2000)
    refresh.unref()
  })
  return { close }
}