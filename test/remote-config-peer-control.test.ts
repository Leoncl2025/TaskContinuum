// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import ssh2 from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRecord } from '../src/shared/remoteConfig'
import type { TunnelCloud } from '../src/main/devTunnel/cloud'
import { DevTunnelCli } from '../src/main/devTunnel/cli'
import { DeviceSshKeys } from '../src/main/devTunnel/identity'
import { ManagedDevTunnels } from '../src/main/devTunnel/manager'
import { sshFingerprint } from '../src/main/devTunnel/protocol'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { createRecord, verifyRecord } from '../src/main/remoteConfig/records'
import {
  callPeer, createPeerRequest, PeerControlError, PeerControlServer, postPeerRequest, signPeerRequest,
  PEER_CONTROL_MAX_AGE_MS, PEER_CONTROL_MAX_BYTES, PEER_CONTROL_PATH, PEER_CONTROL_REPLAY_TTL_MS,
} from '../src/main/remoteConfig/peerControl'
import type { CallPeerOptions, PeerControlRequestBody, PeerControlServerOptions, PeerControlTransport, SignedPeerControlRequest } from '../src/main/remoteConfig/peerControl'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
const timeout = () => AbortSignal.timeout(4000)

async function fixture(overrides: Partial<PeerControlServerOptions> = {}) {
  const hostKey = newSshKeyPair()
  const key = newSshKeyPair()
  const localId = randomUUID()
  const senderId = randomUUID()
  const workspaceId = randomUUID()
  const grant = { id: randomUUID(), expiresAt: new Date(Date.now() + 600000).toISOString() }
  const applied: RemoteRecord[] = []
  const authorize = vi.fn((id: string, publicKey: string) => id === senderId && publicKey === key.publicKey)
  const onLink = vi.fn(() => invitation)
  const onBinding = vi.fn<PeerControlServerOptions['onBinding']>(async (id, payload) => {
    try {
      const trust = {
        workspaceId,
        trustedKey: (actor: { deviceId: string; keyId: string }) => actor.deviceId === id && actor.keyId === sshFingerprint(key.publicKey) ? key.publicKey : undefined,
        authorize: (record: RemoteRecord) => record.actor.deviceId === id,
      }
      const record = await verifyRecord(payload.operation, trust)
      if (record.kind !== 'binding') throw new Error('Not a binding')
      const dependencies = await Promise.all(payload.dependencies.map((dependency: unknown) => verifyRecord(dependency, trust)))
      if (record.parents.some((parent) => !dependencies.some((dependency) => dependency.operationId === parent))) throw new Error('Missing dependency')
      applied.push(record)
      return { workspaceId, operationId: record.operationId, result: 'provisional' }
    } catch { throw new PeerControlError('invalid-payload') }
  })
  const control = new PeerControlServer({ localId, workspaceId, keyPair: hostKey, authorize, onLink, onBinding, ...overrides })
  cleanup.push(() => control.close())
  const { port } = await control.start()
  const host = await startSessionSshHost(hostKey)
  cleanup.push(() => host.close())
  control.allow(grant, senderId, key.publicKey)
  host.allow(grant.id, key.publicKey, port, grant.expiresAt, true)
  const route = { kind: 'dev-tunnel' as const, tunnelId: 'taskcontinuum-test.jpe1', sshPort: host.port, hostPublicKey: hostKey.publicKey, clientPublicKey: key.publicKey }
  const invitation = deviceInvitationSchema.parse({
    schemaVersion: 2, provider: 'vscode-copilot-device', id: randomUUID(), ownerId: localId, ownerClientId: randomUUID(),
    machineName: 'metadata-owner', participant: { clientId: senderId, username: 'metadata-peer', machineName: 'metadata-client' },
    expiresAt: grant.expiresAt, token: randomBytes(32).toString('base64url'), port, devTunnel: route,
  })
  const connect = vi.fn<PeerControlTransport['connect']>(async (selected, grantId, targetPort, signal) => openSessionSshBridge(createConnection(host.port, '127.0.0.1'), {
    key, hostPublicKey: selected.hostPublicKey, grantId, targetPort, signal,
  }))
  const options: CallPeerOptions = {
    workspaceId, local: { deviceId: senderId, keyPair: key },
    recipient: { deviceId: localId, clientPublicKey: hostKey.publicKey, hostPublicKey: hostKey.publicKey },
    grantId: grant.id, expiresAt: grant.expiresAt, route, targetPort: port, transport: { connect },
  }
  const signing = ssh2.utils.parseKey(key.privateKey)
  if (signing instanceof Error || Array.isArray(signing)) throw new Error('Invalid fixture key')
  const sign = (bytes: Buffer) => {
    const result = signing.sign(bytes)
    if (result instanceof Error) throw result
    return result
  }
  const parent = await createRecord({
    kind: 'binding', workspaceId, actor: { deviceId: senderId, keyId: sshFingerprint(key.publicKey) },
    payload: { schemaVersion: 2, action: 'delete', taskId: 'T-0009' },
  }, sign)
  const operation = await createRecord({
    kind: 'binding', workspaceId, actor: { deviceId: senderId, keyId: sshFingerprint(key.publicKey) }, parents: [parent.operationId],
    payload: { schemaVersion: 2, action: 'set', taskId: 'T-0009', target: {
      provider: 'agent-host', sessionId: 'ahp-session:/metadata-test', chatId: 'ahp-chat:/metadata-test',
      owner: { clientId: localId, machineName: 'metadata-owner' },
    } },
  }, sign)
  async function bridge(targetPort = port) {
    const connection = await openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { key, hostPublicKey: hostKey.publicKey, grantId: grant.id, targetPort, signal: timeout() })
    cleanup.push(connection.close)
    return connection
  }
  return { control, host, key, hostKey, port, grant, senderId, localId, workspaceId, options, invitation, authorize, onLink, onBinding, applied, connect, bridge, notification: { operation, dependencies: [parent] } }
}

