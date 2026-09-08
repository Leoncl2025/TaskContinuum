import { ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { VSCodeSessionStore } from './vscodeSessions'
import { vscodeIdentitySchema } from './vscodeChatCompanion'
import { connectOriginalVSCode, openOriginalVSCode, readOriginalVSCode, sendOriginalVSCode } from './vscodeChatClient'
import { z } from 'zod'
import type { RemoteVSCodeManager } from './vscodeRemoteClient'
import { vscodeTargetSchema } from './vscodeRemoteProtocol'

export function registerVSCodeChatBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentWindow: () => BrowserWindow | undefined, remote: RemoteVSCodeManager, currentRoot: () => Promise<string>) {
  const store = new VSCodeSessionStore()
  let watcher: FSWatcher | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  const close = () => { generation++; watcher?.close(); watcher = undefined; clearTimeout(timer); clearInterval(refresh) }
  ipcMain.handle('vscode-chat:read', async (event, value: unknown) => {
    requireWindow(event)
    const target = vscodeTargetSchema.parse(value)
    return target.remoteMachineName ? remote.read(await currentRoot(), target) : readOriginalVSCode(store, vscodeIdentitySchema.parse(target))
  })
  ipcMain.handle('vscode-chat:connect', async (event, value: unknown) => {
    requireWindow(event)
    const target = vscodeTargetSchema.parse(value)
    if (target.remoteMachineName) await remote.connectTarget(await currentRoot(), target)
    else await connectOriginalVSCode(store, vscodeIdentitySchema.parse(target), (uri) => shell.openExternal(uri))
  })
  ipcMain.handle('vscode-chat:open', async (event, value: unknown) => {
    requireWindow(event)
    if (vscodeTargetSchema.parse(value).remoteMachineName) throw new Error('Open the original conversation on its execution machine. Remote access does not change VS Code window layouts.')
    await openOriginalVSCode(store, vscodeIdentitySchema.parse(value))
  })
  ipcMain.handle('vscode-chat:send', async (event, value: unknown, commandId: unknown, text: unknown) => {
    requireWindow(event)
    const target = vscodeTargetSchema.parse(value)
    const id = z.uuid().parse(commandId)
    const message = z.string().trim().min(1).max(4000).parse(text)
    return target.remoteMachineName ? remote.send(await currentRoot(), target, id, message) : sendOriginalVSCode(store, vscodeIdentitySchema.parse(target), id, message)
  })
  ipcMain.handle('vscode-chat:watch', async (event, value: unknown) => {
    requireWindow(event)
    close()
    if (value === null) return
    const identity = vscodeTargetSchema.parse(value)
    const current = generation
    const original = identity.remoteMachineName ? undefined : await store.locateOriginal(identity)
    if (identity.remoteMachineName) await currentRoot()
    if (current !== generation) return
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const window = currentWindow()
        if (current === generation && window && !window.isDestroyed()) window.webContents.send('vscode-chat:changed', identity)
      }, 150)
    }
    if (original) {
      watcher = watch(dirname(original.file), { persistent: false }, (_type, filename) => {
        if (!filename || filename.toString() === basename(original.file)) changed()
      })
      watcher.on('error', changed)
    }
    refresh = setInterval(changed, 2000)
    refresh.unref()
  })
  return { close }
}