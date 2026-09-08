// @vitest-environment node
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevTunnelCli, runDevTunnelJson } from '../src/main/devTunnel/cli'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs/promises', () => ({ access: vi.fn(async () => {}) }))

function cliResponse(output: string, code = 0) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => { child.stdout.end(output); child.stderr.end('private diagnostic fixture'); child.emit('close', code) })
    return child as unknown as ReturnType<typeof spawn>
  })
  return child
}

afterEach(() => { vi.clearAllMocks() })

describe('Dev Tunnel CLI process policy', () => {
  it('allows an interactive Windows sign-in window without exposing authentication output', async () => {
    cliResponse('private authentication output fixture')
    const cli = new DevTunnelCli()
    await expect(cli.login(new AbortController().signal)).resolves.toBeUndefined()
    if (process.platform === 'win32') expect(spawn).toHaveBeenCalledWith(expect.stringMatching(/cmd\.exe$/), ['/d', '/v:off', '/s', '/c', expect.stringMatching(/^start "Task Continuum Microsoft sign-in" \/wait "[^"\r\n%!&|<>^]+devtunnel\.exe" user login --entra --use-browser-auth --json$/)], expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true, shell: false, stdio: 'ignore' }))
    else expect(spawn).toHaveBeenCalledWith(expect.any(String), ['user', 'login', '--entra', '--use-browser-auth', '--json'], expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }))
  })

  it('keeps non-interactive status commands hidden and returns only their structured result', async () => {
    cliResponse('{"status":"Not logged in"}')
    await expect(new DevTunnelCli().status()).resolves.toEqual({ installed: true })
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['user', 'show', '--json'], expect.objectContaining({ windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }))
  })

  it('reports a sign-in failure without returning private CLI diagnostics', async () => {
    cliResponse('private authentication output fixture', 1)
    await expect(new DevTunnelCli().login(new AbortController().signal)).rejects.toThrow('Microsoft sign-in did not complete. Complete the account window, or sign in with the official Dev Tunnel CLI and refresh.')
  })

  it('does not launch a cancelled authentication attempt', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(runDevTunnelJson(['user', 'login', '--entra', '--use-browser-auth', '--json'], abort.signal)).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')('cancels only the spawned sign-in process tree', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() })
    const cleanup = new EventEmitter()
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => { child.emit('close', 1); cleanup.emit('close', 0) })
      return cleanup as unknown as ReturnType<typeof spawn>
    })
    const abort = new AbortController()
    const pending = new DevTunnelCli().login(abort.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    abort.abort()
    await expect(pending).rejects.toThrow('Dev Tunnel operation cancelled.')
    expect(spawn).toHaveBeenNthCalledWith(2, expect.stringMatching(/taskkill\.exe$/), ['/PID', '12345', '/T', '/F'], expect.objectContaining({ windowsHide: true, shell: false, stdio: 'ignore' }))
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')('rejects command expansion characters in the executable path', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\invalid%name\\AppData\\Local')
    try {
      await expect(new DevTunnelCli().login(new AbortController().signal)).rejects.toThrow('standard location')
      expect(spawn).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
})