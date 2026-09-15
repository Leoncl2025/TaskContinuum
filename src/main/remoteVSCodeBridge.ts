import { app, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { remoteIdentityFileSchema } from './vscodeRemoteProtocol'
import { DeviceSshKeys } from './devTunnel/identity'
import { ManagedDevTunnels } from './devTunnel/manager'
import { sshFingerprint } from './devTunnel/protocol'
import { VSCodeDeviceHost } from './vscodeDeviceHost'
import { VSCodeDeviceClient } from './vscodeDeviceClient'
import { deviceInvitationSchema } from './vscodeDeviceProtocol'
import { hostname } from 'node:os'
import { readClientIdentity } from './clientIdentity'
import { canonicalPolicyRoot, recordLocalLink, unregisteredLocalLinks } from './linkedSessionPolicy'
import { readRepositorySessionLinks } from './repositorySessionLinks'
import { AgentHostRegistry } from './agentHostRegistry'
import { AgentHostManager } from './agentHostManager'
import { locallyLinkedAgentHostSessions } from './linkedSessionPolicy'
import { WorkspaceSyncService } from './remoteConfig/service'
import { registerGitSyncBridge } from './remoteConfig/bridge'

async function requirePrivateDestination(file: string): Promise<void> {
  let directory = await realpath(dirname(file))
  while (true) {
    const git = await lstat(join(directory, '.git')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (git) throw new Error('Choose an invitation file outside Git repositories. It contains a private access credential.')
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

export function registerRemoteVSCodeBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>, onConfigurationChanged: () => void = () => {}) {
  const protector = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value),
  }
  const keys = new DeviceSshKeys(app.getPath('userData'), protector)
  const tunnels = new ManagedDevTunnels(app.getPath('userData'), keys)
  const clientIdentity = () => readClientIdentity(app.getPath('userData'))
  const host = new VSCodeDeviceHost(app.getPath('userData'), protector)
  const devices = new VSCodeDeviceClient(app.getPath('userData'), protector,
    (invitation, signal) => tunnels.connect(invitation.devTunnel, invitation.id, invitation.port, signal),
    async (invitation) => {
      if (JSON.stringify(invitation.participant) !== JSON.stringify(await clientIdentity()) || invitation.devTunnel.clientPublicKey !== (await keys.get('client')).publicKey) throw new Error('This invitation belongs to a different device identity.')
    })
  const discovery = !app.isPackaged && process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY ? [process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY]
    : ['Code', 'Code - Insiders'].map((name) => join(app.getPath('appData'), name, 'agent-host', 'local-endpoint', 'entries'))
  const registry = new AgentHostRegistry(app.getPath('userData'), discovery, async () => {
    const { clientId, machineName } = await clientIdentity()
    return { clientId, machineName }
  })
  const agentHosts = new AgentHostManager(app.getPath('userData'), registry, devices, async () => {
    const { clientId, machineName } = await clientIdentity()
    return { clientId, machineName }
  })
  host.setAgentHostAccess(registry, async (root) => { await gitSync.requireReadyRoot(root); return locallyLinkedAgentHostSessions(app.getPath('userData'), root, await clientIdentity()) })
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
  const json = [{ name: 'JSON', extensions: ['json'] }]
  const id = (value: unknown) => z.uuid().parse(value)
  function handle(channel: string, action: (window: BrowserWindow, ...values: unknown[]) => unknown): void {
    ipcMain.handle(`remote-vscode:${channel}`, (event, ...values: unknown[]) => action(requireWindow(event), ...values))
  }
  async function unchanged(root: string): Promise<void> {
    if (await currentRoot() !== root) throw new Error('The task workspace changed. Reopen the remote connection action; no replacement workspace was used.')
  }
  handle('devices', async () => devices.list(await currentRoot()))
  handle('device-recipients', async () => {
    const root = await canonicalPolicyRoot(await currentRoot())
    return (await host.list()).map((pair) => ({ id: pair.id, username: pair.participant.username, machineName: pair.participant.machineName, expiresAt: pair.expiresAt, linkedAccess: pair.workspaces.find((item) => item.root === root)?.canSend === true ? 'send' as const : pair.workspaces.some((item) => item.root === root) ? 'read' as const : 'none' as const }))
  })
  handle('device-workspace', async (window, value, permission) => {
    const root = await currentRoot()
    const selected = id(value)
    const mode = z.enum(['none', 'read', 'send']).parse(permission)
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: mode === 'none' ? 'Disable linked-session sharing for this workspace?' : `Allow ${mode === 'send' ? 'read and send' : 'read'} for this workspace's linked sessions?`, detail: `Workspace: ${root}\nExisting and future locally confirmed owner links follow this policy. ${mode === 'send' ? 'Send access also permits explicit native Agent Host session creation in this workspace folder, without another create permission.' : 'Without send access, this device cannot create Agent Host sessions in this workspace.'} Git-only edits cannot authorize unrelated sessions. Native tool approvals stay on the execution machine.`, buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    if (mode !== 'none') await tunnels.publish()
    await host.setWorkspace(selected, await canonicalPolicyRoot(root), mode === 'none' ? null : mode === 'send')
    return true
  })
  handle('device-adopt-links', async (window) => {
    const root = await currentRoot()
    const snapshot = await readRepositorySessionLinks(root)
    const local = await clientIdentity()
    const candidates = await unregisteredLocalLinks(app.getPath('userData'), root, snapshot.document.bindings, local)
    if (!candidates.length) return false
    for (const [, link] of candidates) await agentHosts.verifyLink(root, link)
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: `Confirm ${candidates.length} existing Agent Host links on ${local.machineName}?`, detail: 'This records local authorization for the existing immutable bindings. It does not import legacy bindings, change their owner, or grant access on another machine.', buttons: ['Cancel', 'Confirm local links'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    for (const [taskId, link] of candidates) {
      await unchanged(root)
      if ((await readRepositorySessionLinks(root)).revision !== snapshot.revision) throw new Error('Session bindings changed during confirmation. Review the current links before granting access.')
      await agentHosts.verifyLink(root, link)
      await recordLocalLink(app.getPath('userData'), root, taskId, link, local)
    }
    return true
  })
  handle('device-pair', async (window, permission) => {
    const root = await currentRoot()
    const canSend = z.boolean().optional().parse(permission) ?? true
    const input = await dialog.showOpenDialog(window, { title: 'Select client identity to pair once', properties: ['openFile'], filters: json })
    if (input.canceled || !input.filePaths[0]) return false
    const parsedIdentity = remoteIdentityFileSchema.safeParse(await readJsonBounded(input.filePaths[0], 16384))
    if (!parsedIdentity.success) throw new Error('Pair device requires the receiving desktop\'s Export client identity file. If you received a device invitation from the execution machine, use Import device invitation instead.')
    const identity = parsedIdentity.data
    if (!identity.sshPublicKey) throw new Error('Export a managed client identity with its public key.')
    const output = await dialog.showSaveDialog(window, { title: 'Save private device invitation outside Git', defaultPath: join(app.getPath('documents'), `taskcontinuum-device-${randomUUID()}.json`), filters: json })
    if (output.canceled || !output.filePath) return false
    await requirePrivateDestination(output.filePath)
    const consent = await dialog.showMessageBox(window, { type: 'warning', title: 'Pair remote device', message: `Pair ${identity.participant.username} on ${identity.participant.machineName}?`, detail: `Trust this device for 30 days and start the private client connection automatically. Allow ${canSend ? 'read and send' : 'read only'} for existing and future locally confirmed Task links in ${root}. ${canSend ? 'Send access also includes explicit native Agent Host session creation in this workspace folder; no separate create permission is required.' : 'Read-only access does not permit session creation.'} No per-session publication is needed. Pairing and workspace policy survive restarts; Stop disables publication. Native tool approvals remain on the owner.`, buttons: ['Cancel', 'Pair device'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    await tunnels.publish()
    const pair = await host.pair(identity.participant, identity.sshPublicKey)
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(root), canSend)
    const port = await host.start()
    const devTunnel = tunnels.authorize(pair, pair.publicKey, port, true)
    await writeJsonAtomic(output.filePath, deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), ownerClientId: (await clientIdentity()).clientId, machineName: hostname(), participant: pair.participant, expiresAt: pair.expiresAt, token: pair.token, port, devTunnel }))
    return true
  })
  handle('device-import', async (window) => {
    const root = await currentRoot()
    const input = await dialog.showOpenDialog(window, { title: 'Import private device invitation', properties: ['openFile'], filters: json })
    if (input.canceled || !input.filePaths[0]) return false
    const parsedInvitation = deviceInvitationSchema.safeParse(await readJsonBounded(input.filePaths[0], 16384))
    if (!parsedInvitation.success) throw new Error('Import device invitation requires the private file created by Pair device on the execution machine. Legacy per-session invitations are unsupported and cannot be converted.')
    const invitation = parsedInvitation.data
    if (!invitation.ownerClientId) throw new Error('This device invitation does not identify an Agent Host owner. Ask the execution machine to export a current device invitation; no owner is inferred from session links.')
    const consent = await dialog.showMessageBox(window, { type: 'warning', title: 'Trust execution device', message: `Pair with ${invitation.machineName}?`, detail: `Host fingerprint: ${sshFingerprint(invitation.devTunnel.hostPublicKey)}\nOwner client: ${invitation.ownerClientId}\nExpires: ${invitation.expiresAt}\n\nVerify this identity with the owner. Enable automatic connection for this AD workspace, including after restart, until Disconnect. Git owner links select sessions; B enforces its workspace access policy. No execution message is replayed.`, buttons: ['Cancel', 'Import device'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    await devices.import(root, invitation, true)
    return true
  })
  handle('device-connect', async (_window, value) => devices.connect(await currentRoot(), id(value)))
  handle('device-disconnect', async (_window, value) => devices.disconnect(await currentRoot(), id(value)))
  handle('device-forget', async (window, value) => {
    const root = await currentRoot()
    const consent = await dialog.showMessageBox(window, { type: 'question', message: 'Forget this device connection?', detail: 'Repository links, original sessions, historical data and device SSH keys are not deleted.', buttons: ['Cancel', 'Forget'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) { await unchanged(root); await devices.forget(root, id(value)) }
  })
  handle('device-revoke', async (window, value) => {
    const root = await currentRoot()
    const selected = id(value)
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: 'Revoke this device and all its session access?', buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) {
      await unchanged(root)
      const pair = (await host.list()).find((entry) => entry.id === selected)
      tunnels.revoke(selected)
      await host.revoke(selected)
      if (pair) await gitSync.revokeEverywhere(pair.participant.clientId)
    }
  })
  handle('tunnel-status', async (_window, refresh) => { await currentRoot(); return tunnels.status(z.boolean().optional().parse(refresh) ?? false) })
  handle('tunnel-login', async () => { await currentRoot(); await tunnels.login() })
  handle('tunnel-cancel', async () => { await currentRoot(); await tunnels.cancel() })
  handle('tunnel-reset', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Reset saved publication', message: 'Forget this publication and disconnect its remote desktops?',
      detail: 'The next Publish creates a new private tunnel and requires new device invitations. Native Agent Host sessions and device SSH keys are kept. This removes only the saved local publication; the old cloud resource remains owner-managed until its configured expiry.', buttons: ['Cancel', 'Reset publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.reset() }
  })
  handle('tunnel-installation', async () => { await shell.openExternal('https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started') })
  handle('tunnel-publish', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Publish private Dev Tunnel', message: 'Allow paired Task Continuum desktops to connect to this machine?',
      detail: 'This creates or reuses an owner-only Microsoft Dev Tunnel and a loopback-only SSH endpoint. Publication reconnects after network loss and app restart until you Stop publication. Only explicitly authorized sessions are accessible; execution messages are never replayed. Keep this desktop and VS Code running. No OS SSH or firewall settings change. Dev Tunnels is a preview service.', buttons: ['Cancel', 'Publish'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return
    await unchanged(root)
    await tunnels.publish()
  })
  handle('tunnel-stop', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Stop private publication', message: 'Disconnect remote desktops from this publication?', detail: 'Native Agent Host sessions are not stopped. New device invitations are required after publishing again.', buttons: ['Cancel', 'Stop publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.stop() }
  })
  handle('export-identity', async (window, managed) => {
    const useTunnel = z.boolean().optional().parse(managed) ?? true
    const participant = await clientIdentity()
    const output = await dialog.showSaveDialog(window, { title: 'Export Task Continuum device identity', defaultPath: `taskcontinuum-client-${participant.clientId}.json`, filters: json })
    if (output.canceled || !output.filePath) return false
    const sshPublicKey = useTunnel ? (await keys.get('client')).publicKey : undefined
    await writeJsonAtomic(output.filePath, remoteIdentityFileSchema.parse({ schemaVersion: 1, provider: 'vscode-copilot', participant, ...(sshPublicKey ? { sshPublicKey } : {}) }))
    return true
  })
  return { agentHosts, gitSync, close: async () => {
    try { await recovery } catch (error) { console.error('Closing after workspace recovery failure:', error instanceof Error ? error.message : 'Invalid saved state') }
    await gitSync.close()
    devices.close()
    await tunnels.close()
    await host.close()
    await agentHosts.close()
  } }
}