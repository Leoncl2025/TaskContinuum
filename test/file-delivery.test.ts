// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FileDeliveryService } from '../src/main/fileDeliveryService'
import { FileTransferService } from '../src/main/fileTransferService'
import { FileTransferSource } from '../src/main/fileTransferSource'
import { FileTransferBudget } from '../src/main/fileTransferBudget'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { readClientIdentity } from '../src/main/clientIdentity'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { startFileTransferMcpBridge } from '../src/main/fileTransferMcpBridge'
import { deliveryChunkSchema, deliveryDestinationSchema, deliveryInboxSchema, savedReceivedFileSchema } from '../src/shared/fileDelivery'
import type { DeliveryApi } from '../src/shared/fileDelivery'
import { FILE_TRANSFER_LIMITS, FileTransferError, transferStatusSchema } from '../src/shared/fileTransfer'
import type { FileTransferApi } from '../src/shared/fileTransfer'
import * as storage from '../src/main/shared/storage'
import { fileDeviceRequest } from '../src/main/fileTransferHttp'

const execute = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
const protector = { available: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (data: Buffer) => data.toString() }
function delivery(api: FileTransferApi): DeliveryApi {
  if (!api.delivery) throw new Error('Expected the delivery API.')
  return api.delivery
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tc-mcp-delivery-'))
  const workspaceA = join(root, 'workspace-a')
  const workspaceB = join(root, 'workspace-b')
  const destination = join(root, 'saved-files')
  await Promise.all([workspaceA, workspaceB, destination].map((path) => mkdir(path)))
  const profileA = join(root, 'profile-a'), profileB = join(root, 'profile-b')
  const identityA = await readClientIdentity(profileA), identityB = await readClientIdentity(profileB)
  let sourceA = new FileTransferSource(profileA, 'test')
  const sourceB = new FileTransferSource(profileB, 'test')
  const budgetA = new FileTransferBudget(), budgetB = new FileTransferBudget()
  const host = new VSCodeDeviceHost(profileB, protector)
  host.setFileTransferSource(sourceB, budgetB)
  const reverseRequest = vi.fn<VSCodeDeviceClient['fileRequest']>(async () => { throw new Error('Receiving uploads must not require a reverse pairing.') })
  const receiverDevices: Pick<VSCodeDeviceClient, 'fileDevices' | 'fileRequest' | 'fileDeviceKey'> = {
    fileDevices: async () => [], fileRequest: reverseRequest,
    fileDeviceKey: async () => { throw new Error('Receiving must not resolve a reverse connection.') },
  }
  const ssh = await startSessionSshHost(newSshKeyPair())
  const key = newSshKeyPair()
  const pair = await host.pair(identityA, key.publicKey)
  await host.setWorkspace(pair.id, workspaceB, false)
  let filesB: FileTransferService
  let runtimeB: FileDeliveryService
  function receiver() {
    filesB = new FileTransferService(profileB, sourceB, receiverDevices, budgetB, (root, sender) => runtimeB.authorizeIncoming(root, sender))
    runtimeB = new FileDeliveryService(profileB, filesB, sourceB, receiverDevices, {
      identity: async () => identityB, senders: (root) => host.fileSenders(root),
      authorizeSender: (root, pairId, clientId) => host.authorizeFileSender(root, pairId, clientId),
    }, budgetB)
  }
  receiver()
  host.setFileDeliveryService({
    targets: (pairId, clientId) => runtimeB.targets(pairId, clientId),
    receive: (pairId, clientId, method, value, bytes) => runtimeB.receive(pairId, clientId, method, value, bytes),
  })
  const port = await host.start()
  ssh.allow(pair.id, key.publicKey, port, pair.expiresAt)
  const devices = new VSCodeDeviceClient(profileA, protector,
    (invitation, signal) => openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), {
      key, hostPublicKey: invitation.devTunnel.hostPublicKey, grantId: invitation.id, targetPort: invitation.port, signal,
    }), async (invitation) => {
      if (invitation.participant.clientId !== identityA.clientId) throw new Error('Wrong MCP host identity.')
    })
  await devices.import(workspaceA, deviceInvitationSchema.parse({
    schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(),
    ownerClientId: identityB.clientId, machineName: identityB.machineName, participant: identityA,
    token: pair.token, expiresAt: pair.expiresAt, port,
    devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'f'.repeat(32)}.jpe1`,
      sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: key.publicKey },
  }), true)
  const deviceId = (await devices.list(workspaceA))[0].id
  let filesA: FileTransferService
  let runtimeA: FileDeliveryService
  function sender() {
    filesA = new FileTransferService(profileA, sourceA, devices, budgetA, (root, sender) => runtimeA.authorizeIncoming(root, sender))
    runtimeA = new FileDeliveryService(profileA, filesA, sourceA, devices, {
      identity: async () => identityA, senders: async () => [],
      authorizeSender: async () => { throw new FileTransferError('ACCESS_DENIED', 'This fixture has no reverse pairing.') },
    }, budgetA)
  }
  sender()
  cleanups.push(async () => {
    await runtimeA.close(); await filesA.close()
    await runtimeB.close(); await filesB.close()
    devices.close()
    await host.close(); await ssh.close()
    await sourceA.close(); await sourceB.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return {
    root, workspaceA, workspaceB, destination, profileA, profileB, identityA, identityB, deviceId, devices, reverseRequest,
    get apiA() { return runtimeA.forWorkspace(workspaceA) },
    get apiB() { return runtimeB.forWorkspace(workspaceB) },
    get runtimeB() { return runtimeB },
    async allow() { await runtimeB.setSender(workspaceB, identityA.clientId, true) },
    async restart() {
      await runtimeA.close(); await filesA.close(); await sourceA.close()
      await runtimeB.close(); await filesB.close()
      sourceA = new FileTransferSource(profileA, 'test')
      receiver(); sender()
    },
  }
}

async function startSend(setup: Awaited<ReturnType<typeof fixture>>, paths: string[]) {
  const targets = await delivery(setup.apiA).destinations(setup.deviceId)
  expect(targets).toHaveLength(1)
  expect(targets[0].clientId).toBe(setup.identityB.clientId)
  const request = { requestId: randomUUID(), targetDeviceId: setup.deviceId, targetInboxId: targets[0].inboxId, paths }
  return { request, status: await delivery(setup.apiA).send(request) }
}

async function connectAgent(profile: string, workspace: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('out', 'cli', 'taskcontinuum-files-mcp.cjs')], stderr: 'pipe',
    env: { TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_MCP_FEATURES: 'delivery' },
  })
  let stderr = ''
  transport.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
  const client = new Client({ name: 'file-delivery-agent', version: '1' })
  cleanups.push(() => client.close())
  await client.connect(transport)
  return { client, stderr: () => stderr }
}

describe('runtime MCP file delivery', () => {
  it('reports an older device without the delivery endpoint as unsupported instead of treating it as a missing transfer', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'File transfer operation not found.' } }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected the compatibility fixture port.')
    await expect(fileDeviceRequest(address.port, address.port, 'test-only', 'delivery/targets', {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
  it('uses a real stdio client and one-way paired SSH to deliver binary files, discover them, and save without overwriting', async () => {
    const setup = await fixture()
    expect(setup.identityA.machineName).toBe(setup.identityB.machineName)
    expect(setup.identityA.clientId).not.toBe(setup.identityB.clientId)
    expect(await delivery(setup.apiA).destinations(setup.deviceId)).toEqual([])
    await setup.allow()
    await setup.runtimeB.addDestination(setup.workspaceB, setup.destination)
    const bytes = randomBytes(FILE_TRANSFER_LIMITS.chunkBytes * 2 + 17)
    const path = join(setup.root, 'artifact.bin')
    await writeFile(path, bytes)
    const empty = join(setup.root, 'empty.bin')
    await writeFile(empty, '')
    const bridgeA = await startFileTransferMcpBridge(setup.profileA, () => setup.apiA)
    const bridgeB = await startFileTransferMcpBridge(setup.profileB, () => setup.apiB)
    cleanups.push(() => bridgeA.close(), () => bridgeB.close())
    await execute(process.execPath, [resolve('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.cli.config.ts'], { maxBuffer: 1024 * 1024 })
    const sender = await connectAgent(setup.profileA, setup.workspaceA)
    const targetResult = await sender.client.callTool({ name: 'tc_files_destinations', arguments: { deviceId: setup.deviceId } })
    const targets = z.object({ result: z.array(deliveryDestinationSchema) }).parse(targetResult.structuredContent).result
    const request = { requestId: randomUUID(), targetDeviceId: setup.deviceId, targetInboxId: targets[0].inboxId, paths: [path, empty] }
    const accepted = await sender.client.callTool({ name: 'tc_files_send', arguments: request })
    expect(accepted.isError).toBe(false)
    expect(z.object({ result: transferStatusSchema }).parse(accepted.structuredContent).result.transferId).toBe(request.requestId)
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state, { timeout: 10_000 }).toBe('delivered')
    const sent = await setup.apiA.status(request.requestId)
    expect(sent.receivedBytes).toBe(bytes.length)
    expect(sent.files).toHaveLength(2)
    expect(await delivery(setup.apiA).send(request)).toEqual(sent)
    await expect(delivery(setup.apiA).send({ ...request, paths: [path, path] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const receiver = await connectAgent(setup.profileB, setup.workspaceB)
    const client = receiver.client
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('tc_files_send')
    expect(tools).toContain('tc_files_save')
    const listed = await client.callTool({ name: 'tc_files_inbox_list', arguments: {} })
    const inbox = z.object({ result: deliveryInboxSchema }).parse(listed.structuredContent).result
    expect(inbox.transfers).toHaveLength(1)
    expect(inbox.transfers[0]).toMatchObject({ transferId: request.requestId, state: 'delivered' })
    expect(inbox.destinations).toHaveLength(1)
    const savedResult = await client.callTool({ name: 'tc_files_save', arguments: {
      transferId: request.requestId, fileId: sent.files[0].fileId, destinationRootId: inbox.destinations[0].id, relativePath: 'received.bin',
    } })
    const saved = z.object({ result: savedReceivedFileSchema }).parse(savedResult.structuredContent).result
    expect(await readFile(saved.path)).toEqual(bytes)
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const saveRequest = { transferId: request.requestId, fileId: sent.files[0].fileId, destinationRootId: inbox.destinations[0].id, relativePath: 'received.bin' }
    await expect(delivery(setup.apiB).save(saveRequest)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(await readFile(saved.path)).toEqual(bytes)
    await expect(delivery(setup.apiB).save({ ...saveRequest, relativePath: '..\\escaped.bin' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(delivery(setup.apiB).save({ ...saveRequest, relativePath: '.git\\hooks\\new-hook' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await setup.runtimeB.removeDestination(setup.workspaceB, inbox.destinations[0].id)
    await expect(delivery(setup.apiB).save({ ...saveRequest, relativePath: 'another.bin' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(setup.reverseRequest).not.toHaveBeenCalled()
    expect(sender.stderr()).toBe('')
    expect(receiver.stderr()).toBe('')
  }, 90_000)

  it('resumes only missing bytes after both service states restart and keeps the original immutable source snapshot', async () => {
    const setup = await fixture()
    await setup.allow()
    const bytes = randomBytes(FILE_TRANSFER_LIMITS.chunkBytes * 3 + 9)
    const path = join(setup.root, 'resume.bin')
    await writeFile(path, bytes)
    const original = setup.devices.fileRequest.bind(setup.devices)
    let interrupted = false
    const offsets: number[] = []
    const sizes: number[] = []
    vi.spyOn(setup.devices, 'fileRequest').mockImplementation(async (root, id, route, value, signal) => {
      if (route === 'delivery/chunk') {
        const chunk = deliveryChunkSchemaForTest(value)
        offsets.push(chunk.offset)
        sizes.push(chunk.data.length)
        const result = await original(root, id, route, value, signal)
        if (!interrupted) { interrupted = true; throw new FileTransferError('UNAVAILABLE', 'Lost the chunk acknowledgement.') }
        return result
      }
      return original(root, id, route, value, signal)
    })
    const { request } = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state).toBe('interrupted')
    await setup.restart()
    expect((await setup.apiA.status(request.requestId)).state).toBe('interrupted')
    const receiver = await delivery(setup.apiB).inbox({ limit: 20 })
    expect(receiver.transfers[0].state).toBe('interrupted')
    await writeFile(path, 'The original file changed after capture.')
    await setup.apiA.resume(request.requestId)
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state, { timeout: 10_000 }).toBe('delivered')
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(sizes[0])
    expect(sizes[1]).toBeLessThan(sizes[0])
    expect(offsets.filter((offset) => offset === 0)).toHaveLength(1)
    await setup.runtimeB.addDestination(setup.workspaceB, setup.destination)
    const inbox = await delivery(setup.apiB).inbox({ limit: 20 })
    const saved = await delivery(setup.apiB).save({
      transferId: request.requestId, fileId: inbox.transfers[0].files[0].fileId, destinationRootId: inbox.destinations[0].id, relativePath: 'resumed.bin',
    })
    expect(await readFile(saved.path)).toEqual(bytes)
  }, 30_000)

  it('recovers a lost final commit acknowledgement without publishing another delivery', async () => {
    const setup = await fixture()
    await setup.allow()
    const path = join(setup.root, 'commit.txt')
    await writeFile(path, 'A verified receipt, not a second file.')
    const original = setup.devices.fileRequest.bind(setup.devices)
    let lost = false
    vi.spyOn(setup.devices, 'fileRequest').mockImplementation(async (root, id, route, value, signal) => {
      const result = await original(root, id, route, value, signal)
      if (route === 'delivery/commit' && !lost) { lost = true; throw new FileTransferError('UNAVAILABLE', 'Lost final acknowledgement.') }
      return result
    })
    const { request } = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state).toBe('interrupted')
    await setup.apiA.resume(request.requestId)
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state).toBe('delivered')
    const inbox = await delivery(setup.apiB).inbox({ limit: 20 })
    expect(inbox.transfers).toHaveLength(1)
    expect(inbox.transfers[0].transferId).toBe(request.requestId)
    expect(await setup.apiB.read({ transferId: request.requestId, fileId: inbox.transfers[0].files[0].fileId, offset: 0, maxBytes: 32768 }))
      .toMatchObject({ text: 'A verified receipt, not a second file.', eof: true })
  }, 30_000)

  it('stops a revoked sender and never publishes files whose transmitted bytes fail the checksum', async () => {
    const setup = await fixture()
    await setup.allow()
    const path = join(setup.root, 'revoked.bin')
    await writeFile(path, randomBytes(FILE_TRANSFER_LIMITS.chunkBytes * 2 + 1))
    const original = setup.devices.fileRequest.bind(setup.devices)
    let revoked = false
    const spy = vi.spyOn(setup.devices, 'fileRequest').mockImplementation(async (root, id, route, value, signal) => {
      const result = await original(root, id, route, value, signal)
      if (route === 'delivery/chunk' && !revoked) {
        revoked = true
        await setup.runtimeB.setSender(setup.workspaceB, setup.identityA.clientId, false)
      }
      return result
    })
    const first = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(first.request.requestId)).state).toBe('failed')
    expect((await setup.apiA.status(first.request.requestId)).error?.code).toBe('ACCESS_DENIED')
    await setup.allow()
    spy.mockImplementation(async (root, id, route, value, signal) => {
      if (route === 'delivery/chunk') {
        const chunk = deliveryChunkSchemaForTest(value)
        const data = Buffer.from(chunk.data)
        data[0] ^= 1
        return original(root, id, route, { ...chunk, data }, signal)
      }
      return original(root, id, route, value, signal)
    })
    const second = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(second.request.requestId)).state).toBe('failed')
    expect((await setup.apiA.status(second.request.requestId)).error?.code).toBe('INTEGRITY_FAILED')
    const inbox = await delivery(setup.apiB).inbox({ limit: 20 })
    expect(inbox.transfers.every((item) => item.state !== 'delivered')).toBe(true)
    await expect(setup.apiB.read({
      transferId: second.request.requestId, fileId: inbox.transfers.find((item) => item.transferId === second.request.requestId)!.files[0].fileId,
      offset: 0, maxBytes: 10,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  }, 30_000)

  it('rejects private sources, unknown inboxes and directory junctions instead of choosing another client or destination', async () => {
    const setup = await fixture()
    await setup.allow()
    const path = join(setup.profileA, 'protected.txt')
    await writeFile(path, 'Private application data must not be sent.')
    const first = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(first.request.requestId)).state).toBe('failed')
    expect((await setup.apiA.status(first.request.requestId)).error?.code).toBe('ACCESS_DENIED')
    await expect(delivery(setup.apiA).send({ ...first.request, requestId: randomUUID(), targetInboxId: randomUUID() }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const publicFile = join(setup.root, 'public.txt')
    await writeFile(publicFile, 'Only the chosen directory may receive this file.')
    const second = await startSend(setup, [publicFile])
    await expect.poll(async () => (await setup.apiA.status(second.request.requestId)).state).toBe('delivered')
    await setup.runtimeB.addDestination(setup.workspaceB, setup.destination)
    await symlink(setup.workspaceA, join(setup.destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const inbox = await delivery(setup.apiB).inbox({ limit: 20 })
    const received = inbox.transfers.find((item) => item.transferId === second.request.requestId)!
    await expect(delivery(setup.apiB).save({
      transferId: received.transferId, fileId: received.files[0].fileId,
      destinationRootId: inbox.destinations[0].id, relativePath: join('linked', 'escape.txt'),
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  }, 30_000)

  it('can explicitly resume after receiver metadata persistence fails without leaving an orphaned transfer directory', async () => {
    const setup = await fixture()
    await setup.allow()
    const path = join(setup.root, 'disk-space.txt')
    await writeFile(path, 'The same immutable snapshot survives a temporary storage failure.')
    const original = storage.writeJsonAtomic
    let failed = false
    vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (path, value, ...options) => {
      if (!failed && path.startsWith(setup.profileB) && path.endsWith('transfer.json')) {
        failed = true
        throw Object.assign(new Error('Fixture disk full.'), { code: 'ENOSPC' })
      }
      return original(path, value, ...options)
    })
    const { request } = await startSend(setup, [path])
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state).toBe('interrupted')
    await setup.apiA.resume(request.requestId)
    await expect.poll(async () => (await setup.apiA.status(request.requestId)).state).toBe('delivered')
    expect((await delivery(setup.apiB).inbox({ limit: 20 })).transfers).toHaveLength(1)
  }, 30_000)

  it('shares the per-peer transfer slot across agents instead of admitting simultaneous sends to the same client', async () => {
    const setup = await fixture()
    await setup.allow()
    const path = join(setup.root, 'one-peer.txt')
    await writeFile(path, 'Only one active data operation for a physical peer.')
    let release!: () => void
    let entered = false
    const gate = new Promise<void>((done) => { release = done })
    const original = setup.devices.fileRequest.bind(setup.devices)
    vi.spyOn(setup.devices, 'fileRequest').mockImplementation(async (root, id, route, value, signal) => {
      if (route === 'delivery/chunk') { entered = true; await gate }
      return original(root, id, route, value, signal)
    })
    const first = await startSend(setup, [path])
    try {
      await expect.poll(() => entered, { timeout: 10_000 }).toBe(true)
      await expect(delivery(setup.apiA).send({ ...first.request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'BUSY' })
    } finally { release() }
    await expect.poll(async () => (await setup.apiA.status(first.request.requestId)).state, { timeout: 10_000 }).toBe('delivered')
  }, 30_000)

  it('charges incoming delivery reservations against the same receiver storage quota as legacy fetches', async () => {
    const setup = await fixture()
    await setup.allow()
    const [target] = await delivery(setup.apiA).destinations(setup.deviceId)
    for (let index = 0; index < 5; index++) {
      const now = Date.now()
      await setup.devices.fileRequest(setup.workspaceA, setup.deviceId, 'delivery/prepare', { inboxId: target.inboxId, manifest: {
        transferId: randomUUID(), createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + FILE_TRANSFER_LIMITS.retentionMs).toISOString(),
        files: [{ fileId: randomUUID(), name: 'reserved.bin', mediaType: 'application/octet-stream',
          sizeBytes: FILE_TRANSFER_LIMITS.batchBytes, sha256: '0'.repeat(64) }],
      } }, new AbortController().signal)
    }
    const path = join(setup.root, 'small.txt')
    await writeFile(path, 'Small files cannot bypass already reserved storage.')
    await expect(setup.apiB.fetch({ deviceId: 'local', requestId: randomUUID(), selection: { kind: 'files', paths: [path] } }))
      .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  }, 30_000)

  it('does not activate receiving permission until the approved grant is persisted', async () => {
    const setup = await fixture()
    await setup.runtimeB.preferences(setup.workspaceB)
    const original = storage.writeJsonAtomic
    let writing = false
    let finish!: () => void
    const gate = new Promise<void>((done) => { finish = done })
    vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (path, value, ...options) => {
      if (path.startsWith(setup.profileB) && path.endsWith('file-delivery-settings.json')) { writing = true; await gate }
      return original(path, value, ...options)
    })
    const enabling = setup.allow()
    try {
      await expect.poll(() => writing).toBe(true)
      expect(await delivery(setup.apiA).destinations(setup.deviceId)).toEqual([])
    } finally { finish() }
    await enabling
    expect(await delivery(setup.apiA).destinations(setup.deviceId)).toHaveLength(1)
  }, 30_000)
})

function deliveryChunkSchemaForTest(value: unknown) {
  return deliveryChunkSchema.extend({ data: z.instanceof(Buffer) }).parse(value)
}
