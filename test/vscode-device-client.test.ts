// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import type { DeviceInvitation } from '../src/main/vscodeDeviceProtocol'
import type { AgentHostRegistry } from '../src/main/agentHostRegistry'
import type { AgentHostTarget } from '../src/shared/agentHost'
import * as deviceHttp from '../src/main/vscodeDeviceHttp'

const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { try { for (const close of cleanup.splice(0)) await close() } finally { vi.restoreAllMocks() } })

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.test-ah-device-client-'))
  const workspace = join(root, 'tasks')
  const otherWorkspace = join(root, 'other-tasks')
  const profile = join(root, 'client')
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)])
  const target: AgentHostTarget = { hostId: 'native-host-123', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original', owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const host = new VSCodeDeviceHost(join(root, 'owner'), protector)
  host.setAgentHostAccess({ describe: async () => ({ ...target, title: 'Original chat', provider: 'copilotcli', updatedAt: new Date().toISOString(), canSend: true }) } as unknown as AgentHostRegistry, async () => [target])
  const resources: { client?: VSCodeDeviceClient; ssh?: Awaited<ReturnType<typeof startSessionSshHost>> } = {}
  cleanup.push(async () => { resources.client?.close(); await resources.ssh?.close(); await host.close(); await rm(root, { recursive: true, force: true }) })
  const clientKey = newSshKeyPair()
  const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'Client-A' }
  const pair = await host.pair(participant, clientKey.publicKey)
  const port = await host.start()
  const ssh = await startSessionSshHost(newSshKeyPair())
  resources.ssh = ssh
  ssh.allow(pair.id, clientKey.publicKey, port, pair.expiresAt, true)
  const invitation = deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), ownerClientId: target.owner.clientId,
    machineName: target.owner.machineName, participant, token: pair.token, expiresAt: pair.expiresAt, port,
    devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'a'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: clientKey.publicKey } })
  const transport = vi.fn((value: DeviceInvitation, signal: AbortSignal) => openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), {
    key: clientKey, hostPublicKey: value.devTunnel.hostPublicKey, grantId: value.id, targetPort: value.port, signal,
  }))
  const validateRecipient = async (value: DeviceInvitation) => {
    if (JSON.stringify(value.participant) !== JSON.stringify(participant) || value.devTunnel.clientPublicKey !== clientKey.publicKey) throw new Error('Wrong device identity.')
  }
  const client = new VSCodeDeviceClient(profile, protector, transport, validateRecipient)
  resources.client = client
  await client.import(workspace, invitation)
  const device = (await client.list(workspace))[0]
  return { root, workspace, otherWorkspace, profile, host, client, invitation, device, target, transport, validateRecipient }
}

