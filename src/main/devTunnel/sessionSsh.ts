import { createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
import { z } from 'zod'
import { sshPublicKeySchema } from './protocol'

type Access = { id: string; key: Buffer; port: number; expires: number }
export type SshKeyPair = { publicKey: string; privateKey: string }
const FORWARDED_SOCKET_IDLE_MS = 60_000

export function newSshKeyPair(): SshKeyPair {
  return encodeDeviceSshKey(generateKeyPairSync('ed25519').privateKey)
}

export function encodeDeviceSshKey(privateKeyObject: KeyObject): SshKeyPair {
  if (privateKeyObject.type !== 'private' || privateKeyObject.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required.')
  const publicBytes = createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }).subarray(-32)
  const seed = privateKeyObject.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const uint32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes }
  const field = (value: Buffer | string) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([uint32(bytes.length), bytes]) }
  const publicBlob = Buffer.concat([field('ssh-ed25519'), field(publicBytes)])
  const check = randomBytes(4)
  // OpenSSH's unencrypted Ed25519 container retains fixed-width key bytes, including leading zeros.
  const privateFields = Buffer.concat([check, check, field('ssh-ed25519'), field(publicBytes), field(Buffer.concat([seed, publicBytes])), field('')])
  const padding = Buffer.from(Array.from({ length: 8 - privateFields.length % 8 }, (_, index) => index + 1))
  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), field('none'), field('none'), field(''), uint32(1), field(publicBlob),
    field(Buffer.concat([privateFields, padding])),
  ])
  const encoded = container.toString('base64')
  const lines: string[] = []
  for (let offset = 0; offset < encoded.length; offset += 70) lines.push(encoded.slice(offset, offset + 70))
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
  const publicKey = sshPublicKeySchema.parse(`ssh-ed25519 ${publicBlob.toString('base64')}`)
  return { publicKey, privateKey }
}

