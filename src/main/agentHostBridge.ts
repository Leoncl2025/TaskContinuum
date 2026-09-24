import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import { agentHostModelSelectionSchema, agentHostTargetSchema, agentHostTerminalIdSchema } from './agentHostProtocol'
import { logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostManager } from './agentHostManager'
import type { AgentHostConnection } from './agentHostConnection'
import { readClientIdentity } from './clientIdentity'
import { agentHostCreateRequestSchema, creationLocationSchema, creationTaskIdSchema } from './agentHostCreationProtocol'
import { localAgentHostCreateRequestSchema } from './localAgentHostCreationService'

export function registerAgentHostBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>, manager: AgentHostManager) {
  const watches = new Map<string, { window: BrowserWindow; root: string; target: AgentHostTarget; connection: AgentHostConnection; leases: Map<string, Set<string>>; close(): void }>()
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
  ipcMain.handle('agent-host:creation-workers', async (event, value: unknown, locationValue?: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const taskId = creationTaskIdSchema.parse(value)
    const location = creationLocationSchema.optional().parse(locationValue) ?? 'remote'
    await current(event, window, root)
    const result = await manager.creations.workers(root, taskId, location)
    await current(event, window, root)
    return result
  })
  for (const [channel, method] of [['local-creation-hosts', 'hosts'], ['local-creations', 'list']] as const) {
    ipcMain.handle(`agent-host:${channel}`, async (event) => {
      const window = requireWindow(event)
      const root = await currentRoot()
      await current(event, window, root)
      const result = await manager.localCreations[method](root, () => current(event, window, root))
      await current(event, window, root)
      return result
    })
  }
  ipcMain.handle('agent-host:create-local', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const request = localAgentHostCreateRequestSchema.parse(value)
    await current(event, window, root)
    const result = await manager.localCreations.create(root, request, () => current(event, window, root))
    await current(event, window, root)
    return result
  })
  ipcMain.handle('agent-host:local-creation-status', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const operationId = z.uuid().parse(value)
    await current(event, window, root)
    const result = await manager.localCreations.status(root, operationId, () => current(event, window, root))
    await current(event, window, root)
    return result
  })
  ipcMain.handle('agent-host:creations', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const taskId = creationTaskIdSchema.parse(value)
    const result = await manager.creations.list(root, taskId)
    await current(event, window, root)
    return result
  })
  ipcMain.handle('agent-host:create', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const request = agentHostCreateRequestSchema.parse(value)
    await current(event, window, root)
    const result = await manager.creations.create(root, request, () => current(event, window, root))
    await current(event, window, root)
    return result
  })
  for (const [channel, bind] of [['creation-status', false], ['bind-creation', true]] as const) {
    ipcMain.handle(`agent-host:${channel}`, async (event, value: unknown) => {
      const window = requireWindow(event)
      const root = await currentRoot()
      const id = z.uuid().parse(value)
      await current(event, window, root)
      const result = await (bind ? manager.creations.bind(root, id, () => current(event, window, root)) : manager.creations.status(root, id, () => current(event, window, root)))
      await current(event, window, root)
      return result
    })
  }
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
    const leases = new Map<string, Set<string>>()
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
    const close = () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      unlisten()
      watches.delete(id)
      for (const [resource, owners] of leases) owners.forEach(() => connection.releaseTerminal(resource))
      leases.clear()
    }
    watches.set(id, { window, root, target, connection, leases, close })
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
  ipcMain.handle('agent-host:terminal', async (event, watchValue: unknown, resourceValue: unknown, leaseValue: unknown, retryValue?: unknown) => {
    const window = requireWindow(event)
    const id = z.uuid().parse(watchValue)
    const resource = agentHostTerminalIdSchema.parse(resourceValue)
    const lease = z.uuid().parse(leaseValue)
    const retry = z.boolean().optional().parse(retryValue) ?? false
    const watch = watches.get(id)
    if (!watch || watch.window !== window) throw new Error('This Agent Host view is no longer active.')
    const verify = async () => {
      try { await current(event, window, watch.root, watch.target) }
      catch (error) { watch.close(); throw error }
    }
    await verify()
    await watch.connection.open()
    await verify()
    if (watches.get(id) !== watch) throw new Error('This Agent Host view is no longer active.')
    let owners = watch.leases.get(resource)
    if (!owners?.has(lease)) {
      if (watch.leases.size >= 32 && !owners || [...watch.leases.values()].reduce((total, group) => total + group.size, 0) >= 64) throw new Error('Too many terminal outputs are open in this view.')
      watch.connection.retainTerminal(resource)
      owners ??= new Set<string>()
      owners.add(lease)
      watch.leases.set(resource, owners)
    }
    let failure: unknown
    try { await watch.connection.terminal(resource, retry) }
    catch (error) { failure = error }
    await verify()
    if (watches.get(id) !== watch) throw new Error('This Agent Host view is no longer active.')
    if (failure) throw new Error('The owner Host could not load this terminal output. Retry manually.')
  })
  ipcMain.handle('agent-host:release-terminal', (event, watchValue: unknown, resourceValue: unknown, leaseValue: unknown) => {
    const window = requireWindow(event)
    const watch = watches.get(z.uuid().parse(watchValue))
    const resource = agentHostTerminalIdSchema.parse(resourceValue)
    const lease = z.uuid().parse(leaseValue)
    if (watch && watch.window !== window) throw new Error('This Agent Host view belongs to another window.')
    const owners = watch?.leases.get(resource)
    if (watch && owners?.delete(lease)) {
      watch.connection.releaseTerminal(resource)
      if (!owners.size) watch.leases.delete(resource)
    }
  })
  ipcMain.handle('agent-host:models', async (event, value: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    const started = performance.now()
    let step: 'authorization' | 'root' = 'authorization'
    logAgentHostDiagnostic('ipc.models', { target, status: 'begin', step })
    try {
      const connection = await manager.connection(root, target)
      await current(event, window, root, target)
      step = 'root'
      const models = await connection.models()
      step = 'authorization'
      await current(event, window, root, target)
      logAgentHostDiagnostic('ipc.models', { target, status: 'ok', step, elapsedMs: performance.now() - started, count: models.length })
      return models
    } catch (error) {
      logAgentHostDiagnostic('ipc.models', { target, status: 'error', step, elapsedMs: performance.now() - started, error })
      throw error
    }
  })
  ipcMain.handle('agent-host:send', async (event, value: unknown, id: unknown, text: unknown, images: unknown, model: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    const command = chatSubmissionSchema.parse({ id, text, ...(images === undefined ? {} : { images }) })
    const selection = agentHostModelSelectionSchema.optional().parse(model)
    const connection = await manager.connection(root, target)
    await current(event, window, root, target)
    return connection.send(command.id, command.text, command.images, () => current(event, window, root, target), await readClientIdentity(app.getPath('userData')), selection)
  })
  ipcMain.handle('agent-host:resolve-delivery', async (event, value: unknown, turnValue: unknown, actionValue: unknown, acknowledged: unknown) => {
    const window = requireWindow(event)
    const root = await currentRoot()
    const target = agentHostTargetSchema.parse(value)
    const turnId = z.uuid().parse(turnValue)
    const action = z.enum(['check', 'abandon']).parse(actionValue)
    if (action === 'abandon') z.literal(true).parse(acknowledged)
    else z.undefined().parse(acknowledged)
    const connection = await manager.connection(root, target)
    await current(event, window, root, target)
    const result = await connection.resolveDelivery(turnId, action, () => current(event, window, root, target))
    await current(event, window, root, target)
    return result
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