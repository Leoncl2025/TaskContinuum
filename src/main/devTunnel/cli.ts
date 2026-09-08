import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import { devTunnelIdSchema } from './protocol'

export type TunnelLogin = { installed: boolean; account?: string; accountId?: string }
export type CliRunner = (args: string[], signal: AbortSignal) => Promise<unknown>
const infoSchema = z.object({ tunnel: z.object({ tunnelId: devTunnelIdSchema, accessControl: z.array(z.unknown()), hostConnections: z.number().optional() }) })

export function parseDevTunnelJson(output: string): unknown {
  let value = output.trim()
  if (value.startsWith('Welcome to dev tunnels!')) {
    const start = value.indexOf('\n{')
    if (start < 0) throw new Error('No structured CLI response.')
    value = value.slice(start + 1)
  }
  return JSON.parse(value) as unknown
}

async function executable(): Promise<string> {
  const name = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel'
  const paths = [...process.platform === 'win32' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name)] : [],
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, name))]
  for (const file of paths) { try { await access(file); return file } catch { continue } }
  throw new Error('Install the Microsoft Dev Tunnel CLI, then refresh. No system SSH Server is needed for this mode.')
}

export async function runDevTunnelJson(args: string[], signal: AbortSignal): Promise<unknown> {
  const file = await executable()
  signal = AbortSignal.any([signal, AbortSignal.timeout(args[0] === 'user' && args[1] === 'login' ? 300000 : 30000)])
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal })
    const chunks: Buffer[] = []
    let bytes = 0
    let diagnostic = ''
    let exceeded = false
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > 512 * 1024) { exceeded = true; child.kill(); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-2048) })
    child.once('error', () => reject(new Error(signal.aborted ? 'Dev Tunnel operation cancelled.' : 'The Dev Tunnel CLI could not start.')))
    child.once('close', (code) => {
      if (signal.aborted) { reject(new Error('Dev Tunnel operation cancelled.')); return }
      if (exceeded) { reject(new Error('The Dev Tunnel CLI response exceeds its limit.')); return }
      const output = Buffer.concat(chunks).toString('utf8').trim()
      if (code !== 0) {
        if (args[0] === 'user' && args[1] === 'show' && /not logged in|not signed in|no user/i.test(output + diagnostic)) { resolve({ status: 'Signed out' }); return }
        reject(new Error(`Dev Tunnel ${args[0]} failed. Check company sign-in, tunnel ownership, quota and approved network access.`))
        return
      }
      if (args[0] === 'delete' || args[0] === 'user' && args[1] === 'login') { resolve({}); return }
      try { resolve(output ? parseDevTunnelJson(output) : {}) } catch {
        reject(new Error(`The Dev Tunnel CLI returned an unsupported ${args[0]} response. Update the official CLI.`))
      }
    })
  })
}

export class DevTunnelCli {
  constructor(private readonly run: CliRunner = runDevTunnelJson) {}
  async status(signal: AbortSignal = AbortSignal.timeout(15000)): Promise<TunnelLogin> {
    if (this.run === runDevTunnelJson) { try { await executable() } catch { return { installed: false } } }
    const result = z.object({ status: z.string(), provider: z.string().optional(), username: z.string().max(300).optional(), tenantId: z.string().optional(), objectId: z.string().optional() }).parse(await this.run(['user', 'show', '--json'], signal))
    if (result.status !== 'Logged in') return { installed: true }
    if (result.provider !== 'microsoft' || !result.username || !result.tenantId || !result.objectId) throw new Error('Sign in to Dev Tunnel with your company Microsoft account.')
    return { installed: true, account: result.username, accountId: `${result.tenantId}:${result.objectId}` }
  }
  async login(signal: AbortSignal): Promise<void> { await this.run(['user', 'login', '--entra', '--use-browser-auth', '--json'], signal) }
  async create(name: string, signal: AbortSignal): Promise<string> {
    z.string().regex(/^taskcontinuum-[a-f0-9]{32}$/).parse(name)
    const result = infoSchema.parse(await this.run(['create', name, '--expiration', '30d', '--json'], signal))
    if (result.tunnel.accessControl.length) throw new Error('The new tunnel is not owner-only. No SSH endpoint was published.')
    return result.tunnel.tunnelId
  }
  async inspect(id: string, signal: AbortSignal, allowRunningHost = false): Promise<void> {
    const value = infoSchema.parse(await this.run(['show', devTunnelIdSchema.parse(id), '--json'], signal))
    if (value.tunnel.tunnelId !== id || value.tunnel.accessControl.length) throw new Error('This tunnel is no longer owner-only or its identity changed. Restore its access policy before publishing.')
    if (value.tunnel.hostConnections && !allowRunningHost) throw new Error('This tunnel already has a running host. Stop it in the owning desktop first.')
  }
  async token(id: string, scope: 'host' | 'connect' | 'manage:ports', signal: AbortSignal): Promise<string> {
    const value = await this.run(['token', devTunnelIdSchema.parse(id), '--scopes', scope, '--json'], signal)
    return z.object({ token: z.string().min(20).max(16384) }).parse(value).token
  }

  async remove(id: string, signal: AbortSignal): Promise<void> {
    await this.run(['delete', devTunnelIdSchema.parse(id), '--force', '--json'], signal)
  }
}