describe('paired native Agent Host SSH transport', () => {
  it.each(['timeout', 'cancellation'])('identifies device verification %s without suggesting a legacy bridge', async (reason) => {
    const abort = new AbortController()
    const server = createServer((request) => { request.resume(); if (reason === 'cancellation') abort.abort() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test listener unavailable.')
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const deadline = reason === 'timeout' ? vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(30)) : undefined
    try {
      await expect(deviceHttp.deviceRequest(address.port, address.port, 'test-only', '/device/identity', {}, abort.signal))
        .rejects.toThrow(reason === 'timeout' ? 'Device identity verification timed out waiting for the owner' : 'Device identity verification was cancelled')
      if (deadline) expect(deadline).toHaveBeenCalledWith(15000)
    } finally {
      deadline?.mockRestore()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('pins one SSH device connection without session discovery or execution on connect', async () => {
    const setup = await fixture()
    const requests = vi.spyOn(deviceHttp, 'deviceRequest')
    expect(setup.transport).not.toHaveBeenCalled()
    expect(await setup.client.publicIdentities(setup.workspace)).toEqual([{ deviceId: setup.target.owner.clientId, machineName: setup.target.owner.machineName, hostPublicKey: setup.invitation.devTunnel.hostPublicKey }])
    expect(await setup.client.list(setup.otherWorkspace)).toEqual([])
    await expect(setup.client.connect(setup.otherWorkspace, setup.device.id)).rejects.toThrow('task workspace')
    expect(await setup.client.agentHostSessions(setup.workspace)).toEqual({ sessions: [], warnings: [] })
    await setup.client.connectOwner(setup.workspace, setup.target.owner.clientId)
    expect(requests.mock.calls.map((call) => call[3])).toEqual(['/device/identity'])
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(true)
    await setup.host.setWorkspace(setup.invitation.id, setup.workspace, false)
    expect(await setup.client.agentHostSessions(setup.workspace)).toMatchObject({ sessions: [{ ...setup.target, canSend: false }], warnings: [] })
    await setup.host.setWorkspace(setup.invitation.id, setup.workspace, true)
    expect(await setup.client.agentHostSessions(setup.workspace)).toMatchObject({ sessions: [{ ...setup.target, canSend: true }], warnings: [] })
    await setup.client.connect(setup.workspace, setup.device.id)
    expect(setup.transport).toHaveBeenCalledOnce()
    await expect(setup.client.agentHostTransport(setup.workspace, { ...setup.target, owner: { ...setup.target.owner, machineName: 'Wrong-Owner' } }, new AbortController().signal)).rejects.toThrow('identity does not match')
    await setup.client.disconnectOwner(setup.workspace, setup.target.owner.clientId)
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(false)
    expect(await setup.client.agentHostSessions(setup.workspace)).toEqual({ sessions: [], warnings: [] })
    await expect(setup.client.agentHostTransport(setup.workspace, setup.target, new AbortController().signal)).rejects.toThrow('disabled')
    for (const retired of ['sessions', 'find', 'owner', 'read', 'send', 'open']) expect(setup.client).not.toHaveProperty(retired)
    expect(requests.mock.calls.every((call) => ['/device/identity', '/device/agent-host/sessions'].includes(call[3]))).toBe(true)
  })

  it('preserves archived catalog data and histories without reading or migrating their sessions', async () => {
    const setup = await fixture()
    setup.client.close()
    const file = join(setup.profile, 'remote-vscode-devices.json')
    const archived = [{ id: randomUUID(), invitation: { unsupportedLegacySession: 'preserve only' } }]
    const enrolled = JSON.parse(protector.decrypt(Buffer.from(JSON.parse(await readFile(file, 'utf8')).encrypted, 'base64')))
    enrolled[0].known = archived
    const saved = JSON.stringify({ encrypted: protector.encrypt(JSON.stringify(enrolled)).toString('base64') })
    await writeFile(file, saved)
    const historyDirectory = join(setup.profile, 'remote-vscode-device-cache')
    await mkdir(historyDirectory)
    const historyFile = join(historyDirectory, `${archived[0].id}.json`)
    await writeFile(historyFile, 'Retired historical data remains untouched.')
    const restarted = new VSCodeDeviceClient(setup.profile, protector, setup.transport, setup.validateRecipient)
    cleanup.unshift(async () => { restarted.close() })
    expect(await restarted.list(setup.workspace)).toMatchObject([{ id: setup.device.id, state: 'offline', enabled: false }])
    expect(await readFile(file, 'utf8')).toBe(saved)
    expect(await restarted.agentHostSessions(setup.workspace)).toEqual({ sessions: [], warnings: [] })
    expect(setup.transport).not.toHaveBeenCalled()
    await restarted.import(setup.workspace, setup.invitation)
    const updated = JSON.parse(protector.decrypt(Buffer.from(JSON.parse(await readFile(file, 'utf8')).encrypted, 'base64')))
    expect(updated[0]).toMatchObject({ id: setup.device.id, invitation: setup.invitation, known: archived })
    await restarted.forget(setup.workspace, setup.device.id)
    expect(await restarted.list(setup.workspace)).toEqual([])
    expect(await readFile(historyFile, 'utf8')).toBe('Retired historical data remains untouched.')
  })

  it('rejects per-session invitations and changed owner identities without replacing enrollment', async () => {
    const setup = await fixture()
    const file = join(setup.profile, 'remote-vscode-devices.json')
    const saved = await readFile(file, 'utf8')
    await expect(setup.client.import(setup.workspace, { schemaVersion: 1, provider: 'vscode-copilot', identity: { nativeSessionId: 'legacy' } })).rejects.toThrow('Legacy per-session invitations cannot be imported')
    await expect(setup.client.import(setup.workspace, { ...setup.invitation, ownerClientId: randomUUID() })).rejects.toThrow('owner identity changed')
    await expect(setup.client.import(setup.workspace, { ...setup.invitation, devTunnel: { ...setup.invitation.devTunnel, hostPublicKey: newSshKeyPair().publicKey } })).rejects.toThrow('host key changed')
    await expect(setup.client.import(setup.workspace, { ...setup.invitation, participant: { ...setup.invitation.participant, clientId: randomUUID() } })).rejects.toThrow('Wrong device identity')
    expect(await readFile(file, 'utf8')).toBe(saved)
    expect(setup.transport).not.toHaveBeenCalled()
  })

  it.each(['owner', 'pair'])('fails closed on a mismatched %s during identity-only connection', async (changed) => {
    const setup = await fixture()
    vi.spyOn(deviceHttp, 'deviceRequest').mockResolvedValueOnce({
      ownerId: changed === 'owner' ? randomUUID() : setup.invitation.ownerId,
      deviceId: changed === 'pair' ? randomUUID() : setup.invitation.id,
    })
    await expect(setup.client.connect(setup.workspace, setup.device.id)).rejects.toThrow('Device identity changed')
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(false)
    expect(await setup.client.list(setup.workspace)).toMatchObject([{ state: 'offline', error: 'Device identity changed.' }])
  })

  it('waits for pinned identity before native discovery and cannot reconnect after late cancellation', async () => {
    const setup = await fixture()
    let complete!: (value: unknown) => void
    const response = new Promise<unknown>((resolve) => { complete = resolve })
    const requests = vi.spyOn(deviceHttp, 'deviceRequest').mockImplementationOnce(() => response)
    const connected = expect(setup.client.connect(setup.workspace, setup.device.id)).rejects.toThrow('changed')
    await vi.waitFor(() => expect(requests).toHaveBeenCalledOnce())
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(false)
    const catalog = setup.client.agentHostSessions(setup.workspace)
    await setup.client.disconnect(setup.workspace, setup.device.id)
    complete({ ownerId: setup.invitation.ownerId, deviceId: setup.invitation.id })
    await connected
    expect(await catalog).toMatchObject({ sessions: [] })
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(false)
    expect(await setup.client.list(setup.workspace)).toMatchObject([{ state: 'offline', enabled: false }])
    expect(requests.mock.calls.map((call) => call[3])).toEqual(['/device/identity'])
    expect(setup.transport).toHaveBeenCalledOnce()
  })

  it('honors owner revocation on the same device connection without reconnecting to a legacy route', async () => {
    const setup = await fixture()
    const requests = vi.spyOn(deviceHttp, 'deviceRequest')
    await setup.client.connect(setup.workspace, setup.device.id)
    await setup.host.revoke(setup.invitation.id)
    await expect(setup.client.connect(setup.workspace, setup.device.id)).rejects.toMatchObject({ status: 403 })
    expect(await setup.client.ownerConnected(setup.workspace, setup.target.owner.clientId)).toBe(false)
    expect(requests.mock.calls.map((call) => call[3])).toEqual(['/device/identity', '/device/identity'])
    expect(setup.transport).toHaveBeenCalledOnce()
  })
})
