// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { UpdateBridge } from '../src/shared/updates'
import { registerUpdateBridge } from '../src/main/updateBridge'
import { UpdateRestartGuard } from '../src/main/updateRestartGuard'
import { DesktopOperations } from '../src/main/desktopOperations'

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } },
}))
beforeEach(() => { handlers.clear() })

function fixture(deferred = false) {
  const trusted = {} as IpcMainInvokeEvent
  const requireWindow = vi.fn((event: IpcMainInvokeEvent) => {
    if (event !== trusted) throw new Error('Untrusted window')
    return {} as BrowserWindow
  })
  const state = { phase: 'idle', currentVersion: '0.1.1', distribution: 'archive', canInstall: false, autoCheck: true } as const
  const service: Pick<UpdateBridge, 'getState' | 'check' | 'setAutoCheck' | 'openRelease' | 'download' | 'install'> = {
    getState: vi.fn(async () => state), check: vi.fn(async () => state), setAutoCheck: vi.fn(async () => state),
    openRelease: vi.fn(async () => {}), download: vi.fn(async () => {}), install: vi.fn(async () => {}),
  }
  const guard = new UpdateRestartGuard({
    operations: new DesktopOperations(), requestRenderer: vi.fn(), resumeRenderer: vi.fn(),
    rendererAvailable: () => true, hasActiveWork: () => false, cleanup: async () => {},
  })
  let resolve!: (value: typeof service) => void
  const ready = deferred ? new Promise<typeof service>((complete) => { resolve = complete }) : service
  registerUpdateBridge(requireWindow, ready, guard)
  const invoke = (name: string, event = trusted, ...values: unknown[]) => {
    const handler = handlers.get(`updates:${name}`)
    if (!handler) throw new Error('Missing handler')
    return handler(event, ...values)
  }
  return { service, guard, invoke, trusted, resolve: () => resolve(service) }
}

describe('trusted update IPC', () => {
  it('allows lazy update initialization without weakening sender validation', async () => {
    const { invoke, resolve, service } = fixture(true)
    const pending = invoke('getState')
    expect(service.getState).not.toHaveBeenCalled()
    expect(() => invoke('check', {} as IpcMainInvokeEvent)).toThrow('Untrusted')
    resolve()
    await expect(pending).resolves.toMatchObject({ phase: 'idle' })
    expect(service.getState).toHaveBeenCalledOnce()
  })

  it.each(['getState', 'check', 'openRelease', 'download', 'install', 'setAutoCheck', 'respondToInstall'])('requires the original window for %s', (action) => {
    const { invoke, service } = fixture()
    expect(() => invoke(action, {} as IpcMainInvokeEvent)).toThrow('Untrusted')
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })

  it('accepts only explicit parameterless actions, never a renderer-provided URL or install path', async () => {
    const { invoke, service, trusted } = fixture()
    for (const action of ['getState', 'check', 'openRelease', 'download', 'install']) {
      expect(() => invoke(action, trusted, 'https://untrusted.example/installer.exe')).toThrow()
      await invoke(action)
    }
    expect(service.download).toHaveBeenCalledExactlyOnceWith()
    expect(service.install).toHaveBeenCalledExactlyOnceWith()
  })

  it('validates preference updates and acknowledgement bounds', async () => {
    const { invoke, service, guard, trusted } = fixture()
    expect(() => invoke('setAutoCheck', trusted, 'false')).toThrow()
    expect(() => invoke('setAutoCheck', trusted, false, true)).toThrow()
    await invoke('setAutoCheck', trusted, false)
    expect(service.setAutoCheck).toHaveBeenCalledExactlyOnceWith(false)
    const respond = vi.spyOn(guard, 'respond').mockImplementation(() => {})
    const id = crypto.randomUUID()
    expect(() => invoke('respondToInstall', trusted, id, Array(33).fill('blocker'))).toThrow()
    expect(() => invoke('respondToInstall', trusted, id, ['a'.repeat(501)])).toThrow()
    expect(() => invoke('respondToInstall', trusted, 'invalid', [])).toThrow()
    await invoke('respondToInstall', trusted, id, ['Unsent draft'])
    expect(respond).toHaveBeenCalledExactlyOnceWith(id, ['Unsent draft'])
  })
})
