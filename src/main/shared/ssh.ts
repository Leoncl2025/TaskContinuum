import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export function sshArguments(host: string, localPort: number, remotePort: number, configFile?: string): string[] {
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/).parse(host)
  for (const port of [localPort, remotePort]) z.number().int().min(1024).max(65535).parse(port)
  if (configFile && (!isAbsolute(configFile) || configFile.includes('\0'))) throw new Error('SSH configuration must be an absolute local path.')
  return [...configFile ? ['-F', configFile] : [], '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', host]
}

export async function openSshTunnel(host: string, remotePort: number, configFile?: string): Promise<{ port: number; close(): void }> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('A local SSH port could not be allocated.')
  const port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const process = spawn('ssh', sshArguments(host, port, remotePort, configFile), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false })
  let failure: Error | undefined
  let diagnostic = ''
  process.stderr.on('data', (value: Buffer) => { diagnostic = (diagnostic + value.toString()).slice(-1200) })
  process.on('error', () => { failure = new Error('OpenSSH could not start. Install and configure SSH outside the app.') })
  process.on('exit', () => { failure = new Error(`SSH tunnel closed. Verify the enrolled host alias, keys, and forwarding permissions. ${diagnostic}`) })
  try {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (failure) throw failure
      const ready = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const finish = (value: boolean) => { socket.destroy(); resolve(value) }
        socket.setTimeout(300, () => finish(false))
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
      })
      if (ready) return { port, close: () => { process.kill() } }
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    }
    throw new Error('SSH forwarding timed out. Configure non-interactive SSH and trusted host keys before connecting.')
  } catch (error) { process.kill(); throw error }
}