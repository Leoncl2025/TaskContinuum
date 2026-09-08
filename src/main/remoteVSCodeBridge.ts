import { app, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { grantRemoteVSCode, listRemoteVSCodeGrants, revokeRemoteVSCode } from './vscodeChatClient'
import { VSCodeSessionStore } from './vscodeSessions'
import { RemoteVSCodeManager } from './vscodeRemoteClient'
import { remoteIdentityFileSchema, remoteInvitationFileSchema, sshHostAliasSchema } from './vscodeRemoteProtocol'
import { vscodeIdentitySchema } from './vscodeChatSchemas'
import { DeviceSshKeys } from './devTunnel/identity'
import { ManagedDevTunnels } from './devTunnel/manager'
import { sshFingerprint } from './devTunnel/protocol'

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

export function registerRemoteVSCodeBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>) {
  const keys = new DeviceSshKeys(app.getPath('userData'), {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value),
  })
  const tunnels = new ManagedDevTunnels(app.getPath('userData'), keys)
  const manager = new RemoteVSCodeManager(app.getPath('userData'), {
    devTunnel: (route, grantId, port, signal) => tunnels.connect(route, grantId, port, signal),
    devTunnelPublicKey: async () => (await keys.get('client')).publicKey,
  })
  const store = new VSCodeSessionStore()
  const json = [{ name: 'JSON', extensions: ['json'] }]
  const id = (value: unknown) => z.uuid().parse(value)
  function handle(channel: string, action: (window: BrowserWindow, ...values: unknown[]) => unknown): void {
    ipcMain.handle(`remote-vscode:${channel}`, (event, ...values: unknown[]) => action(requireWindow(event), ...values))
  }
  async function unchanged(root: string): Promise<void> {
    if (await currentRoot() !== root) throw new Error('The task workspace changed. Reopen the remote connection action; no replacement workspace was used.')
  }
  handle('tunnel-status', async (_window, refresh) => { await currentRoot(); return tunnels.status(z.boolean().optional().parse(refresh) ?? false) })
  handle('tunnel-login', async () => { await currentRoot(); await tunnels.login() })
  handle('tunnel-cancel', async () => { await currentRoot(); await tunnels.cancel() })
  handle('tunnel-reset', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Reset saved publication', message: 'Forget this publication and disconnect its remote desktops?',
      detail: 'The next Publish creates a new private tunnel and requires new invitations. The original VS Code Agent and device SSH keys are kept. This removes only the saved local publication; the old cloud resource remains owner-managed until its configured expiry.', buttons: ['Cancel', 'Reset publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.reset() }
  })
  handle('tunnel-installation', async () => { await shell.openExternal('https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started') })
  handle('tunnel-publish', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Publish private Dev Tunnel', message: 'Allow paired Task Continuum desktops to connect to this machine?',
      detail: 'This creates or reuses an owner-only Microsoft Dev Tunnel and a loopback-only SSH endpoint inside this desktop. No Windows accounts, SSH services, firewall rules, or user SSH files are changed. Only explicitly invited original VS Code sessions may be forwarded. Keep this desktop and VS Code running. Dev Tunnels is a preview service for development and testing.', buttons: ['Cancel', 'Publish'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return
    await unchanged(root)
    await tunnels.publish()
  })
  handle('tunnel-stop', async (window) => {
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Stop private publication', message: 'Disconnect remote desktops from this publication?', detail: 'The original VS Code Agent is not stopped. New invitations are required after publishing again.', buttons: ['Cancel', 'Stop publication'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await tunnels.stop() }
  })
  handle('export-identity', async (window, managed) => {
    const useTunnel = z.boolean().optional().parse(managed) ?? false
    const participant = await manager.identity()
    const output = await dialog.showSaveDialog(window, { title: 'Export remote VS Code client identity', defaultPath: `taskcontinuum-client-${participant.clientId}.json`, filters: json })
    if (output.canceled || !output.filePath) return false
    const sshPublicKey = useTunnel ? (await keys.get('client')).publicKey : undefined
    await writeJsonAtomic(output.filePath, remoteIdentityFileSchema.parse({ schemaVersion: 1, provider: 'vscode-copilot', participant, ...(sshPublicKey ? { sshPublicKey } : {}) }))
    return true
  })
  handle('import-invitation', async (window, host) => {
    const alias = host === undefined || host === '' ? undefined : sshHostAliasSchema.parse(host)
    const root = await currentRoot()
    const input = await dialog.showOpenDialog(window, { title: 'Import private remote VS Code invitation', properties: ['openFile'], filters: json })
    if (input.canceled || !input.filePaths[0]) return null
    const parsed = remoteInvitationFileSchema.safeParse(await readJsonBounded(input.filePaths[0], 16384))
    if (!parsed.success) throw new Error('This is not a valid private remote VS Code invitation.')
    const invitation = parsed.data
    if (!invitation.devTunnel && !alias) throw new Error('This invitation uses an existing SSH alias. Select SSH alias mode and enter the configured alias.')
    const route = invitation.devTunnel ? `Dev Tunnel: ${invitation.devTunnel.tunnelId}\nSSH host fingerprint: ${sshFingerprint(invitation.devTunnel.hostPublicKey)}` : `SSH alias: ${alias}`
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Trust remote VS Code owner', message: `Connect to ${invitation.execution.agentName} on ${invitation.execution.machineName}?`,
      detail: `Conversation: ${invitation.title}\nSession: ${invitation.identity.nativeSessionId}\n${route}\nParticipant: ${invitation.grant.participant.username} @ ${invitation.grant.participant.machineName}\nAccess: ${invitation.grant.canSend ? 'Read and send' : 'Read only'}\nExpires: ${invitation.grant.expiresAt}\n\nVerify the owner and SSH fingerprint through a trusted channel. No Agent or conversation is created. Connecting remains a separate action. Dev Tunnel clients must sign in as the same company owner.`, buttons: ['Cancel', 'Import'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return null
    await unchanged(root)
    return manager.importInvitation(root, invitation, alias)
  })
  handle('list', async () => manager.list(await currentRoot()))
  handle('connect', async (_window, value) => manager.connect(await currentRoot(), id(value)))
  handle('disconnect', async (_window, value) => manager.disconnect(await currentRoot(), id(value)))
  handle('forget', async (window, value) => {
    const root = await currentRoot()
    const selected = id(value)
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Forget remote VS Code access', message: 'Remove this local invitation and cached history?', detail: 'The original conversation and repository task link are not removed. This does not stop the execution Agent.', buttons: ['Cancel', 'Forget'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await manager.forget(root, selected) }
  })
  handle('share', async (window, value, permission, managed) => {
    const identity = vscodeIdentitySchema.parse(value)
    const canSend = z.boolean().parse(permission)
    const useTunnel = z.boolean().optional().parse(managed) ?? false
    const root = await currentRoot()
    const original = await store.locateOriginal(identity)
    const input = await dialog.showOpenDialog(window, { title: 'Select remote client identity', properties: ['openFile'], filters: json })
    if (input.canceled || !input.filePaths[0]) return false
    const parsed = remoteIdentityFileSchema.safeParse(await readJsonBounded(input.filePaths[0], 4096))
    if (!parsed.success) throw new Error('Select the identity exported by the receiving Task Continuum desktop.')
    const { participant, sshPublicKey } = parsed.data
    if (useTunnel && !sshPublicKey) throw new Error('This client identity has no managed SSH public key. Export it again using Dev Tunnel mode.')
    if (useTunnel && (await tunnels.status()).state !== 'hosting') throw new Error('Publish this machine with Dev Tunnel before creating its invitation.')
    const output = await dialog.showSaveDialog(window, { title: 'Save private invitation outside Git', defaultPath: join(app.getPath('documents'), `taskcontinuum-vscode-invitation-${randomUUID()}.json`), filters: json })
    if (output.canceled || !output.filePath) return false
    await requirePrivateDestination(output.filePath)
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Authorize remote original-session access',
      message: `Authorize ${participant.username} on ${participant.machineName} to ${canSend ? 'read and send' : 'read'}?`,
      detail: `Original conversation: ${original.snapshot.session.title}\nSession: ${identity.nativeSessionId}\n\nThis grants access to this conversation's visible saved history and ${canSend ? 'allows new prompts to its original Agent' : 'does not permit prompts'}. Verify the identity with the recipient. Anyone holding the private invitation can use that grant through an authorized SSH connection. It expires in 24 hours or when this bridge stops. Native tool approvals stay here; your extra-send-confirmation preference still applies.`,
      buttons: ['Cancel', 'Create invitation'], defaultId: 0, cancelId: 0 })
    if (confirmation.response !== 1) return false
    await unchanged(root)
    const invitation = await grantRemoteVSCode(store, identity, participant, canSend)
    try {
      const devTunnel = useTunnel ? tunnels.authorize(invitation.grant, sshPublicKey!, invitation.port) : undefined
      await writeJsonAtomic(output.filePath, { ...invitation, ...(devTunnel ? { devTunnel } : {}) })
    } catch (error) {
      tunnels.revoke(invitation.grant.id)
      await revokeRemoteVSCode(store, identity, invitation.grant.id).catch(() => undefined)
      throw error
    }
    return true
  })
  handle('grants', async (_window, value) => { await currentRoot(); return listRemoteVSCodeGrants(store, vscodeIdentitySchema.parse(value)) })
  handle('revoke', async (window, value, grantId) => {
    const identity = vscodeIdentitySchema.parse(value)
    const selected = id(grantId)
    const root = await currentRoot()
    const confirmation = await dialog.showMessageBox(window, { type: 'warning', title: 'Revoke remote access', message: 'Revoke this remote invitation?', detail: 'Future reads and submissions will be rejected. An already-running Agent response is not stopped.', buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0 })
    if (confirmation.response === 1) { await unchanged(root); await revokeRemoteVSCode(store, identity, selected); tunnels.revoke(selected) }
  })
  return { manager, close: async () => { manager.close(); await tunnels.close() } }
}