import { app, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { grantRemoteVSCode, listRemoteVSCodeGrants, revokeRemoteVSCode, resolveDeviceSession } from './vscodeChatClient'
import { VSCodeSessionStore } from './vscodeSessions'
import { RemoteVSCodeManager } from './vscodeRemoteClient'
import { remoteIdentityFileSchema, remoteInvitationFileSchema, sshHostAliasSchema } from './vscodeRemoteProtocol'
import { vscodeIdentitySchema } from './vscodeChatSchemas'
import { DeviceSshKeys } from './devTunnel/identity'
import { ManagedDevTunnels } from './devTunnel/manager'
import { sshFingerprint } from './devTunnel/protocol'
import { VSCodeDeviceHost } from './vscodeDeviceHost'
import { VSCodeDeviceClient } from './vscodeDeviceClient'
import { deviceInvitationSchema } from './vscodeDeviceProtocol'
import { hostname } from 'node:os'
import { readClientIdentity } from './clientIdentity'
import { canonicalPolicyRoot, locallyLinkedSessions, recordLocalLink, unregisteredLocalLinks } from './linkedSessionPolicy'
import { readRepositorySessionLinks, updateRepositorySessionLink } from './repositorySessionLinks'

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
  const protector = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value),
  }
  const keys = new DeviceSshKeys(app.getPath('userData'), protector)
  const tunnels = new ManagedDevTunnels(app.getPath('userData'), keys)
  const store = new VSCodeSessionStore()
  const host = new VSCodeDeviceHost(app.getPath('userData'), protector,
    (identity, participant, canSend, prior) => resolveDeviceSession(store, identity, participant, canSend, prior),
    (invitation) => revokeRemoteVSCode(store, invitation.identity, invitation.grant.id),
    async (root) => locallyLinkedSessions(app.getPath('userData'), root, await readClientIdentity(app.getPath('userData'))))
  const devices = new VSCodeDeviceClient(app.getPath('userData'), protector,
    (invitation, signal) => tunnels.connect(invitation.devTunnel, invitation.id, invitation.port, signal),
    async (invitation) => {
      if (JSON.stringify(invitation.participant) !== JSON.stringify(await manager.identity()) || invitation.devTunnel.clientPublicKey !== (await keys.get('client')).publicKey) throw new Error('This invitation belongs to a different device identity.')
    })
  const manager = new RemoteVSCodeManager(app.getPath('userData'), {
    devices,
    devTunnel: (route, grantId, port, signal) => tunnels.connect(route, grantId, port, signal),
    devTunnelPublicKey: async () => (await keys.get('client')).publicKey,
  })
  void tunnels.startRecovery(async () => {
    const pairs = (await host.list()).filter((pair) => Date.parse(pair.expiresAt) > Date.now())
    if (!pairs.length) return
    const port = await host.start()
    for (const pair of pairs) tunnels.authorize(pair, pair.publicKey, port, true)
  }).catch(() => undefined)
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
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: mode === 'none' ? 'Disable linked-session sharing for this workspace?' : `Allow ${mode === 'send' ? 'read and send' : 'read'} for this workspace's linked sessions?`, detail: `Workspace: ${root}\nExisting and future locally confirmed owner links follow this policy. Git-only edits cannot authorize unrelated sessions. Native tool approvals stay on the execution machine.`, buttons: ['Cancel', 'Confirm'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    if (mode !== 'none') await tunnels.publish()
    await host.setWorkspace(selected, await canonicalPolicyRoot(root), mode === 'none' ? null : mode === 'send')
    return true
  })
  handle('device-adopt-links', async (window) => {
    const root = await currentRoot()
    let snapshot = await readRepositorySessionLinks(root)
    const local = await manager.identity()
    const candidates = await unregisteredLocalLinks(app.getPath('userData'), root, snapshot.document.bindings, local)
    if (!candidates.length) return false
    for (const [, link] of candidates) if (link.provider === 'vscode-copilot') await store.locateOriginal({ nativeSessionId: link.sessionId, workspaceStorageId: link.workspaceStorageId })
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: `Register ${candidates.length} existing local links as owned by ${local.machineName}?`, detail: 'This writes owner metadata to the Git-managed links and locally confirms them for enabled workspace sharing. Do this only on the original owner machine; it does not transfer ownership or push Git.', buttons: ['Cancel', 'Register local links'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    for (const [taskId, link] of candidates) if (link.provider === 'vscode-copilot') {
      snapshot = await updateRepositorySessionLink(root, taskId, link.sessionId, snapshot.revision, link.workspaceStorageId, undefined, { clientId: local.clientId, machineName: local.machineName })
      await recordLocalLink(app.getPath('userData'), root, taskId, snapshot.document.bindings[taskId], local)
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
    const consent = await dialog.showMessageBox(window, { type: 'warning', title: 'Pair remote device', message: `Pair ${identity.participant.username} on ${identity.participant.machineName}?`, detail: `Trust this device for 30 days and start the private client connection automatically. Allow ${canSend ? 'read and send' : 'read only'} for existing and future locally confirmed Task links in ${root}. No per-session publication is needed. Pairing and workspace policy survive restarts; Stop disables publication. Native tool approvals remain on the owner.`, buttons: ['Cancel', 'Pair device'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    await tunnels.publish()
    const pair = await host.pair(identity.participant, identity.sshPublicKey)
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(root), canSend)
    const port = await host.start()
    const devTunnel = tunnels.authorize(pair, pair.publicKey, port, true)
    await writeJsonAtomic(output.filePath, deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), ownerClientId: (await manager.identity()).clientId, machineName: hostname(), participant: pair.participant, expiresAt: pair.expiresAt, token: pair.token, port, devTunnel }))
    return true
  })
  handle('device-import', async (window) => {
    const root = await currentRoot()
    const input = await dialog.showOpenDialog(window, { title: 'Import private device invitation', properties: ['openFile'], filters: json })
    if (input.canceled || !input.filePaths[0]) return false
    const parsedInvitation = deviceInvitationSchema.safeParse(await readJsonBounded(input.filePaths[0], 16384))
    if (!parsedInvitation.success) throw new Error('Import device invitation requires the private file created by Pair device on the execution machine. A client identity file must be given to that machine first; legacy session invitations use Import invitation.')
    const invitation = parsedInvitation.data
    const consent = await dialog.showMessageBox(window, { type: 'warning', title: 'Trust execution device', message: `Pair with ${invitation.machineName}?`, detail: `Host fingerprint: ${sshFingerprint(invitation.devTunnel.hostPublicKey)}\nOwner client: ${invitation.ownerClientId ?? 'Legacy invitation: re-export for Git owner routing'}\nExpires: ${invitation.expiresAt}\n\nVerify this identity with the owner. Enable automatic connection for this AD workspace, including after restart, until Disconnect. Git owner links select sessions; B enforces its workspace access policy. No execution message is replayed.`, buttons: ['Cancel', 'Import device'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    await devices.import(root, invitation, true)
    return true
  })
  handle('device-connect', async (_window, value) => devices.connect(await currentRoot(), id(value)))
  handle('device-disconnect', async (_window, value) => devices.disconnect(await currentRoot(), id(value)))
  handle('device-forget', async (window, value) => {
    const root = await currentRoot()
    const consent = await dialog.showMessageBox(window, { type: 'question', message: 'Forget this device and its cached histories?', detail: 'Repository links and original sessions are not deleted.', buttons: ['Cancel', 'Forget'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) { await unchanged(root); await devices.forget(root, id(value)) }
  })
  handle('device-revoke', async (window, value) => {
    const root = await currentRoot()
    const selected = id(value)
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: 'Revoke this device and all its session access?', buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) { await unchanged(root); tunnels.revoke(selected); await host.revoke(selected) }
  })
  handle('device-share', async (window, value, target, permission) => {
    const root = await currentRoot()
    const selected = id(value)
    const identity = vscodeIdentitySchema.parse(target)
    const canSend = z.boolean().parse(permission)
    const pair = (await host.list()).find((item) => item.id === selected)
    if (!pair) throw new Error('Device is not paired.')
    const original = await store.locateOriginal(identity)
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: `Share ${original.snapshot.session.title} with ${pair.participant.username} on ${pair.participant.machineName}?`, detail: `${canSend ? 'Read and send' : 'Read only'}. This exact-session approval persists until revoked or the device pairing expires. The bridge grant can renew after restart; other sessions are not shared.`, buttons: ['Cancel', 'Share session'], defaultId: 0, cancelId: 0 })
    if (consent.response !== 1) return false
    await unchanged(root)
    await host.approve(selected, identity, canSend)
    return true
  })
  handle('device-unshare', async (window, value, target) => {
    const root = await currentRoot()
    const consent = await dialog.showMessageBox(window, { type: 'warning', message: 'Remove this device from this session?', buttons: ['Cancel', 'Remove access'], defaultId: 0, cancelId: 0 })
    if (consent.response === 1) { await unchanged(root); await host.revokeSession(id(value), vscodeIdentitySchema.parse(target)) }
  })
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
      detail: 'This creates or reuses an owner-only Microsoft Dev Tunnel and a loopback-only SSH endpoint. Publication reconnects after network loss and app restart until you Stop publication. Only explicitly authorized sessions are accessible; execution messages are never replayed. Keep this desktop and VS Code running. No OS SSH or firewall settings change. Dev Tunnels is a preview service.', buttons: ['Cancel', 'Publish'], defaultId: 0, cancelId: 0 })
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
  return { manager, close: async () => { manager.close(); await tunnels.close(); await host.close() } }
}