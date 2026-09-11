import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostManager } from './agentHostManager'
import { readClientIdentity } from './clientIdentity'

export function registerAgentHostBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>, manager: AgentHostManager) {
  const watches = new Map<string, { window: BrowserWindow; close(): void }>()
  let consenting: Promise<void> | undefined
  async function current(event: IpcMainInvokeEvent, window: BrowserWindow, root: string, target?: AgentHostTarget): Promise<void> {
    if (window.isDestroyed() || window.webContents.isDestroyed() || requireWindow(event) !== window || await currentRoot() !== root) throw new Error('The workspace or window changed. No message was sent.')
    if (target) await manager.authorize(root, target)
    if (window.isDestroyed() || requireWindow(event) !== window || await currentRoot() !== root) throw new Error('The workspace changed while verifying the session.')
  }
  ipcMain.handle('agent-host:list', async (event) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    if (!await manager.hasConsent(root)) {
      consenting ??= (async () => {
        const choice = await dialog.showMessageBox(window, { type: 'warning', message: 'Allow Agent Host access for this task workspace?', detail: `Workspace: ${root}\nList and link existing local Host sessions without a Companion extension. Linked sessions follow your existing paired-device workspace sharing policy. This does not migrate Local chats, create sessions, or change native tool approvals.`, buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0 })
        await current(event, window, root)
        if (choice.response === 1) await manager.allow(root)
      })().finally(() => { consenting = undefined })
      await consenting
    }
    const result = await manager.list(root)
    await current(event, window, root)
    return result
  })
  ipcMain.handle('agent-host:watch', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    if (watches.size >= 16) throw new Error('Too many active Agent Host views.')
    const connection = await manager.connection(root, target)
    await current(event, window, root, target)
    const id = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let refreshing = false
    const publish = async () => {
      timer = undefined
      if (stopped || refreshing) return
      refreshing = true
      try {
        await current(event, window, root, target)
        if (!stopped) window.webContents.send('agent-host:view', { id, view: connection.view })
      } catch { close() }
      finally { refreshing = false }
    }
    const schedule = () => { if (!timer && !stopped) timer = setTimeout(() => { void publish() }, 25) }
    const unlisten = connection.listen(schedule)
    const close = () => { stopped = true; clearTimeout(timer); unlisten(); watches.delete(id) }
    watches.set(id, { window, close })
    schedule()
    void connection.open().catch(schedule)
    return id
  })
  ipcMain.handle('agent-host:unwatch', (event, value: unknown) => {
    const window = requireWindow(event)
    const watch = watches.get(z.uuid().parse(value))
    if (watch && watch.window !== window) throw new Error('This view belongs to another window.')
    watch?.close()
  })
  ipcMain.handle('agent-host:send', async (event, value: unknown, id: unknown, text: unknown, images: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    const command = chatSubmissionSchema.parse({ id, text, ...(images === undefined ? {} : { images }) })
    const connection = await manager.connection(root, target)
    await current(event, window, root, target)
    return connection.send(command.id, command.text, command.images, () => current(event, window, root, target), await readClientIdentity(app.getPath('userData')))
  })
  ipcMain.handle('agent-host:cancel', async (event, value: unknown, id: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    const turnId = z.string().min(1).max(200).parse(id)
    const connection = await manager.connection(root, target)
    return connection.cancel(turnId, () => current(event, window, root, target))
  })
  return { close: () => { for (const watch of watches.values()) watch.close() } }
}