// @vitest-environment node
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerFileDeliveryBridge } from '../src/main/fileDeliveryBridge'
import type { FileDeliveryService } from '../src/main/fileDeliveryService'
import type { FileTransferApi } from '../src/shared/fileTransfer'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<unknown>>(),
  confirm: vi.fn(), folder: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => 'C:\\private-profile', getAppPath: () => 'C:\\installed-tc' },
  ipcMain: { handle: (name: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<unknown>) => { ipc.handlers.set(name, handler) } },
  dialog: { showMessageBox: ipc.confirm, showOpenDialog: ipc.folder },
}))
beforeEach(() => { vi.clearAllMocks(); ipc.handlers.clear() })

function fixture() {
  let root = 'C:\\workspace'
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } } as unknown as BrowserWindow
  const status = { transferId: randomUUID(), deviceId: 'local' as const, state: 'interrupted' as const, files: [], receivedBytes: 0, expiresAt: '2030-01-01T00:00:00Z' }
  const api = {
    devices: async () => [], fetch: async () => status, status: async () => status,
    resume: vi.fn(async () => status), cancel: vi.fn(async () => status),
    read: async () => ({ fileId: randomUUID(), text: '', offset: 0, nextOffset: 0, eof: true, truncated: false }),
  } satisfies FileTransferApi
  const service = {
    preferences: vi.fn<FileDeliveryService['preferences']>(async () => ({ inboxId: randomUUID(), senders: [], roots: [], transfers: [] })),
    setSender: vi.fn<FileDeliveryService['setSender']>(async () => {}),
    addDestination: vi.fn<FileDeliveryService['addDestination']>(async () => {}),
    removeDestination: vi.fn<FileDeliveryService['removeDestination']>(async () => {}),
    forWorkspace: vi.fn<FileDeliveryService['forWorkspace']>(() => api),
  }
  registerFileDeliveryBridge(() => window, async () => root, service, Promise.resolve())
  const invoke = (name: string, ...args: unknown[]) => ipc.handlers.get(`file-delivery:${name}`)!({} as IpcMainInvokeEvent, ...args)
  return { service, invoke, api, status, change: () => { root = 'C:\\other-workspace' } }
}

it('requires native approval to enable a sender, permits immediate revocation, and rejects malformed IPC', async () => {
  const setup = fixture()
  const id = randomUUID()
  ipc.confirm.mockResolvedValueOnce({ response: 0 })
  await setup.invoke('sender', id, true)
  expect(setup.service.setSender).not.toHaveBeenCalled()
  ipc.confirm.mockResolvedValueOnce({ response: 1 })
  await setup.invoke('sender', id, true)
  expect(setup.service.setSender).toHaveBeenLastCalledWith('C:\\workspace', id, true)
  await setup.invoke('sender', id, false)
  expect(setup.service.setSender).toHaveBeenLastCalledWith('C:\\workspace', id, false)
  expect(ipc.confirm).toHaveBeenCalledTimes(2)
  await expect(setup.invoke('sender', id, 'true')).rejects.toThrow()
})

it('does not grant a sender or directory after the workspace changes during native confirmation', async () => {
  const first = fixture()
  ipc.confirm.mockImplementationOnce(async () => { first.change(); return { response: 1 } })
  await expect(first.invoke('sender', randomUUID(), true)).rejects.toThrow('workspace or window changed')
  expect(first.service.setSender).not.toHaveBeenCalled()
  const second = fixture()
  ipc.folder.mockImplementationOnce(async () => { second.change(); return { canceled: false, filePaths: ['C:\\received'] } })
  await expect(second.invoke('add-destination')).rejects.toThrow('workspace or window changed')
  expect(second.service.addDestination).not.toHaveBeenCalled()
})

it('generates host-specific stdio configuration using the actual profile and workspace without descriptor credentials', async () => {
  const setup = fixture()
  const result = await setup.invoke('settings')
  expect(result).toMatchObject({ configurations: { vscode: expect.any(String), mcpServers: expect.any(String) } })
  if (!result || typeof result !== 'object' || !('configurations' in result)) throw new Error('Expected generated configuration.')
  const configurations = result.configurations
  if (!configurations || typeof configurations !== 'object' || !('vscode' in configurations) || typeof configurations.vscode !== 'string') throw new Error('Expected VS Code configuration.')
  expect(JSON.parse(configurations.vscode)).toEqual({ servers: { 'taskcontinuum-files': {
    type: 'stdio', command: 'node', args: ['C:\\installed-tc\\out\\cli\\taskcontinuum-files-mcp.cjs'],
    env: { TASKCONTINUUM_WORKSPACE: 'C:\\workspace', TASKCONTINUUM_DATA_DIR: 'C:\\private-profile', TASKCONTINUUM_MCP_FEATURES: 'delivery' },
  } } })
  expect(configurations.vscode).not.toContain('token')
  expect(setup.service.setSender).not.toHaveBeenCalled()
})
