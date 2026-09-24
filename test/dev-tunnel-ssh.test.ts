// @vitest-environment node
import { createServer } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import ssh2 from 'ssh2'
import { TunnelRelayTunnelClient } from '@microsoft/dev-tunnels-connections'
import { afterEach, describe, expect, it } from 'vitest'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { sshFingerprint, sshPublicKeySchema } from '../src/main/devTunnel/protocol'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture() {
  const http = createServer((_request, response) => response.end('Original Bridge'))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()) }))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const hostKey = newSshKeyPair()
  const key = newSshKeyPair()
  const host = await startSessionSshHost(hostKey)
  cleanup.push(() => host.close())
  const grantId = randomUUID()
  host.allow(grantId, key.publicKey, address.port, new Date(Date.now() + 60000).toISOString())
  const options = { key, hostPublicKey: hostKey.publicKey, grantId, targetPort: address.port, signal: new AbortController().signal }
  return { host, options }
}

describe('application-managed SSH', () => {
  it('loads Dev Tunnels through the main process CommonJS entry point', () => {
    const require = createRequire(import.meta.url)
    expect(require('@microsoft/dev-tunnels-connections')).toHaveProperty('TunnelRelayTunnelClient', expect.any(Function))
  })

  it('loads the pinned Dev Tunnels SDK with the patched UUID dependency', async () => {
    const client = new TunnelRelayTunnelClient()
    client.acceptLocalConnectionsForForwardedPorts = false
    expect(client.acceptLocalConnectionsForForwardedPorts).toBe(false)
    await client.dispose()
  })

  it('only forwards the authorized original Bridge and closes access on revocation', async () => {
    const { host, options } = await fixture()
    const tunnel = await openSessionSshBridge(createConnection(host.port, '127.0.0.1'), options)
    cleanup.push(tunnel.close)
    expect(tunnel.port).not.toBe(22)
    expect(await (await fetch(`http://127.0.0.1:${tunnel.port}`)).text()).toBe('Original Bridge')
    const denied = await openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { ...options, targetPort: options.targetPort === 65535 ? 65534 : options.targetPort + 1 })
    cleanup.push(denied.close)
    await expect(fetch(`http://127.0.0.1:${denied.port}`)).rejects.toThrow()
    host.revoke(options.grantId)
    await expect(fetch(`http://127.0.0.1:${tunnel.port}`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
  })

  it('keeps an authorized idle forward alive beyond the 15-second AHP heartbeat interval', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const service = createTcpServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.pipe(socket)
    })
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      service.close(() => resolve())
    }))
    const address = service.address()
    if (!address || typeof address === 'string') throw new Error('Missing echo port.')
    const hostKey = newSshKeyPair()
    const key = newSshKeyPair()
    const host = await startSessionSshHost(hostKey)
    cleanup.push(() => host.close())
    const grantId = randomUUID()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    host.allow(grantId, key.publicKey, address.port, expiresAt)
    const tunnel = await openSessionSshBridge(createConnection(host.port, '127.0.0.1'), {
      key, hostPublicKey: hostKey.publicKey, grantId, targetPort: address.port, signal: new AbortController().signal,
    })
    cleanup.push(tunnel.close)
    const socket = createConnection(tunnel.port, '127.0.0.1')
    cleanup.push(() => { socket.destroy() })
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    await new Promise<void>((resolve) => setTimeout(resolve, 16_000))
    expect(socket.destroyed).toBe(false)
    const reply = new Promise<string>((resolve, reject) => {
      socket.once('data', (data: Buffer) => resolve(data.toString('utf8')))
      socket.once('error', reject)
    })
    socket.write('after-idle')
    await expect(reply).resolves.toBe('after-idle')
  }, 35_000)

  it('pins the SSH host key and rejects another client or invitation', async () => {
    const { host, options } = await fixture()
    await expect(openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { ...options, hostPublicKey: newSshKeyPair().publicKey })).rejects.toThrow('SSH')
    await expect(openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { ...options, key: newSshKeyPair() })).rejects.toThrow('SSH')
    await expect(openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { ...options, grantId: randomUUID() })).rejects.toThrow('SSH')
    expect(sshFingerprint(options.key.publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(() => sshPublicKeySchema.parse('ssh-ed25519 AAAA')).toThrow()
  })

  it('denies shell, command execution and remote listeners', async () => {
    const { host, options } = await fixture()
    const client = new ssh2.Client()
    cleanup.push(() => { client.destroy() })
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('ready', resolve)
      client.connect({ host: '127.0.0.1', port: host.port, username: options.grantId, privateKey: options.key.privateKey })
    })
    expect(await new Promise((resolve) => client.exec('whoami', (error) => resolve(Boolean(error))))).toBe(true)
    expect(await new Promise((resolve) => client.shell((error) => resolve(Boolean(error))))).toBe(true)
    expect(await new Promise((resolve) => client.forwardIn('127.0.0.1', 0, (error) => resolve(Boolean(error))))).toBe(true)
  })

  it('cancels the SSH endpoint without affecting the original service', async () => {
    const { host, options } = await fixture()
    const controller = new AbortController()
    const tunnel = await openSessionSshBridge(createConnection(host.port, '127.0.0.1'), { ...options, signal: controller.signal })
    cleanup.push(tunnel.close)
    controller.abort()
    await expect(fetch(`http://127.0.0.1:${tunnel.port}`)).rejects.toThrow()
    expect(await (await fetch(`http://127.0.0.1:${options.targetPort}`)).text()).toBe('Original Bridge')
  })
})