function resign(request: SignedPeerControlRequest, changes: Partial<PeerControlRequestBody>, key: ReturnType<typeof newSshKeyPair>): SignedPeerControlRequest {
  const body = { ...request, ...changes }
  const { signature: _signature, ...unsigned } = body
  void _signature
  return signPeerRequest(unsigned, key)
}

function rawPost(port: number, body: string, options: { chunked?: boolean; method?: string; path?: string; contentType?: string; origin?: string } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, path: options.path ?? PEER_CONTROL_PATH, method: options.method ?? 'POST',
      agent: false, signal: timeout(), headers: {
        'content-type': options.contentType ?? 'application/json', connection: 'close',
        ...(!options.chunked ? { 'content-length': Buffer.byteLength(body) } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch (error) { reject(error) }
      })
      response.once('error', reject)
    })
    request.once('error', reject)
    if (options.chunked) { request.write(body.slice(0, Math.floor(body.length / 2))); request.end(body.slice(Math.floor(body.length / 2))) }
    else request.end(body)
  })
}

describe('authenticated peer metadata transport', () => {
  it('exchanges a private DeviceInvitation and full signed binding records over real scoped SSH', async () => {
    const peer = await fixture()
    const invitation = await callPeer(peer.options, 'link', {}, timeout())
    expect(deviceInvitationSchema.parse(invitation)).toEqual(peer.invitation)
    expect(peer.connect).toHaveBeenCalledWith(peer.options.route, peer.grant.id, peer.port, expect.any(AbortSignal))
    expect(await callPeer(peer.options, 'binding.changed', peer.notification, timeout())).toEqual({
      workspaceId: peer.workspaceId, operationId: peer.notification.operation.operationId, result: 'provisional',
    })
    expect(peer.applied).toEqual([peer.notification.operation])
    expect(peer.onLink).toHaveBeenCalledTimes(1)
    expect(peer.onBinding).toHaveBeenCalledWith(peer.senderId, peer.notification, expect.any(AbortSignal))
    expect(JSON.stringify(peer.notification)).not.toContain(peer.invitation.token)
    expect(JSON.stringify(peer.notification)).not.toContain('PRIVATE KEY')
    expect(peer.authorize).toHaveBeenCalledWith(peer.senderId, peer.key.publicKey, expect.any(AbortSignal))
    expect(peer.authorize).toHaveBeenCalledTimes(4)
  })

  it('pins the SSH host key, proves the recipient private key and requires the exact SSH grant', async () => {
    const peer = await fixture()
    const wrongKey = newSshKeyPair()
    const wrongHost = { ...peer.options, route: { ...peer.options.route, hostPublicKey: wrongKey.publicKey }, recipient: { ...peer.options.recipient, hostPublicKey: wrongKey.publicKey } }
    await expect(callPeer(wrongHost, 'link', {}, timeout())).rejects.toMatchObject({ code: 'transport-failed' })
    const wrongClient: CallPeerOptions = {
      ...peer.options, local: { ...peer.options.local, keyPair: wrongKey }, route: { ...peer.options.route, clientPublicKey: wrongKey.publicKey },
      transport: { connect: async (route, grantId, targetPort, signal) => openSessionSshBridge(createConnection(peer.host.port, '127.0.0.1'), {
        key: wrongKey, hostPublicKey: route.hostPublicKey, grantId, targetPort, signal,
      }) },
    }
    await expect(callPeer(wrongClient, 'link', {}, timeout())).rejects.toMatchObject({ code: 'transport-failed' })
    await expect(callPeer({ ...peer.options, grantId: randomUUID() }, 'link', {}, timeout())).rejects.toMatchObject({ code: 'transport-failed' })
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('does not authorize arbitrary target ports, shell execution, or remote SSH listeners', async () => {
    const peer = await fixture()
    const other = createServer((_request, response) => response.end('UNAUTHORIZED_TARGET'))
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { other.closeAllConnections(); other.close(() => resolve()) }))
    const address = other.address()
    if (!address || typeof address === 'string') throw new Error('Missing test listener')
    await expect(callPeer({ ...peer.options, targetPort: address.port }, 'link', {}, timeout())).rejects.toThrow()
    const client = new ssh2.Client()
    cleanup.push(() => { client.destroy() })
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect({ host: '127.0.0.1', port: peer.host.port, username: peer.grant.id, privateKey: peer.key.privateKey,
        hostVerifier: (key: Buffer) => key.equals(Buffer.from(peer.hostKey.publicKey.split(' ')[1], 'base64')) })
    })
    expect(await new Promise((resolve) => client.exec('should-not-run', (error) => resolve(Boolean(error))))).toBe(true)
    expect(await new Promise((resolve) => client.shell((error) => resolve(Boolean(error))))).toBe(true)
    expect(await new Promise((resolve) => client.forwardIn('127.0.0.1', 0, (error) => resolve(Boolean(error))))).toBe(true)
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('rejects unsigned and forged loopback requests despite valid public grant metadata', async () => {
    const peer = await fixture()
    const request = createPeerRequest(peer.options, 'link', {})
    const { signature: _signature, ...unsigned } = request
    void _signature
    expect(await rawPost(peer.port, JSON.stringify(unsigned))).toMatchObject({ status: 400, body: { error: { code: 'invalid-request' } } })
    const forged = { ...request, signature: Buffer.alloc(64).toString('base64') }
    expect(await postPeerRequest(peer.port, forged, timeout())).toMatchObject({ status: 401, body: { error: { code: 'invalid-signature' } } })
    expect(peer.onLink).not.toHaveBeenCalled()
    expect(peer.authorize).not.toHaveBeenCalled()
  })

  it('signs the operation kind and full payload, not merely the public grant or recipient', async () => {
    const peer = await fixture()
    const request = createPeerRequest(peer.options, 'link', {})
    const altered = { ...request, kind: 'binding.changed' as const, payload: peer.notification }
    expect(await postPeerRequest(peer.port, altered, timeout())).toMatchObject({ status: 401, body: { error: { code: 'invalid-signature' } } })
    const binding = createPeerRequest(peer.options, 'binding.changed', peer.notification)
    expect(await postPeerRequest(peer.port, { ...binding, payload: { ...peer.notification, dependencies: [] } }, timeout())).toMatchObject({ status: 401 })
    expect(peer.onBinding).not.toHaveBeenCalled()
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'recipient', 'recipient-key', 'sender', 'sender-key', 'expiry'] as const)('rejects a signed request with a mismatched %s', async (field) => {
    const peer = await fixture()
    const route = await peer.bridge()
    const request = createPeerRequest(peer.options, 'link', {})
    const changes: Partial<PeerControlRequestBody> = field === 'workspace' ? { workspaceId: randomUUID() }
      : field === 'recipient' ? { recipientId: randomUUID() }
        : field === 'recipient-key' ? { recipientKeyId: sshFingerprint(newSshKeyPair().publicKey) }
          : field === 'sender' ? { senderId: randomUUID() }
            : field === 'expiry' ? { expiresAt: new Date(Date.now() + 30000).toISOString() } : {}
    const changed = resign(request, changes, peer.key)
    if (field === 'sender-key') changed.senderKeyId = sshFingerprint(newSshKeyPair().publicKey)
    const code = field === 'workspace' ? 'wrong-workspace' : field === 'recipient' || field === 'recipient-key' ? 'wrong-recipient' : 'invalid-grant'
    expect(await postPeerRequest(route.port, changed, timeout())).toMatchObject({ status: 403, body: { error: { code } } })
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('checks current application trust and grant revocation even through an authenticated SSH bridge', async () => {
    let trusted = false
    const peer = await fixture({ authorize: () => trusted })
    const route = await peer.bridge()
    expect(await postPeerRequest(route.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({
      status: 403, body: { ok: false, error: { code: 'unauthorized' } },
    })
    trusted = true
    expect(await postPeerRequest(route.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 200 })
    peer.control.revoke(peer.grant.id)
    expect(await postPeerRequest(route.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({
      status: 403, body: { error: { code: 'invalid-grant' } },
    })
    expect(peer.onLink).toHaveBeenCalledTimes(1)
  })

  it('rejects stale/future signatures and expired grants, and never refreshes expired authorization', async () => {
    let now = Date.now()
    const peer = await fixture({ now: () => now })
    const request = createPeerRequest(peer.options, 'link', {})
    for (const timestamp of [now - PEER_CONTROL_MAX_AGE_MS - 1, now + 6000]) {
      expect(await postPeerRequest(peer.port, resign(request, { timestamp: new Date(timestamp).toISOString() }, peer.key), timeout())).toMatchObject({
        status: 408, body: { error: { code: 'stale-request' } },
      })
    }
    now = Date.parse(peer.grant.expiresAt) + 1
    expect(await postPeerRequest(peer.port, request, timeout())).toMatchObject({ status: 403, body: { error: { code: 'expired-grant' } } })
    expect(() => peer.control.allow(peer.grant, peer.senderId, peer.key.publicKey)).toThrow('expired')
    await expect(callPeer({ ...peer.options, expiresAt: new Date(Date.now() - 1).toISOString() }, 'link', {}, timeout())).rejects.toMatchObject({ code: 'expired-grant' })
    expect(peer.connect).not.toHaveBeenCalled()
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('reserves nonces before asynchronous authorization and rejects replay without invoking handlers again', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    cleanup.push(() => release())
    const authorize = vi.fn(async () => gate)
    const peer = await fixture({ authorize })
    const route = await peer.bridge()
    const request = createPeerRequest(peer.options, 'link', {})
    const first = postPeerRequest(route.port, request, timeout())
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1))
    expect(await postPeerRequest(route.port, request, timeout())).toMatchObject({ status: 409, body: { ok: false, error: { code: 'replay' } } })
    release()
    expect(await first).toMatchObject({ status: 200, body: { nonce: request.nonce } })
    expect(await postPeerRequest(route.port, request, timeout())).toMatchObject({ status: 409 })
    expect(peer.onLink).toHaveBeenCalledTimes(1)
  })

  it('bounds replay memory without evicting still-fresh nonces, and expires entries after their TTL', async () => {
    let now = Date.now()
    const peer = await fixture({ now: () => now, maxReplayEntries: 2 })
    const first = createPeerRequest(peer.options, 'link', {})
    expect(await postPeerRequest(peer.port, first, timeout())).toMatchObject({ status: 200 })
    expect(await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 200 })
    expect(await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 429, body: { error: { code: 'busy' } } })
    expect(await postPeerRequest(peer.port, first, timeout())).toMatchObject({ status: 409 })
    now += PEER_CONTROL_REPLAY_TTL_MS + 1
    const fresh = resign(createPeerRequest(peer.options, 'link', {}), { timestamp: new Date(now).toISOString() }, peer.key)
    expect(await postPeerRequest(peer.port, fresh, timeout())).toMatchObject({ status: 200 })
    expect(await postPeerRequest(peer.port, first, timeout())).toMatchObject({ status: 408 })
  })

  it('has explicit operation deadlines and retains capacity for handlers that ignore cancellation', async () => {
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => { release = resolve })
    cleanup.push(() => release({ released: true }))
    const handler = vi.fn(() => gate)
    const peer = await fixture({ requestTimeoutMs: 100, maxConcurrentRequests: 1, onLink: handler })
    const first = postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    expect(await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 429 })
    expect(await first).toMatchObject({ status: 408, body: { ok: false, error: { code: 'timeout' } } })
    expect(await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 429 })
    release({ released: true })
    await vi.waitFor(async () => expect(await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).toMatchObject({ status: 200 }))
  })

  it.each(['trust', 'grant'] as const)('withholds a private response when %s is revoked during the handler', async (mode) => {
    let trusted = true
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => { release = resolve })
    cleanup.push(() => release({ token: 'never-expose-this-token' }))
    const handler = vi.fn(() => gate)
    const peer = await fixture({ authorize: () => trusted, onLink: handler })
    const pending = postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    if (mode === 'trust') trusted = false
    else peer.control.revoke(peer.grant.id)
    release({ token: 'never-expose-this-token' })
    const response = await pending
    expect(response).toMatchObject({ status: 403, body: { error: { code: mode === 'trust' ? 'unauthorized' : 'invalid-grant' } } })
    expect(JSON.stringify(response)).not.toContain('never-expose-this-token')
  })

  it('rejects oversized declared and chunked messages and checks the complete signed envelope before dialing', async () => {
    const peer = await fixture()
    const oversized = ' '.repeat(PEER_CONTROL_MAX_BYTES + 1)
    for (const chunked of [false, true]) {
      expect(await rawPost(peer.port, oversized, { chunked })).toMatchObject({ status: 413, body: { error: { code: 'too-large' } } })
    }
    await expect(callPeer(peer.options, 'binding.changed', {
      operation: { ...peer.notification.operation, padding: oversized }, dependencies: [],
    }, timeout())).rejects.toMatchObject({ code: 'too-large' })
    expect(peer.connect).not.toHaveBeenCalled()
    expect(peer.onLink).not.toHaveBeenCalled()
    expect(peer.onBinding).not.toHaveBeenCalled()
  })

  it('bounds responses and does not reflect confidential handler exceptions', async () => {
    const handler = vi.fn((): unknown => ({ token: 'x'.repeat(PEER_CONTROL_MAX_BYTES) }))
    const peer = await fixture({ onLink: handler })
    await expect(callPeer(peer.options, 'link', {}, timeout())).rejects.toMatchObject({ code: 'too-large' })
    handler.mockImplementation(() => { throw new Error('PRIVATE_HANDLER_TOKEN') })
    const result = await postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())
    expect(result).toMatchObject({ status: 500, body: { ok: false, error: { code: 'operation-failed' } } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HANDLER_TOKEN')
  })

  it('requires record schemas, actor signatures and dependencies rather than treating a binding notice as a new grant', async () => {
    const peer = await fixture()
    for (const payload of [
      { ...peer.notification, operation: { ...peer.notification.operation, payload: { schemaVersion: 2, action: 'set', taskId: 'T-0009', target: 'unrestricted' } } },
      { ...peer.notification, operation: { ...peer.notification.operation, actor: { ...peer.notification.operation.actor, deviceId: randomUUID() } } },
      { ...peer.notification, dependencies: [] },
    ]) {
      await expect(callPeer(peer.options, 'binding.changed', payload, timeout())).rejects.toMatchObject({ code: 'invalid-payload' })
    }
    await expect(callPeer(peer.options, 'binding.changed', { operationId: peer.notification.operation.operationId }, timeout())).rejects.toMatchObject({ code: 'invalid-payload' })
    await expect(callPeer(peer.options, 'binding.changed', { ...peer.notification, dependencies: Array(65).fill(peer.notification.dependencies[0]) }, timeout())).rejects.toMatchObject({ code: 'invalid-payload' })
    expect(peer.applied).toEqual([])
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('rejects unknown operations, browser origins, non-JSON bodies and non-POST endpoints', async () => {
    const peer = await fixture()
    const request = createPeerRequest(peer.options, 'link', {})
    for (const options of [{ method: 'GET' }, { path: '/exec' }, { contentType: 'text/plain' }, { origin: 'https://untrusted.invalid' }]) {
      expect(await rawPost(peer.port, JSON.stringify(request), options)).toMatchObject({ status: 400 })
    }
    expect(await rawPost(peer.port, JSON.stringify({ ...request, kind: 'session.send' }))).toMatchObject({ status: 400 })
    expect(peer.onLink).not.toHaveBeenCalled()
    expect(peer.onBinding).not.toHaveBeenCalled()
  })

  it('checks the server response signature and ties a valid response to the exact fresh request', async () => {
    const peer = await fixture()
    const bridge = await peer.bridge()
    const request = createPeerRequest(peer.options, 'link', {})
    const captured = await postPeerRequest(bridge.port, request, timeout())
    expect(captured).toMatchObject({ status: 200, body: { nonce: request.nonce, senderKeyId: sshFingerprint(peer.hostKey.publicKey) } })
    const responder = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(captured.body))
    })
    await new Promise<void>((resolve) => responder.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { responder.closeAllConnections(); responder.close(() => resolve()) }))
    const address = responder.address()
    if (!address || typeof address === 'string') throw new Error('Missing response fixture')
    const close = vi.fn()
    const options = { ...peer.options, transport: { connect: async () => ({ port: address.port, close }) } }
    await expect(callPeer(options, 'link', {}, timeout())).rejects.toMatchObject({ code: 'invalid-response' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(peer.onLink).toHaveBeenCalledTimes(1)
  })

  it('rejects a response whose nonce and request hash match but whose signed payload was altered', async () => {
    const peer = await fixture()
    const bridge = await peer.bridge()
    const responder = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.once('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SignedPeerControlRequest
        void postPeerRequest(bridge.port, message, timeout()).then((result) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ...result.body as object, payload: { token: 'forged-private-invitation' } }))
        }, () => { response.destroy() })
      })
    })
    await new Promise<void>((resolve) => responder.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { responder.closeAllConnections(); responder.close(() => resolve()) }))
    const address = responder.address()
    if (!address || typeof address === 'string') throw new Error('Missing response fixture')
    await expect(callPeer({ ...peer.options, transport: { connect: async () => ({ port: address.port, close: () => {} }) } }, 'link', {}, timeout())).rejects.toMatchObject({ code: 'invalid-response' })
    expect(peer.onLink).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('bounds an untrusted response before buffering it (chunked: %s)', async (chunked) => {
    const peer = await fixture()
    const responder = createServer((_request, response) => {
      const data = 'x'.repeat(PEER_CONTROL_MAX_BYTES + 1)
      response.writeHead(200, { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': data.length }) })
      if (chunked) { response.write(data.slice(0, 100)); response.end(data.slice(100)) } else response.end(data)
    })
    await new Promise<void>((resolve) => responder.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { responder.closeAllConnections(); responder.close(() => resolve()) }))
    const address = responder.address()
    if (!address || typeof address === 'string') throw new Error('Missing response fixture')
    const close = vi.fn()
    await expect(callPeer({ ...peer.options, transport: { connect: async () => ({ port: address.port, close }) } }, 'link', {}, timeout())).rejects.toMatchObject({ code: 'too-large' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('cancels an ignored transport dial, closes late connections and keeps the dial budget bounded', async () => {
    const peer = await fixture()
    let release!: (connection: { port: number; close(): void }) => void
    const gate = new Promise<{ port: number; close(): void }>((resolve) => { release = resolve })
    const close = vi.fn()
    cleanup.push(() => release({ port: peer.port, close }))
    const options = { ...peer.options, timeoutMs: 25, transport: { connect: () => gate } }
    const results = await Promise.all(Array.from({ length: 16 }, () => callPeer(options, 'link', {}).catch((error: unknown) => error)))
    expect(results).toHaveLength(16)
    for (const result of results) expect(result).toMatchObject({ code: 'timeout' })
    await expect(callPeer(options, 'link', {})).rejects.toMatchObject({ code: 'busy' })
    release({ port: peer.port, close })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(16))
    expect(await callPeer(peer.options, 'link', {}, timeout())).toEqual(peer.invitation)
    const canceled = new AbortController()
    canceled.abort()
    await expect(callPeer(peer.options, 'link', {}, canceled.signal)).rejects.toMatchObject({ code: 'aborted' })
  })

  it('closes listeners idempotently without granting or revoking original session access', async () => {
    const peer = await fixture()
    const first = await peer.control.start()
    expect(first).toEqual({ port: peer.port })
    await peer.control.close()
    await peer.control.close()
    await expect(peer.control.start()).rejects.toMatchObject({ code: 'closed' })
    await expect(postPeerRequest(peer.port, createPeerRequest(peer.options, 'link', {}), timeout())).rejects.toThrow()
    expect(() => peer.control.allow(peer.grant, peer.senderId, peer.key.publicKey)).toThrow('closed')
    expect(peer.onLink).not.toHaveBeenCalled()
  })

  it('reuses a saved control port across restart and opens/closes fresh SSH bridges with the same call options', async () => {
    const peer = await fixture()
    const connections: { port: number; close: ReturnType<typeof vi.fn<() => void>> }[] = []
    const connect = vi.fn<PeerControlTransport['connect']>(async (...args) => {
      const bridge = await peer.connect(...args)
      const connection = { port: bridge.port, close: vi.fn(bridge.close) }
      connections.push(connection)
      return connection
    })
    const options = Object.freeze({ ...peer.options, transport: { connect } })
    expect(await callPeer(options, 'link', {}, timeout())).toEqual(peer.invitation)
    expect(connections[0].close).toHaveBeenCalledTimes(1)
    await expect(postPeerRequest(connections[0].port, createPeerRequest(options, 'link', {}), timeout())).rejects.toThrow()

    const savedPort = peer.port
    await peer.control.close()
    const restarted = new PeerControlServer({
      port: savedPort, localId: peer.localId, workspaceId: peer.workspaceId, keyPair: peer.hostKey,
      authorize: peer.authorize, onLink: peer.onLink, onBinding: peer.onBinding,
    })
    cleanup.push(() => restarted.close())
    expect(await restarted.start()).toEqual({ port: savedPort })
    restarted.allow(peer.grant, peer.senderId, peer.key.publicKey)
    expect(await callPeer(options, 'binding.changed', peer.notification, timeout())).toMatchObject({
      operationId: peer.notification.operation.operationId, result: 'provisional',
    })
    expect(peer.applied).toEqual([peer.notification.operation])
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls.every(([, grantId, targetPort]) => grantId === peer.grant.id && targetPort === savedPort)).toBe(true)
    expect(connections[1].close).toHaveBeenCalledTimes(1)
    await expect(postPeerRequest(connections[1].port, createPeerRequest(options, 'link', {}), timeout())).rejects.toThrow()
  })

  it('reports EADDRINUSE for an occupied configured port without choosing another endpoint', async () => {
    const peer = await fixture()
    const competing = new PeerControlServer({
      port: peer.port, localId: peer.localId, workspaceId: peer.workspaceId, keyPair: peer.hostKey,
      authorize: peer.authorize, onLink: peer.onLink, onBinding: peer.onBinding,
    })
    cleanup.push(() => competing.close())
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(competing.start()).rejects.toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1', port: peer.port })
    }
    expect(await callPeer(peer.options, 'link', {}, timeout())).toEqual(peer.invitation)
    expect(peer.onLink).toHaveBeenCalledTimes(1)
  })

  it('validates an explicitly configured port as an integer in the unprivileged TCP range', () => {
    const options = {
      localId: randomUUID(), workspaceId: randomUUID(), keyPair: newSshKeyPair(),
      authorize: () => false, onLink: () => ({}), onBinding: () => ({}),
    }
    for (const port of [-1, 0, 22, 1023, 65536, 1024.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PeerControlServer({ ...options, port })).toThrow()
    }
    for (const port of [1024, 65535]) {
      const server = new PeerControlServer({ ...options, port })
      cleanup.push(() => server.close())
    }
  })

  it('exposes only a current public endpoint and works directly with ManagedDevTunnels authorize/connect', async () => {
    const parent = resolve('.runtime', 'peer-control-tests')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'managed-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const cli = new DevTunnelCli(async (args) => args[0] === 'user'
      ? { status: 'Logged in', provider: 'microsoft', username: 'owner@example.test', tenantId: 'test-tenant', objectId: 'test-owner' }
      : { tunnel: { tunnelId: 'taskcontinuum-control.jpe1', accessControl: [], hostConnections: 0 } })
    let online = false
    let sshPort = 0
    const cloud: TunnelCloud = {
      host: async (_id, port) => { online = true; sshPort = port; return { close: async () => { online = false }, connected: () => online } },
      connect: async () => {
        const stream = createConnection(sshPort, '127.0.0.1')
        return { stream, connected: () => !stream.destroyed, close: async () => { stream.destroy() } }
      },
    }
    const hostKeys = new DeviceSshKeys(join(directory, 'host'), protector)
    const clientKeys = new DeviceSshKeys(join(directory, 'client'), protector)
    const manager = new ManagedDevTunnels(join(directory, 'host'), hostKeys, cli, cloud)
    const client = new ManagedDevTunnels(join(directory, 'client'), clientKeys, cli, cloud)
    cleanup.push(() => manager.close())
    cleanup.push(() => client.close())
    const hostPair = await hostKeys.get('client')
    const clientPair = await clientKeys.get('client')
    const hostId = randomUUID()
    const clientId = randomUUID()
    const workspaceId = randomUUID()
    const control = new PeerControlServer({
      localId: hostId, workspaceId, keyPair: hostPair,
      authorize: (id, key) => id === clientId && key === clientPair.publicKey,
      onLink: () => ({ invitation: 'private-live-response' }), onBinding: () => ({ result: 'awaiting-sync' }),
    })
    cleanup.push(() => control.close())
    const { port } = await control.start()
    expect(manager.publicEndpoint()).toBeUndefined()
    await manager.publish()
    const endpoint = manager.publicEndpoint()!
    expect(endpoint).toEqual({ tunnelId: 'taskcontinuum-control.jpe1', sshPort, hostPublicKey: (await hostKeys.get('host')).publicKey })
    endpoint.tunnelId = 'modified-copy.jpe1'
    expect(manager.publicEndpoint()!.tunnelId).toBe('taskcontinuum-control.jpe1')
    const grant = { id: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() }
    control.allow(grant, clientId, clientPair.publicKey)
    const route = manager.authorize(grant, clientPair.publicKey, port, true)
    expect(await callPeer({
      workspaceId, local: { deviceId: clientId, keyPair: clientPair },
      recipient: { deviceId: hostId, clientPublicKey: hostPair.publicKey, hostPublicKey: route.hostPublicKey },
      route, grantId: grant.id, expiresAt: grant.expiresAt, targetPort: port, transport: client,
    }, 'link', {}, timeout())).toEqual({ invitation: 'private-live-response' })
    online = false
    expect(manager.publicEndpoint()).toBeUndefined()
    online = true
    await manager.stop()
    expect(manager.publicEndpoint()).toBeUndefined()
  })
})
