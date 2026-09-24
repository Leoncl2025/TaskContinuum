import { app, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { DeviceSshKeys } from './devTunnel/identity'
import { ManagedDevTunnels } from './devTunnel/manager'
import { VSCodeDeviceHost } from './vscodeDeviceHost'
import { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readClientIdentity } from './clientIdentity'
import { AgentHostRegistry } from './agentHostRegistry'
import { AgentHostManager } from './agentHostManager'
import { LocalTaskAgentHostWorker } from './localTaskAgentHostWorker'
import { locallyLinkedAgentHostSessions } from './linkedSessionPolicy'
import { WorkspaceSyncService } from './remoteConfig/service'
import { registerGitSyncBridge } from './remoteConfig/bridge'
import { FileTransferSource } from './fileTransferSource'
import { FileTransferService } from './fileTransferService'
import { startFileTransferMcpBridge } from './fileTransferMcpBridge'
import { FileTransferBudget } from './fileTransferBudget'

export function registerRemoteVSCodeBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>, onConfigurationChanged: () => void = () => {}) {
  const protector = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value),
  }
  const keys = new DeviceSshKeys(app.getPath('userData'), protector)
  const tunnels = new ManagedDevTunnels(app.getPath('userData'), keys)
  const clientIdentity = () => readClientIdentity(app.getPath('userData'))
  const host = new VSCodeDeviceHost(app.getPath('userData'), protector)
  const fileBudget = new FileTransferBudget()
  const fileSource = new FileTransferSource(app.getPath('userData'), app.getVersion())
  host.setFileTransferSource(fileSource, fileBudget)
  const devices = new VSCodeDeviceClient(app.getPath('userData'), protector,
    (invitation, signal) => tunnels.connect(invitation.devTunnel, invitation.id, invitation.port, signal),
    async (invitation) => {
      if (JSON.stringify(invitation.participant) !== JSON.stringify(await clientIdentity()) || invitation.devTunnel.clientPublicKey !== (await keys.get('client')).publicKey) throw new Error('This invitation belongs to a different device identity.')
    },
    async (root): Promise<void> => {
      await recovery
      await gitSync.whenConnectionsSettled(root)
    })
  const files = new FileTransferService(app.getPath('userData'), fileSource, devices, fileBudget)
  const filesReady = startFileTransferMcpBridge(app.getPath('userData'), (root) => files.forWorkspace(root))
  void filesReady.catch(() => console.error('The local file transfer MCP bridge could not start.'))
  const discovery = !app.isPackaged && process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY ? [process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY]
    : ['Code', 'Code - Insiders'].map((name) => join(app.getPath('appData'), name, 'agent-host', 'local-endpoint', 'entries'))
  const registry = new AgentHostRegistry(app.getPath('userData'), discovery, async () => {
    const { clientId, machineName } = await clientIdentity()
    return { clientId, machineName }
  })
  const localTaskWorker = new LocalTaskAgentHostWorker(registry, () => host.taskCreationService, (root) => agentHosts.hasConsent(root))
  const agentHosts: AgentHostManager = new AgentHostManager(app.getPath('userData'), registry, devices, async () => {
    const { clientId, machineName } = await clientIdentity()
    return { clientId, machineName }
  }, localTaskWorker)
  host.setAgentHostAccess(registry, async (root) => { await gitSync.requireReadyRoot(root); return locallyLinkedAgentHostSessions(app.getPath('userData'), root, await clientIdentity()) },
    (ownerId, workspaceId) => localTaskWorker.authorize(ownerId, workspaceId), async (root) => {
      if (!gitSync.sessionAccessReady(root)) throw new Error('The workspace is not ready for Agent Host access.')
      const access = await agentHosts.access.acquire(root)
      if (!gitSync.sessionAccessReady(root)) throw new Error('Workspace access changed while connecting.')
      return access
    })
  const gitSync = new WorkspaceSyncService({
    directory: app.getPath('userData'), keys, tunnels, host, devices,
    identity: clientIdentity, onChange: onConfigurationChanged,
  })
  registerGitSyncBridge(requireWindow, currentRoot, gitSync)
  const recovery = gitSync.restore().then(() => tunnels.startRecovery(async () => {
    const pairs = (await host.list()).filter((pair) => Date.parse(pair.expiresAt) > Date.now())
    if (pairs.length) {
      const port = await host.start()
      for (const pair of pairs) tunnels.authorize(pair, pair.publicKey, port, true)
    }
    await gitSync.restoreControlGrants()
  })).then(() => gitSync.startRestored())
  void recovery.catch((error: unknown) => console.error('Automatic workspace recovery failed:', error instanceof Error ? error.message : 'Invalid saved state'))
  const id = (value: unknown) => z.uuid().parse(value)
  function handle(channel: string, action: (window: BrowserWindow, ...values: unknown[]) => unknown): void {
    ipcMain.handle(`remote-vscode:${channel}`, (event, ...values: unknown[]) => action(requireWindow(event), ...values))
  }
  async function unchanged(root: string): Promise<void> {
    if (await currentRoot() !== root) throw new Error('The task workspace changed. Reopen the remote connection action; no replacement workspace was used.')
  }
  handle('devices', async () => devices.list(await currentRoot()))
  handle('device-connect', async (_window, value) => devices.connect(await currentRoot(), id(value)))
  handle('device-disconnect', async (_window, value) => devices.disconnect(await currentRoot(), id(value)))
  handle('device-forget', async (window, value) => {
    const root = await currentRoot()
    const consent = await dialog.showMessageBox(window, { type: 'question', message: 'Forget this device connection?', detail: 'Repository links, original sessions, historical data and device SSH keys are not deleted.', buttons: ['Cancel', 'Forget'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) { await unchanged(root); await devices.forget(root, id(value)) }
  })
  handle('tunnel-status', async (_window, refresh) => { await currentRoot(); return tunnels.status(z.boolean().optional().parse(refresh) ?? false) })
  handle('tunnel-login', async () => { await currentRoot(); await tunnels.login() })
  handle('tunnel-cancel', async () => { await currentRoot(); await tunnels.cancel() })
  handle('tunnel-reset', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Reset saved publication', message: 'Forget this publication and disconnect its remote desktops?',
      detail: 'The next Publish creates a new private tunnel; automatic workspace links exchange the updated route and invitations. Native Agent Host sessions and device SSH keys are kept. This removes only the saved local publication; the old cloud resource remains owner-managed until its configured expiry.', buttons: ['Cancel', 'Reset publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.reset() }
  })
  handle('tunnel-installation', async () => { await shell.openExternal('https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started') })
  handle('tunnel-publish', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Publish private Dev Tunnel', message: 'Allow paired Task Continuum desktops to connect to this machine?',
      detail: 'This creates or reuses an owner-only Microsoft Dev Tunnel and a loopback-only SSH endpoint. Publication reconnects after network loss and app restart until you Stop publication. Paired workspace devices can access linked sessions and read ordinary local files without per-file prompts. Application credentials are excluded; execution messages are never replayed. Keep this desktop and VS Code running. No OS SSH or firewall settings change. Dev Tunnels is a preview service.', buttons: ['Cancel', 'Publish'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return
    await unchanged(root)
    await tunnels.publish()
  })
  handle('tunnel-stop', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Stop private publication', message: 'Disconnect remote desktops from this publication?', detail: 'Native Agent Host sessions are not stopped. Automatic workspace links exchange new invitations after publishing again.', buttons: ['Cancel', 'Stop publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.stop() }
  })
  let closing: Promise<void> | undefined
  return { agentHosts, gitSync, filesReady, close: () => closing ??= (async () => {
    try { await (await filesReady).close() } catch { console.error('Closing after file transfer MCP bridge failure.') }
    await files.close()
    await fileSource.close()
    try { await recovery } catch (error) { console.error('Closing after workspace recovery failure:', error instanceof Error ? error.message : 'Invalid saved state') }
    await gitSync.close()
    devices.close()
    await tunnels.close()
    await host.close()
    await agentHosts.close()
  })() }
}