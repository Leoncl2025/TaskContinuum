import { dialog, ipcMain, shell } from 'electron'
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
  async function targetFor(value: unknown) {
    const target = vscodeTargetSchema.parse(value)
    const root = await currentRoot().catch(() => undefined)
    return root ? remote.resolveTarget(root, target) : target
  }
  let watcher: FSWatcher | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let refresh: ReturnType<typeof setInterval> | undefined
  const close = () => { generation++; watcher?.close(); watcher = undefined; clearTimeout(timer); clearInterval(refresh) }
  ipcMain.handle('vscode-chat:read', async (event, value: unknown) => {
    requireWindow(event)
    const target = await targetFor(value)
    return target.remoteMachineName ? remote.read(await currentRoot(), target) : readOriginalVSCode(store, vscodeIdentitySchema.parse(target))
  })
  ipcMain.handle('vscode-chat:connect', async (event, value: unknown) => {
    requireWindow(event)
    const target = await targetFor(value)
    if (target.remoteMachineName) await remote.connectTarget(await currentRoot(), target)
    else await connectOriginalVSCode(store, vscodeIdentitySchema.parse(target), (uri) => shell.openExternal(uri))
  })
  ipcMain.handle('vscode-chat:open', async (event, value: unknown) => {
    const window = requireWindow(event)
    const target = await targetFor(value)
    if (target.remoteMachineName) {
      const root = await currentRoot()
      const consent = await dialog.showMessageBox(window, { type: 'question', title: 'Open original session on owner', message: `Open this original session in VS Code on ${target.remoteMachineName}?`, detail: `Session: ${target.nativeSessionId}\nWorkspace: ${target.workspaceStorageId}\n\nThis changes the visible chat on the execution machine. No message is sent or retried, no new session is created, and tool approvals remain there.`, buttons: ['Cancel', 'Open on owner'], defaultId: 0, cancelId: 0 })
      if (consent.response !== 1) return
      if (await currentRoot() !== root || JSON.stringify(await targetFor(value)) !== JSON.stringify(target)) throw new Error('The task workspace or owner changed. No session was opened.')
      await remote.open(root, target)
      return
    }
    await openOriginalVSCode(store, vscodeIdentitySchema.parse(target))
  })
  ipcMain.handle('vscode-chat:send', async (event, value: unknown, commandId: unknown, text: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot().catch(() => undefined)
    const target = await targetFor(value)
    const id = z.uuid().parse(commandId)
    const message = z.string().trim().min(1).max(4000).parse(text)
    const assertCurrent = async () => {
      if (window.isDestroyed() || window.webContents.isDestroyed() || await currentRoot().catch(() => undefined) !== root
        || JSON.stringify(await targetFor(value)) !== JSON.stringify(target)) throw new Error('The task workspace, owner, or window changed while preparing. No message was sent.')
    }
    await assertCurrent()
    if (target.remoteMachineName) {
      if (!root) throw new Error('Open the linked task workspace before sending. No message was sent.')
      await remote.connectTarget(root, target)
      await assertCurrent()
      return remote.send(root, target, id, message)
    }
    return sendOriginalVSCode(store, vscodeIdentitySchema.parse(target), id, message, { openExternal: (uri) => shell.openExternal(uri), assertCurrent })
  })
  ipcMain.handle('vscode-chat:watch', async (event, value: unknown) => {
    requireWindow(event)
    close()
    if (value === null) return
    const requested = vscodeTargetSchema.parse(value)
    const identity = await targetFor(requested)
    const current = generation
    const original = identity.remoteMachineName ? undefined : await store.locateOriginal(identity)
    if (identity.remoteMachineName) await currentRoot()
    if (current !== generation) return
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const window = currentWindow()
        if (current === generation && window && !window.isDestroyed()) window.webContents.send('vscode-chat:changed', requested)
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