export async function startSessionSshHost(key: SshKeyPair, port = 0) {
  const grants = new Map<string, Access>()
  const connections = new Map<Connection, string | undefined>()
  const sockets = new Set<Socket>()
  let closed = false
  let closing: Promise<void> | undefined
  const server = new ssh2.Server({ hostKeys: [key.privateKey], ident: 'TaskContinuum', banner: '' }, (connection) => {
    if (closed || connections.size >= 32) { connection.end(); return }
    connections.set(connection, undefined)
    const loginTimer = setTimeout(() => connection.end(), 10000)
    loginTimer.unref()
    connection.once('ready', () => clearTimeout(loginTimer))
    let access: Access | undefined
    let attempts = 0
    let expiry: ReturnType<typeof setTimeout> | undefined
    const allowed = () => access && grants.get(access.id) === access && access.expires > Date.now()
    connection.on('error', () => {})
    connection.on('close', () => { clearTimeout(loginTimer); clearTimeout(expiry); connections.delete(connection) })
    connection.on('authentication', (context) => {
      const candidate = grants.get(context.username)
      if (++attempts > 5 || !candidate || candidate.expires <= Date.now() || context.method !== 'publickey'
        || context.key.algo !== 'ssh-ed25519' || !context.key.data.equals(candidate.key)) { context.reject(['publickey']); return }
      const parsed = ssh2.utils.parseKey(`ssh-ed25519 ${candidate.key.toString('base64')}`)
      if (parsed instanceof Error || context.signature && parsed.verify(context.blob!, context.signature, context.hashAlgo) !== true) { context.reject(['publickey']); return }
      access = candidate
      connections.set(connection, candidate.id)
      clearTimeout(expiry)
      const checkExpiry = () => {
        if (!allowed()) { connection.end(); return }
        expiry = setTimeout(checkExpiry, Math.min(86400000, Math.max(1, candidate.expires - Date.now())))
        expiry.unref()
      }
      checkExpiry()
      context.accept()
    })
    connection.on('request', (_accept, reject) => reject?.())
    connection.on('session', (_accept, reject) => reject())
    connection.on('tcpip', (accept, reject, info) => {
      if (!allowed() || info.destIP !== '127.0.0.1' || info.destPort !== access!.port || sockets.size >= 64) { reject(); return }
      const socket = createConnection({ host: '127.0.0.1', port: access!.port })
      sockets.add(socket)
      // AHP heartbeats run every 15 seconds; the forward must outlive scheduling jitter.
      socket.setTimeout(FORWARDED_SOCKET_IDLE_MS, () => socket.destroy())
      socket.once('close', () => sockets.delete(socket))
      socket.once('error', () => { reject(); socket.destroy() })
      socket.once('connect', () => {
        if (!allowed()) { reject(); socket.destroy(); return }
        const channel = accept()
        channel.on('error', () => socket.destroy())
        channel.on('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
      })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('The private SSH endpoint could not bind.') }
  return {
    port: address.port, publicKey: key.publicKey,
    allow(id: string, publicKey: string, port: number, expiresAt: string, device = false): void {
      z.uuid().parse(id)
      z.number().int().min(1024).max(65535).parse(port)
      const expires = Date.parse(z.iso.datetime().parse(expiresAt))
      if (closed || expires <= Date.now() || expires > Date.now() + (device ? 31 * 24 : 25) * 60 * 60 * 1000) throw new Error('This SSH grant is expired or invalid.')
      for (const [grantId, grant] of grants) if (grant.expires <= Date.now()) grants.delete(grantId)
      if (!grants.has(id) && grants.size >= 32) throw new Error('The private SSH invitation limit is 32.')
      const parsedKey = Buffer.from(sshPublicKeySchema.parse(publicKey).split(' ')[1], 'base64')
      const prior = grants.get(id)
      if (prior && prior.key.equals(parsedKey) && prior.port === port && prior.expires === expires) return
      for (const [connection, grantId] of connections) if (grantId === id) connection.end()
      grants.set(id, { id, key: parsedKey, port, expires })
    },
    revoke(id: string): void {
      grants.delete(id)
      for (const [connection, grantId] of connections) if (grantId === id) connection.end()
    },
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        grants.clear()
        for (const connection of connections.keys()) connection.end()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })()
      return closing
    },
  }
}

export async function openSessionSshBridge(stream: Duplex, options: {
  key: SshKeyPair; hostPublicKey: string; grantId: string; targetPort: number; signal: AbortSignal
}): Promise<{ port: number; close(): void }> {
  const expected = Buffer.from(sshPublicKeySchema.parse(options.hostPublicKey).split(' ')[1], 'base64')
  z.uuid().parse(options.grantId)
  z.number().int().min(1024).max(65535).parse(options.targetPort)
  const client = new ssh2.Client()
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    if (sockets.size >= 16) { socket.destroy(); return }
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', options.targetPort, (error, channel) => {
      if (error || socket.destroyed) { channel?.destroy(); socket.destroy(); return }
      channel.on('error', () => socket.destroy())
      channel.on('close', () => socket.destroy())
      socket.once('close', () => channel.destroy())
      socket.pipe(channel).pipe(socket)
    })
  })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    options.signal.removeEventListener('abort', close)
    listener.close()
    for (const socket of sockets) socket.destroy()
    client.destroy()
    stream.destroy()
  }
  options.signal.addEventListener('abort', close, { once: true })
  client.on('error', close)
  client.on('close', close)
  stream.on('error', close)
  try {
    options.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', () => reject(new Error('SSH identity or public-key authentication failed. Re-pair with the execution owner.')))
      client.once('close', () => reject(new Error('The SSH connection was closed before authentication.')))
      client.connect({ sock: stream, username: options.grantId, privateKey: options.key.privateKey, readyTimeout: 10000,
        hostVerifier: (hostKey: Buffer) => hostKey.length === expected.length && timingSafeEqual(hostKey, expected),
        keepaliveInterval: 15000, keepaliveCountMax: 2,
      })
    })
    options.signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
    options.signal.throwIfAborted()
    if (closed) throw new Error('SSH disconnected before its local endpoint was ready.')
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('The private client endpoint could not bind.')
    return { port: address.port, close }
  } catch (error) { close(); throw error }
}