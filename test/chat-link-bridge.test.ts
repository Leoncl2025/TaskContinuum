import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { registerChatLinkBridge } from '../src/main/chatLinkBridge'
import type { ChatLinkService } from '../src/main/chatLinkService'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => Promise<unknown>>(),
  save: vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined })),
  openPath: vi.fn(async () => ''),
  copy: vi.fn(),
  menuClick: true,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    isDestroyed() { return false }
    webContents = { isDestroyed: () => false }
  },
  app: { getPath: () => 'C:\\Downloads' },
  ipcMain: { handle: (name: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => { mocks.handlers.set(name, handler) } },
  dialog: { showSaveDialog: mocks.save },
  shell: { openPath: mocks.openPath },
  clipboard: { writeText: mocks.copy },
  Menu: { buildFromTemplate: (items: { label: string; click(): void }[]) => ({
    popup: ({ callback }: { callback(): void }) => { if (mocks.menuClick) items[0].click(); callback() },
  }) },
}))

beforeEach(() => {
  mocks.handlers.clear()
  mocks.save.mockReset().mockResolvedValue({ canceled: true, filePath: undefined })
  mocks.openPath.mockReset().mockResolvedValue('')
  mocks.copy.mockReset()
  mocks.menuClick = true
})

function fixture() {
  const target = agentHostTargetFixture('link')
  const reference = { target, transferId: crypto.randomUUID(), fileId: crypto.randomUUID() }
  const service: Pick<ChatLinkService, 'open' | 'status' | 'preview' | 'file' | 'save' | 'cancel'> = {
    open: vi.fn<ChatLinkService['open']>(async (_root, _request, check) => { await check(); return { kind: 'external' } }),
    status: vi.fn(), preview: vi.fn(), cancel: vi.fn(),
    file: vi.fn(async () => ({ fileId: reference.fileId, name: '..\\unsafe/name.txt', sizeBytes: 1, sha256: 'a'.repeat(64), mediaType: 'text/plain' })),
    save: vi.fn(async (_root, _request, _destination, check) => { await check() }),
  }
  let root = 'C:\\workspace'
  const currentRoot = vi.fn(async () => root)
  const window = new BrowserWindow()
  const requireWindow = vi.fn(() => window)
  registerChatLinkBridge(requireWindow, currentRoot, service)
  const invoke = (name: string, value: unknown) => mocks.handlers.get(`desktop:chat-link-${name}`)!({}, value)
  return { invoke, service, reference, target, currentRoot, requireWindow, changeRoot: () => { root = 'C:\\other' } }
}

