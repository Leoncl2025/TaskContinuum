// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { FileTransferSource } from '../src/main/fileTransferSource'
import { FileTransferService } from '../src/main/fileTransferService'
import { fileDeviceRequest } from '../src/main/fileTransferHttp'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { FILE_TRANSFER_LIMITS, transferStatusSchema } from '../src/shared/fileTransfer'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import type { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'
import { startAgentHostDiagnostics, logAgentHostDiagnostic, stopAgentHostDiagnostics } from '../src/main/agentHostDiagnostics'
import { startFileTransferMcpBridge } from '../src/main/fileTransferMcpBridge'
import { createFileTransferMcpServer } from '../src/main/fileTransferMcp/server'
import { createBridgeApi } from '../src/main/fileTransferMcp/client'

const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-file-devices-'))
  const workspace = join(root, 'workspace')
  const sourceProfile = join(root, 'source')
  const receiverProfile = join(root, 'receiver')
  await mkdir(workspace)
  const source = new FileTransferSource(sourceProfile, 'test-build')
  const local = new FileTransferSource(receiverProfile, 'test-build')
  const host = new VSCodeDeviceHost(sourceProfile, protector)
  host.setFileTransferSource(source)
  const ssh = await startSessionSshHost(newSshKeyPair())
  const key = newSshKeyPair()
  const participant = { clientId: randomUUID(), machineName: 'Receiver-B', username: 'FixtureUser' }
  const owner = { clientId: randomUUID(), machineName: 'Source-A' }
  const native = await startAgentHostFixture()
  const target = { owner, sessionId: native.sessionId, chatId: native.chatId }
  const chat = new AgentHostConnection(target, sourceProfile, (signal) => connectLocalAgentHost(native.endpoint, signal))
  cleanups.push(async () => {
    await host.close()
    await ssh.close()
    await source.close()
    await local.close()
    await chat.close()
    await native.close()
    await rm(root, { recursive: true, force: true })
  })
  host.setAgentHostAccess({ connection: async () => chat } as unknown as AgentHostRegistry, async () => [target])
  const pair = await host.pair(participant, key.publicKey)
  await host.setWorkspace(pair.id, workspace, false)
  const port = await host.start()
  ssh.allow(pair.id, key.publicKey, port, pair.expiresAt, true)
  const client = new VSCodeDeviceClient(receiverProfile, protector, (invitation, signal) => openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), {
    key, hostPublicKey: invitation.devTunnel.hostPublicKey, grantId: invitation.id, targetPort: invitation.port, signal,
  }), async (invitation) => {
    if (invitation.participant.clientId !== participant.clientId || invitation.participant.machineName !== participant.machineName
      || invitation.participant.username !== participant.username || invitation.devTunnel.clientPublicKey !== key.publicKey) throw new Error('Wrong recipient.')
  })
  cleanups.push(async () => { client.close() })
  await client.import(workspace, deviceInvitationSchema.parse({
    schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id,
    ownerId: await host.ownerId(), ownerClientId: owner.clientId, machineName: owner.machineName,
    participant, token: pair.token, expiresAt: pair.expiresAt, port,
    devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'f'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: key.publicKey },
  }), true)
  const device = (await client.list(workspace))[0]
  const service = new FileTransferService(receiverProfile, local, client)
  cleanups.push(() => service.close())
  return { root, workspace, sourceProfile, receiverProfile, source, host, pair, port, device, client, service, target, native, api: service.forWorkspace(workspace) }
}

