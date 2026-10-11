import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { WorkspaceGitSyncStatus } from '../../shared/gitSync'
import type { RemoteSettingChanges } from './settingsFile'
import { machineAliasChangeSchema } from './machineAlias'

export interface GitSyncActions {
  status(root: string): Promise<WorkspaceGitSyncStatus>
  enable(root: string): Promise<void>
  disable(root: string): Promise<void>
  syncNow(root: string): Promise<void>
  revokeDevice(root: string, deviceId: string): Promise<void>
  setSettings(root: string, expectedRevision: string | null, changes: RemoteSettingChanges): Promise<void>
  setMachineAlias(root: string, deviceId: string, alias: string | null, expectedRevision: string | null): Promise<void>
}

export function registerGitSyncBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>, service: GitSyncActions): void {
  function handle(name: string, action: (window: BrowserWindow, value: unknown) => Promise<unknown>) {
    ipcMain.handle(`remote-vscode:git-${name}`, (event, value: unknown) => action(requireWindow(event), value))
  }
  async function unchanged(root: string) {
    if (await currentRoot() !== root) throw new Error('The active workspace changed. Repeat this action in the intended workspace.')
  }
  handle('status', async () => service.status(await currentRoot()))
  handle('enable', async (window) => {
    const root = await currentRoot()
    const consent = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Enable automatic workspace links',
      message: 'Synchronize this workspace and automatically link its enrolled devices?',
      detail: `Workspace: ${root}\nTaskCon will use this same checkout for signed immutable Agent Host bindings, check its upstream every 15 seconds, and immediately commit/push public identities, invitations and configuration changes when Git is safe. No separate AD clone or worktree is created. Only public .taskcontinuum metadata is automatically committed. Staged changes, dirty user files, in-progress Git operations and unpublished user commits pause synchronization; TaskCon never stashes, discards or publishes them. Pending configuration remains durable in local app data.\n\nThe target follows the current branch's configured upstream within this repository; no branch is permanently bound and main/master is not assumed. Without an upstream, Git synchronization pauses while the workspace and saved configuration remain available. Legacy session files and browser bindings are not imported; select existing Agent Host sessions again after enabling.\n\nNew signed device identities in this shared repository will be admitted and pinned under this local policy. Linked devices automatically receive read and send access to locally-confirmed linked sessions and permission to explicitly create Agent Host sessions in this workspace. Existing enrolled devices' read-only workspace grants are upgraded; no separate session-access switch is required. No session is created and no prompt is sent just by linking. Existing fingerprint changes stay blocked. Private keys and bearer invitations never enter Git. OS shell access is not granted and native tool approvals remain on the execution machine.\n\nSign in to the same Dev Tunnel owner account on each machine. You can pause synchronization or revoke peers in Devices.`,
      buttons: ['Cancel', 'Enable automatic links'], defaultId: 0, cancelId: 0,
    })
    if (consent.response !== 1) return false
    await unchanged(root)
    await service.enable(root)
    return true
  })
  handle('disable', async () => service.disable(await currentRoot()))
  handle('sync', async () => service.syncNow(await currentRoot()))
  handle('revoke', async (window, value) => {
    const root = await currentRoot()
    const deviceId = z.uuid().parse(value)
    const consent = await dialog.showMessageBox(window, {
      type: 'warning', message: 'Revoke this device from automatic workspace links?',
      detail: 'This blocks future automatic admission and closes the workspace connection. Original sessions and other workspaces are not deleted.',
      buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0,
    })
    if (consent.response !== 1) return
    await unchanged(root)
    await service.revokeDevice(root, deviceId)
  })
  handle('setting', async (_window, value) => {
    const request = z.object({
      key: z.enum(['autoLink', 'tunnelEnabled', 'connectTimeoutMs']),
      value: z.union([z.boolean(), z.number(), z.null()]),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict().parse(value)
    const root = await currentRoot()
    if (request.key === 'connectTimeoutMs') {
      const timeout = request.value === null ? null : z.number().int().min(1000).max(120000).parse(request.value)
      await service.setSettings(root, request.expectedRevision, { connectTimeoutMs: timeout })
    } else {
      const flag = request.value === null ? null : z.boolean().parse(request.value)
      await service.setSettings(root, request.expectedRevision, { [request.key]: flag })
    }
  })
  handle('machine-alias', async (_window, value) => {
    const request = z.object({
      deviceId: z.uuid(),
      alias: machineAliasChangeSchema,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict().parse(value)
    await service.setMachineAlias(await currentRoot(), request.deviceId, request.alias, request.expectedRevision)
  })
  handle('open-settings', async () => {
    const root = await currentRoot()
    const file = (await service.status(root)).settingsFile
    if (!file) throw new Error('Enable workspace synchronization before opening its local configuration editor.')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
}
