import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'

export async function startSshFixture(directory: string, remotePort: number) {
  const { Server, utils } = ssh2
  await mkdir(directory, { recursive: true })
  const hostKey = utils.generateKeyPairSync('ed25519')
  const userKey = utils.generateKeyPairSync('ed25519')
  const parsedUser = utils.parseKey(userKey.public)
  if (parsedUser instanceof Error) throw parsedUser
  const connections = new Set<Connection>()
  let forwards = 0
  const server = new Server({ hostKeys: [hostKey.private] }, (connection) => {
    connections.add(connection)
    connection.on('close', () => connections.delete(connection))
    connection.on('error', () => {})
    connection.on('authentication', (context) => {
      if (context.method !== 'publickey' || context.username !== 'participant' || !context.key.data.equals(parsedUser.getPublicSSH())) { context.reject(); return }
      if (!context.signature || parsedUser.verify(context.blob!, context.signature, context.hashAlgo) === true) context.accept()
      else context.reject()
    })
    connection.on('ready', () => connection.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== remotePort) { reject(); return }
      const socket = createConnection({ host: '127.0.0.1', port: remotePort })
      socket.once('error', () => { reject(); socket.destroy() })
      socket.once('connect', () => {
        forwards++
        const channel = accept()
        channel.on('error', () => socket.destroy())
        channel.on('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const close = async () => { for (const connection of connections) connection.end(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The SSH fixture failed to bind.')
    const privateKey = join(directory, 'identity')
    const knownHosts = join(directory, 'known_hosts')
    const config = join(directory, 'ssh_config')
    const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`
    await writeFile(privateKey, userKey.private, { mode: 0o600 })
    await writeFile(knownHosts, `[127.0.0.1]:${address.port} ${hostKey.public}\n`, { mode: 0o600 })
    await writeFile(config, `Host owner-machine\n  HostName 127.0.0.1\n  Port ${address.port}\n  User participant\n  IdentityFile ${quoted(privateKey)}\n  UserKnownHostsFile ${quoted(knownHosts)}\n  IdentitiesOnly yes\n  GlobalKnownHostsFile none\n`, { mode: 0o600 })
    return { config, close, forwardedConnections: () => forwards }
  } catch (error) { await close(); throw error }
}