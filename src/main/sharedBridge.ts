import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { SharedSessionManager } from './shared/manager'
import { actorSchema } from './shared/schemas'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import type { SharedPermission } from '../shared/sharedSessions'

export function registerSharedBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentWindow: () => BrowserWindow | undefined, currentRoot: () => Promise<string>, requireDirectory: (value: unknown) => string) {
  const manager = new SharedSessionManager(app.getPath('userData'), join(__dirname, 'shared-host.cjs'))
  manager.onUpdate((sessionId, update) => {
    const window = currentWindow()
    if (window && !window.isDestroyed()) window.webContents.send('shared:update', { sessionId, ...update })
  })
  function handle(channel: string, action: (window: BrowserWindow, ...args: unknown[]) => unknown): void {
    ipcMain.handle(`shared:${channel}`, (event, ...args: unknown[]) => action(requireWindow(event), ...args))
  }
  const id = (value: unknown) => z.uuid().parse(value)
  async function sessionId(value: unknown): Promise<string> {
    const selected = id(value)
    if (!(await manager.list(await currentRoot())).some((session) => session.id === selected)) throw new Error('This shared session does not belong to the selected workspace.')
    return selected
  }
  handle('identity', () => manager.identity())
  handle('export-identity', async (window) => {
    const file = await dialog.showSaveDialog(window, { title: 'Export participant identity', defaultPath: 'taskcontinuum-identity.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (file.canceled || !file.filePath) return false
    await writeJsonAtomic(file.filePath, await manager.identity())
    return true
  })
  handle('list', async () => manager.list(await currentRoot()))
  handle('publish', async (_window, value) => {
    const options = z.object({ taskId: z.string(), mode: z.enum(['live', 'checkpoint']), workingDirectory: z.string(), model: z.string().optional() }).strict().parse(value)
    return manager.publish(await currentRoot(), { ...options, workingDirectory: requireDirectory(options.workingDirectory) })
  })
  handle('join', async (window) => {
    const root = await currentRoot()
    const file = await dialog.showOpenDialog(window, { title: 'Open private shared-session invitation', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (file.canceled || !file.filePaths[0]) return null
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Join shared session', message: 'Trust this invitation and its Session Host?', detail: 'The owner can receive messages and share session contents with your enrolled identity. Only join invitations from a trusted owner.', buttons: ['Cancel', 'Join'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return null
    return manager.importEnrollment(root, file.filePaths[0])
  })
  handle('open', async (_window, value) => manager.open(await sessionId(value)))
  handle('cached', async (_window, value) => manager.cached(await sessionId(value)))
  handle('disconnect', async (_window, value) => manager.disconnect(await sessionId(value)))
  handle('send', async (_window, value, commandId, text) => manager.send(await sessionId(value), z.string().min(1).max(240).parse(commandId), z.string().min(1).max(4000).parse(text)))
  handle('stop', async (_window, value, commandId) => manager.stop(await sessionId(value), z.string().min(1).max(240).parse(commandId)))
  handle('respond', async (_window, value, interactionId, answer) => manager.respond(await sessionId(value), z.string().min(1).max(240).parse(interactionId), z.union([z.boolean(), z.string().min(1).max(8000)]).parse(answer)))
  handle('invite', async (window, value, host, role) => {
    const selected = await sessionId(value)
    const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/).parse(host)
    const permissions: Record<string, SharedPermission[]> = { reader: ['read'], contributor: ['read', 'send'], operator: ['read', 'send', 'approve', 'stop', 'checkpoint'] }
    const selectedRole = z.enum(['reader', 'contributor', 'operator']).parse(role)
    const identity = await dialog.showOpenDialog(window, { title: 'Select recipient identity', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (identity.canceled || !identity.filePaths[0]) return false
    const actor = actorSchema.extend({ kind: z.literal('user') }).parse(await readJsonBounded(identity.filePaths[0]))
    const output = await dialog.showSaveDialog(window, { title: 'Save private session invitation outside Git', defaultPath: join(app.getPath('userData'), `invitation-${selected}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (output.canceled || !output.filePath) return false
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Enroll participant', message: `Enroll ${actor.name} on ${actor.machineName} as ${selectedRole}?`, detail: 'The invitation contains a private access credential. Transfer it directly to the recipient; do not commit it to Git or publish it.', buttons: ['Cancel', 'Create invitation'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return false
    await writeJsonAtomic(output.filePath, await manager.invite(selected, { actor, host: alias, permissions: permissions[selectedRole] }))
    return true
  })
  handle('export-checkpoint', async (window, value) => {
    const checkpoint = await manager.checkpoint(await sessionId(value))
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Export shared checkpoint', message: 'Export conversation history and code reference?', detail: `Checkpoint ${checkpoint.payload.checkpointId}\nCommit ${checkpoint.payload.code.commit}\n${checkpoint.payload.lastSeq} events. Review the conversation before sharing. Use an approved OneDrive folder; local export does not confirm cloud sync.`, buttons: ['Cancel', 'Choose export file'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return null
    const file = await dialog.showSaveDialog(window, { title: 'Export immutable checkpoint', defaultPath: `checkpoint-${checkpoint.payload.checkpointId}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (file.canceled || !file.filePath) return null
    await writeJsonAtomic(file.filePath, checkpoint, true)
    return `Checkpoint exported to ${dirname(file.filePath)}. Cloud synchronization is not confirmed.`
  })
  handle('preview-checkpoint', async (window) => {
    const file = await dialog.showOpenDialog(window, { title: 'Open downloaded checkpoint', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (file.canceled || !file.filePaths[0]) return null
    const result = await manager.previewCheckpoint(file.filePaths[0])
    const payload = result.checkpoint.payload
    return { token: result.token, checkpointId: payload.checkpointId, sessionId: payload.session.id, taskId: payload.session.taskId, lastSeq: payload.lastSeq, commit: payload.code.commit, context: payload.context, createdAt: payload.createdAt }
  })
  handle('fork', async (_window, token, directory) => manager.fork(await currentRoot(), id(token), requireDirectory(directory)))
  handle('keep-checkpoint', async (_window, token) => manager.keepCheckpoint(await currentRoot(), id(token)))
  handle('stop-host', async (window, value) => {
    const selected = await sessionId(value)
    const decision = await dialog.showMessageBox(window, { type: 'warning', title: 'Stop shared Host', message: 'Stop the execution Agent for all participants?', buttons: ['Cancel', 'Stop Host'], defaultId: 0, cancelId: 0 })
    if (decision.response === 1) await manager.stopOwner(selected)
  })
  handle('restart-host', async (window, value) => {
    const selected = await sessionId(value)
    const decision = await dialog.showMessageBox(window, { type: 'question', title: 'Restart local shared Host', message: 'Resume the original shared Agent on this machine?', detail: 'Pending work from a previous shutdown will remain interrupted. No queued tool work is replayed automatically.', buttons: ['Cancel', 'Restart Host'], defaultId: 0, cancelId: 0 })
    if (decision.response !== 1) return manager.cached(selected)
    return manager.restartOwner(await currentRoot(), selected)
  })
  return { close: () => manager.close() }
}