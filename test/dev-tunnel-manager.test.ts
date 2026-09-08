// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ManagedDevTunnels } from '../src/main/devTunnel/manager'
import { DeviceSshKeys } from '../src/main/devTunnel/identity'
import { DevTunnelCli } from '../src/main/devTunnel/cli'
import type { TunnelCloud } from '../src/main/devTunnel/cloud'

describe('managed Dev Tunnel lifecycle', () => {
  it.runIf(process.env.TASKCONTINUUM_LIVE_DEV_TUNNEL === '1')('carries a synthetic Bridge through the actual private Dev Tunnel service and SSH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-live-tunnel-'))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const cli = new DevTunnelCli()
    const ownerRoot = join(root, 'owner')
    const owner = new ManagedDevTunnels(ownerRoot, new DeviceSshKeys(ownerRoot, protector), cli)
    const client = new ManagedDevTunnels(join(root, 'client'), new DeviceSshKeys(join(root, 'client'), protector), cli)
    const http = createServer((_request, response) => response.end('TASKCONTINUUM_PRIVATE_SSH_OK'))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('No synthetic listener')
    async function removePublication(): Promise<void> {
      let content: string
      try { content = await readFile(join(ownerRoot, 'dev-tunnel-publication.json'), 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const published = JSON.parse(content) as { tunnelId: string }
      await cli.remove(published.tunnelId, AbortSignal.timeout(20000))
    }
    try {
      await owner.publish()
      expect((await owner.status()).state).toBe('hosting')
      const grant = { id: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() }
      const route = owner.authorize(grant, (await client.keys.get('client')).publicKey, address.port)
      const connection = await client.connect(route, grant.id, address.port, new AbortController().signal)
      expect(await (await fetch(`http://127.0.0.1:${connection.port}`, { signal: AbortSignal.timeout(10000) })).text()).toBe('TASKCONTINUUM_PRIVATE_SSH_OK')
      connection.close()
      owner.revoke(grant.id)
    } finally {
      await client.close()
      await owner.close()
      try { await removePublication() } finally {
        http.closeAllConnections()
        await new Promise<void>((resolve) => http.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 120000)

  it('publishes privately, pairs a client, carries real SSH and closes only the transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-managed-tunnel-'))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const run = vi.fn(async (args: string[]) => args[0] === 'user' ? { status: 'Logged in', provider: 'microsoft', username: 'owner@example.test', tenantId: 'tenant', objectId: 'owner' } : { tunnel: { tunnelId: `taskcontinuum-${'a'.repeat(32)}.jpe1`, accessControl: [], hostConnections: 0 } })
    const cli = new DevTunnelCli(run)
    let sshPort = 0
    let online = false
    const cloud: TunnelCloud = {
      host: vi.fn(async (_id, port) => { sshPort = port; online = true; return { close: async () => { online = false }, connected: () => online } }),
      connect: vi.fn(async () => { const stream = createConnection(sshPort, '127.0.0.1'); return { stream, close: async () => { stream.destroy() }, connected: () => !stream.destroyed } }),
    }
    const owner = new ManagedDevTunnels(join(root, 'owner'), new DeviceSshKeys(join(root, 'owner'), protector), cli, cloud)
    const client = new ManagedDevTunnels(join(root, 'client'), new DeviceSshKeys(join(root, 'client'), protector), cli, cloud)
    const http = createServer((_request, response) => response.end('Exact original'))
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Missing port')
    try {
      expect((await owner.status(true)).state).toBe('idle')
      expect(cloud.host).not.toHaveBeenCalled()
      await owner.publish()
      expect(await owner.status()).toMatchObject({ state: 'hosting', installed: true, account: 'owner@example.test' })
      await owner.cancel()
      expect((await owner.status()).state).toBe('hosting')
      await expect(owner.login()).rejects.toThrow('Stop this publication')
      const grant = { id: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() }
      const route = owner.authorize(grant, (await client.keys.get('client')).publicKey, address.port)
      const tunnel = await client.connect(route, grant.id, address.port, new AbortController().signal)
      expect(await (await fetch(`http://127.0.0.1:${tunnel.port}`)).text()).toBe('Exact original')
      tunnel.close()
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('Exact original')
      owner.revoke(grant.id)
      await expect(client.connect(route, grant.id, address.port, new AbortController().signal)).rejects.toThrow('SSH')
      await owner.stop()
      expect((await owner.status()).state).toBe('idle')
      const before = await readFile(join(root, 'owner', 'dev-tunnel-publication.json'), 'utf8')
      await owner.publish()
      expect(await readFile(join(root, 'owner', 'dev-tunnel-publication.json'), 'utf8')).toBe(before)
      expect(run.mock.calls.filter(([args]) => args[0] === 'create')).toHaveLength(1)
      expect(JSON.stringify(await owner.status())).not.toMatch(/PRIVATE KEY|encryptedPrivateKey|token/)
      const previousKey = (await owner.keys.get('host')).publicKey
      await owner.reset()
      expect(await owner.status()).toEqual({ state: 'idle', installed: true, account: 'owner@example.test' })
      await expect(readFile(join(root, 'owner', 'dev-tunnel-publication.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await owner.publish()
      const createdNames = run.mock.calls.filter(([args]) => args[0] === 'create').map(([args]) => args[1])
      expect(createdNames).toHaveLength(2)
      expect(createdNames[0]).not.toBe(createdNames[1])
      expect((await owner.keys.get('host')).publicKey).toBe(previousKey)
    } finally { await client.close(); await owner.close(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
  })
  it('cancels pending browser sign-in and publication without leaving an SSH listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-cancel-tunnel-'))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const login = { status: 'Logged in', provider: 'microsoft', username: 'owner@example.test', tenantId: 'tenant', objectId: 'owner' }
    const cli = new DevTunnelCli(async (args, signal) => {
      if (args[0] === 'user' && args[1] === 'login') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Sign-in canceled')), { once: true }))
      return args[0] === 'user' ? login : { tunnel: { tunnelId: `taskcontinuum-${'c'.repeat(32)}.jpe1`, accessControl: [], hostConnections: 0 } }
    })
    let sshPort = 0
    const cloud: TunnelCloud = {
      host: vi.fn(async (_id, port, signal) => {
        sshPort = port
        return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Publication canceled')), { once: true }))
      }),
      connect: vi.fn(),
    }
    const manager = new ManagedDevTunnels(root, new DeviceSshKeys(root, protector), cli, cloud)
    try {
      const signingIn = expect(manager.login()).rejects.toThrow('Sign-in canceled')
      await manager.cancel()
      await signingIn
      expect((await manager.status()).state).toBe('idle')
      const publishing = expect(manager.publish()).rejects.toThrow('Publication canceled')
      await vi.waitFor(() => expect(cloud.host).toHaveBeenCalledOnce())
      await manager.cancel()
      await publishing
      expect((await manager.status()).state).toBe('idle')
      expect(await new Promise<boolean>((resolve) => {
        const socket = createConnection(sshPort, '127.0.0.1')
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })).toBe(false)
      expect(cloud.connect).not.toHaveBeenCalled()
    } finally { await manager.close(); await rm(root, { recursive: true, force: true }) }
  })
})