describe('trusted-device file transfers', () => {
  it('lets an MCP agent collect a paired source log through the local bridge and private SSH', async () => {
    const setup = await fixture()
    await startAgentHostDiagnostics(setup.sourceProfile)
    const bridge = await startFileTransferMcpBridge(setup.receiverProfile, (root) => setup.service.forWorkspace(root))
    const server = createFileTransferMcpServer(createBridgeApi(setup.receiverProfile, setup.workspace))
    const agent = new Client({ name: 'file-agent-integration', version: '1.0.0' })
    const [agentTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await agent.connect(agentTransport)
      logAgentHostDiagnostic('connection.heartbeat', { status: 'ok', elapsedMs: 22 })
      const requestId = randomUUID()
      const started = await agent.callTool({ name: 'tc_logs_collect', arguments: { deviceId: setup.device.id, requestId, source: 'agent-host' } })
      expect(started.isError).toBe(false)
      const status = z.object({ result: transferStatusSchema })
      await expect.poll(async () => status.parse((await agent.callTool({ name: 'tc_files_status', arguments: { transferId: requestId } })).structuredContent).result.state).toBe('delivered')
      const delivered = status.parse((await agent.callTool({ name: 'tc_files_status', arguments: { transferId: requestId } })).structuredContent).result
      let logs = ''
      for (const file of delivered.files) {
        const page = await agent.callTool({ name: 'tc_files_read', arguments: { transferId: requestId, fileId: file.fileId } })
        expect(page.isError).toBe(false)
        logs += z.object({ result: z.object({ text: z.string() }), untrustedContent: z.literal(true) }).parse(page.structuredContent).result.text
      }
      expect(logs).toContain('connection.heartbeat')
      expect(logs).not.toContain(setup.pair.token)
      expect(logs).not.toContain(setup.sourceProfile)
      expect(setup.native.dispatches).toHaveLength(0)
    } finally {
      await agent.close()
      await server.close()
      await bridge.close()
      await stopAgentHostDiagnostics()
    }
  }, 20_000)

  it('pulls a multichunk file over paired SSH, without chat send permission or native execution', async () => {
    const setup = await fixture()
    const content = 'verified file data\n'.repeat(30_000)
    const path = join(setup.root, 'external-report.txt')
    await writeFile(path, content)
    expect(await setup.api.devices()).toContainEqual(expect.objectContaining({ deviceId: setup.device.id, fileTransfer: 'available' }))
    const started = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [path] } })
    await expect.poll(async () => (await setup.api.status(started.transferId)).state, { timeout: 10_000 }).toBe('delivered')
    const delivered = await setup.api.status(started.transferId)
    expect(delivered.receivedBytes).toBe(Buffer.byteLength(content))
    expect(delivered.files[0].name).toBe('external-report.txt')
    const page = await setup.api.read({ transferId: delivered.transferId, fileId: delivered.files[0].fileId, offset: 0, maxBytes: 19 })
    expect(page.text).toBe('verified file data\n')
    expect(setup.native.dispatches).toHaveLength(0)
    await setup.host.revoke(setup.pair.id)
    await expect(setup.api.read({ transferId: delivered.transferId, fileId: delivered.files[0].fileId, offset: 0, maxBytes: 18 })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await setup.api.cancel(delivered.transferId)).state).toBe('cancelled')
  }, 20_000)

  it('collects diagnostic logs from the source profile with a UTC filter and never sends a prompt', async () => {
    const setup = await fixture()
    await startAgentHostDiagnostics(setup.sourceProfile)
    try {
      logAgentHostDiagnostic('connection.send', { status: 'ok', step: 'confirmation', elapsedMs: 123, dispatched: true })
      const started = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'logs', source: 'agent-host', sinceUtc: new Date(Date.now() - 60_000).toISOString() } })
      await expect.poll(async () => (await setup.api.status(started.transferId)).state, { timeout: 10_000 }).toBe('delivered')
      const delivered = await setup.api.status(started.transferId)
      let output = ''
      for (const file of delivered.files) output += (await setup.api.read({ transferId: delivered.transferId, fileId: file.fileId, offset: 0, maxBytes: 32768 })).text
      expect(output).toContain('connection.send')
      expect(output).toContain('123')
      expect(output).not.toContain(setup.pair.token)
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { await stopAgentHostDiagnostics() }
  }, 20_000)

  it('resumes the same immutable snapshot after the paired transport disconnects mid-file', async () => {
    const setup = await fixture()
    const path = join(setup.root, 'resume.log')
    await writeFile(path, Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes * 3, 82))
    const original = setup.source.chunk.bind(setup.source)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    const calls = vi.spyOn(setup.source, 'chunk')
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args) })
    const started = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [path] } })
    try {
      await blocked
      await setup.client.disconnect(setup.workspace, setup.device.id)
      release()
      await setup.client.connect(setup.workspace, setup.device.id)
      await expect.poll(async () => (await setup.api.status(started.transferId)).state).toBe('interrupted')
      expect((await setup.api.status(started.transferId)).receivedBytes).toBe(FILE_TRANSFER_LIMITS.chunkBytes)
      await setup.api.resume(started.transferId)
      await expect.poll(async () => (await setup.api.status(started.transferId)).state, { timeout: 10_000 }).toBe('delivered')
      expect(calls.mock.calls.map((call) => call[3])).toEqual([0, FILE_TRANSFER_LIMITS.chunkBytes, FILE_TRANSFER_LIMITS.chunkBytes, FILE_TRANSFER_LIMITS.chunkBytes * 2])
    } finally { release() }
  }, 20_000)

  it('cancels an active transfer without publishing a partial file or losing the chat connection', async () => {
    const setup = await fixture()
    const path = join(setup.root, 'cancel.log')
    await writeFile(path, Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes * 2, 88))
    const original = setup.source.chunk.bind(setup.source)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(setup.source, 'chunk').mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args) })
    const started = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [path] } })
    try {
      await blocked
      const cancelling = setup.api.cancel(started.transferId)
      release()
      const status = await cancelling
      expect(status.state).toBe('cancelled')
      expect(status.receivedBytes).toBe(0)
      await expect(setup.api.read({ transferId: status.transferId, fileId: status.files[0].fileId, offset: 0, maxBytes: 16 })).rejects.toMatchObject({ code: 'CANCELLED' })
      expect((await setup.api.devices()).find((device) => device.deviceId === setup.device.id)?.fileTransfer).toBe('available')
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { release() }
  }, 20_000)

  it('keeps native model requests and ping responsive during a file transfer', async () => {
    const setup = await fixture()
    const path = join(setup.root, 'large.txt')
    await writeFile(path, Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes * 12, 65))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = setup.source.chunk.bind(setup.source)
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(setup.source, 'chunk').mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args) })
    const abort = new AbortController()
    const chat = new AhpClient(await setup.client.agentHostTransport(setup.workspace, setup.target, abort.signal), { requestTimeoutMs: 15000 })
    chat.connect()
    try {
      await chat.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      const started = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [path] } })
      await blocked
      const before = performance.now()
      await Promise.all([chat.ping(), chat.subscribe('ahp-root://')])
      expect(performance.now() - before).toBeLessThan(15_000)
      expect((await setup.api.status(started.transferId)).state).toBe('transferring')
      release()
      await expect.poll(async () => (await setup.api.status(started.transferId)).state, { timeout: 10_000 }).toBe('delivered')
    } finally { release(); abort.abort(); await chat.shutdown() }
  }, 20_000)

  it('rejects another pair reading a snapshot, application credentials, unauthenticated requests and disabled peers', async () => {
    const setup = await fixture()
    const path = join(setup.root, 'test.log')
    await writeFile(path, 'private log for paired device')
    const manifest = await setup.source.prepare(setup.pair.id, { transferId: randomUUID(), selection: { kind: 'files', paths: [path] } }, async () => {}, new AbortController().signal)
    const stranger = await setup.host.pair({ clientId: randomUUID(), machineName: 'Other', username: 'OtherUser' }, newSshKeyPair().publicKey)
    await setup.host.setWorkspace(stranger.id, setup.workspace, true)
    await expect(fileDeviceRequest(setup.port, setup.port, stranger.token, 'chunk',
      { transferId: manifest.transferId, fileId: manifest.files[0].fileId, offset: 0 }, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/ACCESS_DENIED|NOT_FOUND/) })
    await expect(fileDeviceRequest(setup.port, setup.port, 'wrong', 'capabilities', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const secret = await setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [join(setup.sourceProfile, 'remote-vscode-device-host.json')] } })
    await expect.poll(async () => (await setup.api.status(secret.transferId)).state).toBe('failed')
    expect((await setup.api.status(secret.transferId)).error?.code).toBe('ACCESS_DENIED')
    await setup.client.disconnect(setup.workspace, setup.device.id)
    await expect(setup.api.fetch({ requestId: randomUUID(), deviceId: setup.device.id, selection: { kind: 'files', paths: [path] } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  }, 20_000)
})
