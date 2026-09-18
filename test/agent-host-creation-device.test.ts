// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import type { AgentHostCreateRequest, AgentHostCreationResult } from '../src/shared/agentHostCreation'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-create-device-'))
  const owner = { clientId: randomUUID(), machineName: 'Worker-B' }
  const ownerId = randomUUID(), pairId = randomUUID()
  const request: AgentHostCreateRequest = { operationId: randomUUID(), workerId: randomUUID(), workspaceId: 'b'.repeat(64), taskId: 'T-0007', hostId: 'native-host-123', expectedRevision: null }
  const sessionId = `copilotcli:/${randomUUID()}`
  const result: AgentHostCreationResult = { operationId: request.operationId, workspaceId: request.workspaceId, taskId: request.taskId, hostId: request.hostId, state: 'ready',
    session: { sessionId, chatId: `ahp-chat://default/${Buffer.from(sessionId).toString('base64url')}`, owner, title: 'Created session', provider: 'copilotcli', updatedAt: new Date().toISOString(), canSend: true } }
  const catalog = { ownerId, deviceId: pairId, owner, hosts: [{ hostId: request.hostId, name: 'Copilot', available: true }],
    workspaces: [{ id: request.workspaceId, name: 'Worker workspace', canSend: true, taskState: 'available', expectedRevision: null }] }
  const requests: { path: string; body: Record<string, unknown> }[] = []
  let responseStatus = 200
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(chunk)
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString())
      const path = incoming.url ?? ''
      requests.push({ path, body })
      outgoing.writeHead(responseStatus, { 'Content-Type': 'application/json' })
      outgoing.end(JSON.stringify(path === '/device/identity' ? { ownerId, deviceId: pairId } : path === '/device/agent-host/workers' ? catalog : result))
    })().catch((error: unknown) => { outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.message : 'Fixture request failed') })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not open a TCP port.')
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const transport = vi.fn(async () => ({ port: address.port, close: () => {} }))
  const validateRecipient = vi.fn(async () => {})
  const client = new VSCodeDeviceClient(join(root, 'profile'), protector, transport, validateRecipient)
  cleanup.push(async () => { client.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const key = newSshKeyPair()
  await client.import(root, deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pairId, ownerId, ownerClientId: owner.clientId, machineName: owner.machineName,
    participant: { clientId: randomUUID(), username: 'Alice', machineName: 'Client-A' }, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 86400000).toISOString(), port: address.port,
    devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'f'.repeat(32)}.jpe1`, sshPort: address.port, hostPublicKey: key.publicKey, clientPublicKey: key.publicKey } }), true)
  const workers = await client.agentHostWorkers(root, request.taskId)
  request.workerId = workers[0].id
  return { root, client, workers, owner, request, result, catalog, requests, transport, validateRecipient, status: (status: number) => { responseStatus = status } }
}

describe('paired device creation transport', () => {
  it('discovers a worker with no existing sessions without querying the legacy session catalog', async () => {
    const setup = await fixture()
    expect(setup.workers).toMatchObject([{ owner: setup.owner, state: 'connected', workspaces: [{ canSend: true, taskState: 'available' }] }])
    expect(setup.requests.map((request) => request.path)).toEqual(['/device/identity', '/device/agent-host/workers'])
    expect(setup.transport).toHaveBeenCalledOnce()
  })

  it('uses only narrow create/status/bind commands with pinned identity and one connection', async () => {
    const setup = await fixture()
    const authorize = vi.fn(async () => {})
    const created = await setup.client.agentHostCreate(setup.root, setup.request, authorize)
    expect(created).toEqual({ ...setup.result, workerId: setup.request.workerId })
    await setup.client.agentHostCreationStatus(setup.root, setup.request, authorize)
    await setup.client.agentHostBindCreation(setup.root, setup.request, 'c'.repeat(64), authorize)
    expect(setup.requests.map((request) => request.path)).toEqual(['/device/identity', '/device/agent-host/workers', '/device/agent-host/create', '/device/agent-host/creation-status', '/device/agent-host/creation-bind'])
    expect(setup.requests[2].body).toEqual({ operationId: setup.request.operationId, taskId: 'T-0007', workspaceId: setup.request.workspaceId, hostId: setup.request.hostId, expectedRevision: null })
    expect(setup.requests[3].body).toEqual({ operationId: setup.request.operationId, workspaceId: setup.request.workspaceId })
    expect(setup.requests[4].body.expectedRevision).toBe('c'.repeat(64))
    expect(setup.transport).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledTimes(3)
  })

  it.each(['operation', 'owner', 'provider'])('rejects a mismatched %s from the worker without replay', async (changed) => {
    const setup = await fixture()
    if (changed === 'operation') setup.result.operationId = randomUUID()
    if (changed === 'owner') setup.result.session!.owner = { ...setup.owner, clientId: randomUUID() }
    if (changed === 'provider') setup.result.session!.provider = 'unverified-provider'
    await expect(setup.client.agentHostCreate(setup.root, setup.request, async () => {})).rejects.toThrow()
    expect(setup.requests.filter((request) => request.path.endsWith('/create'))).toHaveLength(1)
  })

  it('does not dispatch after the source device is disconnected during preparation', async () => {
    const setup = await fixture()
    await expect(setup.client.agentHostCreate(setup.root, setup.request, () => setup.client.disconnect(setup.root, setup.request.workerId))).rejects.toThrow('changed')
    expect(setup.requests.filter((request) => request.path.endsWith('/create'))).toEqual([])
  })

  it('rejects a worker from a different caller workspace', async () => {
    const setup = await fixture()
    const other = join(setup.root, 'other-workspace')
    await mkdir(other)
    await expect(setup.client.agentHostCreate(other, setup.request, async () => {})).rejects.toThrow('does not belong')
    expect(setup.requests.filter((request) => request.path.endsWith('/create'))).toEqual([])
  })

  it('surfaces unsupported worker APIs and source authorization errors', async () => {
    const setup = await fixture()
    setup.status(404)
    expect((await setup.client.agentHostWorkers(setup.root, setup.request.taskId))[0]).toMatchObject({ state: 'unsupported', workspaces: [], error: expect.stringContaining('does not support') })
    setup.status(403)
    await expect(setup.client.agentHostCreate(setup.root, setup.request, async () => {})).rejects.toThrow('send permission')
  })
})