describe('trusted link IPC boundary', () => {
  it('copies only the original requested URL through the native link menu', async () => {
    const f = fixture()
    expect(await f.invoke('menu', 'file:///C:/Server/report.txt:12')).toEqual({ ok: true, result: { copied: true } })
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith('file:///C:/Server/report.txt:12')
    expect(f.service.open).not.toHaveBeenCalled()
    expect(f.currentRoot).not.toHaveBeenCalled()
    mocks.menuClick = false
    expect(await f.invoke('menu', 'https://example.com/42')).toEqual({ ok: true, result: { copied: false } })
    expect(mocks.copy).toHaveBeenCalledOnce()
    expect(await f.invoke('menu', 'javascript:bad()')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('saves the complete file before opening it on the client and reports native opening failure', async () => {
    const f = fixture()
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:\\Downloads\\chosen.txt' })
    let saved = false
    vi.mocked(f.service.save).mockImplementation(async () => { saved = true })
    mocks.openPath.mockImplementation(async () => { expect(saved).toBe(true); return '' })
    const request = { ...f.reference, openAfterSave: true }
    expect(await f.invoke('save', request)).toEqual({ ok: true, result: { saved: true, opened: true } })
    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith('C:\\Downloads\\chosen.txt')
    mocks.openPath.mockResolvedValueOnce('No associated application')
    expect(await f.invoke('save', request)).toMatchObject({ ok: false, error: { code: 'IO_ERROR', message: expect.stringContaining('was saved') } })
  })

  it('does not open executable filenames, network paths or an unapproved source type', async () => {
    const f = fixture()
    const request = { ...f.reference, openAfterSave: true }
    for (const filePath of ['C:\\Downloads\\script.ps1', 'C:\\Downloads\\shortcut.lnk', '\\\\server\\share\\file.txt', 'C:\\Downloads\\file:stream.txt']) {
      mocks.save.mockResolvedValueOnce({ canceled: false, filePath })
      expect(await f.invoke('save', request)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } })
    }
    vi.mocked(f.service.file).mockResolvedValueOnce({ fileId: f.reference.fileId, name: 'danger.exe', sizeBytes: 1, sha256: 'a'.repeat(64), mediaType: 'application/octet-stream' })
    expect(await f.invoke('save', request)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } })
    expect(f.service.save).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('does not open a local file if its original workspace changes during saving', async () => {
    const f = fixture()
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: 'C:\\Downloads\\chosen.txt' })
    vi.mocked(f.service.save).mockImplementation(async () => f.changeRoot())
    expect(await f.invoke('save', { ...f.reference, openAfterSave: true })).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } })
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('requires the trusted main frame and does not accept arbitrary file paths or destinations on preview/save requests', async () => {
    const f = fixture()
    f.requireWindow.mockImplementationOnce(() => { throw new Error('Untrusted frame') })
    await expect(f.invoke('open', { href: 'https://example.com', requestId: crypto.randomUUID() })).rejects.toThrow('Untrusted frame')
    expect(f.service.open).not.toHaveBeenCalled()
    expect(await f.invoke('preview', { ...f.reference, path: 'C:\\private' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(await f.invoke('save', { ...f.reference, destination: 'C:\\arbitrary' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    expect(f.service.preview).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('opens supported web links without loading workspace or file state', async () => {
    const f = fixture()
    const request = { href: 'https://example.com/pr/42', requestId: crypto.randomUUID() }
    expect(await f.invoke('open', request)).toEqual({ ok: true, result: { kind: 'external' } })
    expect(f.currentRoot).not.toHaveBeenCalled()
    expect(f.service.open).toHaveBeenCalledExactlyOnceWith(undefined, request, expect.any(Function))
  })

  it('reports a workspace change while a file action is pending instead of using the replacement root', async () => {
    const f = fixture()
    vi.mocked(f.service.open).mockImplementation(async (_root, _request, check) => {
      f.changeRoot()
      await check()
      return { kind: 'external' }
    })
    expect(await f.invoke('open', { href: 'file:///C:/report.txt', target: f.target, requestId: crypto.randomUUID() }))
      .toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED', message: expect.stringContaining('original workspace') } })
  })

  it('uses a native Save As choice, sanitizes suggested names and never silently saves on cancellation', async () => {
    const f = fixture()
    expect(await f.invoke('save', f.reference)).toEqual({ ok: true, result: { saved: false } })
    expect(f.service.save).not.toHaveBeenCalled()
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: 'Save received file', defaultPath: 'C:\\Downloads\\.._unsafe_name.txt',
    }))
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: 'C:\\Downloads\\chosen.txt' })
    expect(await f.invoke('save', f.reference)).toEqual({ ok: true, result: { saved: true } })
    expect(f.service.save).toHaveBeenCalledExactlyOnceWith('C:\\workspace', f.reference, 'C:\\Downloads\\chosen.txt', expect.any(Function))
    mocks.save.mockImplementationOnce(async () => { f.changeRoot(); return { canceled: false, filePath: 'C:\\Downloads\\not-used.txt' } })
    expect(await f.invoke('save', f.reference)).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } })
    expect(f.service.save).toHaveBeenCalledOnce()
  })

  it('does not expose private exception paths or stacks to the renderer', async () => {
    const f = fixture()
    vi.mocked(f.service.open).mockRejectedValueOnce(new Error('C:\\private\\token.txt could not be read'))
    const result = await f.invoke('open', { href: 'https://example.com', requestId: crypto.randomUUID() })
    expect(result).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('token.txt')
  })
})
