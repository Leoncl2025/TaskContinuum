// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils } from 'ssh2'
import { afterEach, expect, it } from 'vitest'
import { SharedSessionHost } from '../src/main/shared/host'
import { SharedJournal } from '../src/main/shared/journal'
import { startSharedServer } from '../src/main/shared/server'
import { openSshTunnel } from '../src/main/shared/ssh'
import type { SharedGrant, SharedSessionDescriptor } from '../src/shared/sharedSessions'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

it('uses real system OpenSSH with strict host verification to reach an authenticated loopback Host', async () => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }) } catch { throw new Error('OpenSSH is required for the shared-session transport test.') }
  const directory = await mkdtemp(join(tmpdir(), 'taskcontinuum-ssh-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const session: SharedSessionDescriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'live', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
  const token = randomBytes(32).toString('base64url')
  const grant: SharedGrant = { id: 'grant-A', actor: { kind: 'user', id: 'alice', name: 'Alice', machineId: 'A', machineName: 'A' }, permissions: ['read'], tokenHash: createHash('sha256').update(token).digest('hex') }
  const host = new SharedSessionHost(session, new SharedJournal(join(directory, 'events.jsonl'), session), { send: async () => {}, abort: async () => {}, respond: () => {}, onEvent: () => () => {} })
  await host.start()
  cleanup.push(() => host.close())
  const http = await startSharedServer({ host, getGrants: async () => [grant] })
  cleanup.push(() => http.close())
  const hostKey = utils.generateKeyPairSync('ed25519')
  const userKey = utils.generateKeyPairSync('ed25519')
  const parsedUser = utils.parseKey(userKey.public)
  if (parsedUser instanceof Error) throw parsedUser
  const connections = new Set<import('ssh2').Connection>()
  const ssh = new Server({ hostKeys: [hostKey.private] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('error', () => {})
    connection.on('authentication', (context) => {
      if (context.method !== 'publickey' || context.username !== 'participant' || !context.key.data.equals(parsedUser.getPublicSSH())) { context.reject(); return }
      if (!context.signature || parsedUser.verify(context.blob!, context.signature, context.hashAlgo) === true) context.accept()
      else context.reject()
    })
    connection.on('ready', () => connection.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== http.port) { reject(); return }
      const socket = createConnection({ host: '127.0.0.1', port: http.port })
      socket.once('error', () => { reject(); socket.destroy() })
      socket.once('connect', () => {
        const channel = accept()
        channel.on('error', () => socket.destroy())
        channel.on('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { ssh.once('error', reject); ssh.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { for (const connection of connections) connection.end(); await new Promise<void>((resolve) => ssh.close(() => resolve())) })
  const address = ssh.address()
  if (!address || typeof address === 'string') throw new Error('SSH test server did not bind.')
  const privateKey = join(directory, 'identity')
  const knownHosts = join(directory, 'known_hosts')
  const config = join(directory, 'ssh_config')
  await writeFile(privateKey, userKey.private, { mode: 0o600 })
  await writeFile(knownHosts, `[127.0.0.1]:${address.port} ${hostKey.public}\n`, { mode: 0o600 })
  const quoted = (path: string) => `"${path.replaceAll('\\', '/')}"`
  await writeFile(config, `Host taskcontinuum-test\n  HostName 127.0.0.1\n  Port ${address.port}\n  User participant\n  IdentityFile ${quoted(privateKey)}\n  UserKnownHostsFile ${quoted(knownHosts)}\n  IdentitiesOnly yes\n  GlobalKnownHostsFile none\n`, { mode: 0o600 })
  const tunnel = await openSshTunnel('taskcontinuum-test', http.port, config)
  cleanup.push(async () => { tunnel.close() })
  const response = await fetch(`http://127.0.0.1:${tunnel.port}/session`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  expect(response.ok).toBe(true)
  expect(await response.json()).toMatchObject({ session: { id: session.id, owner: { machineId: 'B' } }, actor: { machineId: 'A' } })
  const streamController = new AbortController()
  const events = await fetch(`http://127.0.0.1:${tunnel.port}/events?after=0&epoch=1`, { headers: { Authorization: `Bearer ${token}` }, signal: streamController.signal })
  const reader = events.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('"kind":"ready"')
  streamController.abort()
  await reader.cancel().catch(() => undefined)
}, 20000)