import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, join, win32 } from 'node:path'
import { z } from 'zod'
import { devTunnelIdSchema } from './protocol'

export type TunnelLogin = { installed: boolean; account?: string; accountId?: string }
export type CliRunner = (args: string[], signal: AbortSignal) => Promise<unknown>
const infoSchema = z.object({ tunnel: z.object({ tunnelId: devTunnelIdSchema, accessControl: z.array(z.unknown()), hostConnections: z.number().optional() }) })
const signInFailure = 'Microsoft sign-in did not complete. Complete the account window, or sign in with the official Dev Tunnel CLI and refresh.'

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

async function windowsSignIn(file: string, signal: AbortSignal): Promise<void> {
  if (!win32.isAbsolute(file) || /[\r\n"%!&|<>^]/.test(file)) throw new Error('The Dev Tunnel CLI path cannot be opened in a sign-in console. Install it in a standard location.')
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  return new Promise<void>((resolve, reject) => {
    const child = spawn(join(system, 'cmd.exe'), ['/d', '/v:off', '/s', '/c', `start "Task Continuum Microsoft sign-in" /wait "${file}" user login --entra --use-browser-auth --json`], { windowsHide: true, windowsVerbatimArguments: true, shell: false, stdio: 'ignore' })
    let stopping: Promise<void> | undefined
    let settled = false
    const abort = () => {
      if (settled || stopping) return
      stopping = new Promise<void>((complete) => {
        if (!child.pid) { child.kill(); complete(); return }
        const cleanup = spawn(join(system, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        cleanup.once('error', () => { child.kill(); complete() })
        cleanup.once('close', (code) => { if (code !== 0) child.kill(); complete() })
      })
    }
    const finish = async (error?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      await stopping
      if (signal.aborted) reject(new Error('Dev Tunnel operation cancelled.'))
      else if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => { void finish(new Error('The Dev Tunnel sign-in console could not start.')) })
    child.once('close', (code) => { void finish(code === 0 ? undefined : new Error(signInFailure)) })
    if (signal.aborted) abort()
  })
}

export async function runDevTunnelJson(args: string[], signal: AbortSignal): Promise<unknown> {
  const file = await executable()
  const signingIn = args[0] === 'user' && args[1] === 'login'
  signal = AbortSignal.any([signal, AbortSignal.timeout(signingIn ? 300000 : 30000)])
  signal.throwIfAborted()
  if (signingIn && process.platform === 'win32') { await windowsSignIn(file, signal); return {} }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: !signingIn, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal })
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
        reject(new Error(signingIn ? signInFailure : `Dev Tunnel ${args[0]} failed. Check company sign-in, tunnel ownership, quota and approved network access.`))
        return
      }
      if (args[0] === 'delete' || signingIn) { resolve({}); return }
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