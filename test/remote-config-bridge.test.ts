import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { registerGitSyncBridge } from '../src/main/remoteConfig/bridge'
import type { GitSyncActions } from '../src/main/remoteConfig/bridge'
import type { WorkspaceGitSyncStatus } from '../src/shared/gitSync'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  consent: vi.fn<(window: unknown, options: { detail: string }) => Promise<{ response: number }>>(async () => ({ response: 0 })),
  open: vi.fn(async () => ''),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => { mocks.handlers.set(name, handler) } },
  dialog: { showMessageBox: mocks.consent },
  shell: { openPath: mocks.open },
}))

beforeEach(() => {
  mocks.handlers.clear()
  mocks.consent.mockReset().mockResolvedValue({ response: 0 })
  mocks.open.mockReset().mockResolvedValue('')
})

function setup() {
  const status: WorkspaceGitSyncStatus = { enabled: false, state: 'disabled', intervalMs: 15000, pending: 0, provisionalTasks: [], peers: [], conflicts: [], revision: null }
  const service: GitSyncActions = {
    status: vi.fn(async () => status), enable: vi.fn(async () => {}), disable: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}), revokeDevice: vi.fn(async () => {}), setSettings: vi.fn(async () => {}),
  }
  const currentRoot = vi.fn(async () => 'Q:\\workspace')
  const requireWindow = vi.fn(() => new BrowserWindow())
  registerGitSyncBridge(requireWindow, currentRoot, service)
  const invoke = (name: string, value?: unknown) => {
    const handler = mocks.handlers.get(`remote-vscode:git-${name}`)
    if (!handler) throw new Error(`Missing handler ${name}`)
    return handler({}, value)
  }
  return { service, currentRoot, requireWindow, invoke }
}

describe('Git synchronization IPC boundary', () => {
  it('requires local confirmation before enabling publication and preserves the selected root', async () => {
    const { service, invoke, currentRoot, requireWindow } = setup()
    expect(await invoke('enable')).toBe(false)
    expect(service.enable).not.toHaveBeenCalled()
    const detail = mocks.consent.mock.calls[0]?.[1]?.detail
    expect(detail).toContain('Legacy session files and browser bindings are not imported')
    expect(detail).toContain('automatically receive read and send access')
    expect(detail).toContain('permission to explicitly create Agent Host sessions')
    expect(detail).toContain('no separate session-access switch is required')
    expect(detail).toContain('No session is created and no prompt is sent just by linking')
    expect(detail).toContain('native tool approvals remain on the execution machine')
    expect(detail).not.toContain('(read only)')
    expect(detail).not.toContain('migrate current bindings')
    mocks.consent.mockResolvedValue({ response: 1 })
    expect(await invoke('enable')).toBe(true)
    expect(service.enable).toHaveBeenCalledExactlyOnceWith('Q:\\workspace')
    expect(requireWindow).toHaveBeenCalled()
    currentRoot.mockResolvedValueOnce('Q:\\workspace').mockResolvedValueOnce('Q:\\different')
    await expect(invoke('enable')).rejects.toThrow('changed')
    expect(service.enable).toHaveBeenCalledTimes(1)
  })

  it('validates typed settings and preserves explicit deletion rather than silently writing defaults', async () => {
    const { service, invoke } = setup()
    await invoke('setting', { key: 'autoLink', value: null, expectedRevision: null })
    expect(service.setSettings).toHaveBeenCalledExactlyOnceWith('Q:\\workspace', null, { autoLink: null })
    await expect(invoke('setting', { key: 'pollIntervalMs', value: 1, expectedRevision: null })).rejects.toThrow()
    await expect(invoke('setting', { key: 'connectTimeoutMs', value: 999999, expectedRevision: null })).rejects.toThrow()
    await expect(invoke('setting', { key: 'autoLink', value: 10, expectedRevision: null })).rejects.toThrow()
    expect(service.setSettings).toHaveBeenCalledTimes(1)
  })

  it('opens only the server-selected local editor and surfaces native failures', async () => {
    const { service, invoke } = setup()
    await expect(invoke('open-settings')).rejects.toThrow('Enable workspace')
    const status = await service.status('Q:\\workspace')
    vi.mocked(service.status).mockResolvedValue({ ...status, settingsFile: 'Q:\\appdata\\settings.json' })
    await invoke('open-settings', 'Q:\\untrusted-command')
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('Q:\\appdata\\settings.json')
    mocks.open.mockResolvedValue('No associated editor.')
    await expect(invoke('open-settings')).rejects.toThrow('No associated editor')
  })
})
