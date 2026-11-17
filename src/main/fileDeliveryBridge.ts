import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { FileDeliveryService } from './fileDeliveryService'
import { FileTransferError } from '../shared/fileTransfer'
import { handleDesktopOperation } from './desktopOperations'

const execute = promisify(execFile)

export function registerFileDeliveryBridge(
  requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, currentRoot: () => Promise<string>,
  service: Pick<FileDeliveryService, 'preferences' | 'setSender' | 'addDestination' | 'removeDestination' | 'forWorkspace'>, ready: Promise<unknown>,
): void {
  function handle(channel: string, action: (window: BrowserWindow, root: string, check: () => Promise<void>, ...values: unknown[]) => Promise<unknown>): void {
    handleDesktopOperation(ipcMain, `file-delivery:${channel}`, async (event, ...values: unknown[]) => {
      const window = requireWindow(event)
      const root = await currentRoot()
      const check = async () => {
        if (window.isDestroyed() || window.webContents.isDestroyed() || requireWindow(event) !== window || await currentRoot() !== root) {
          throw new FileTransferError('ACCESS_DENIED', 'The workspace or window changed. Reopen MCP settings.')
        }
      }
      await check()
      await ready
      await check()
      const result = await action(window, root, check, ...values)
      await check()
      return result
    })
  }
  handle('settings', async (_window, root) => {
    const preferences = await service.preferences(root)
    let nodeVersion: string
    try { nodeVersion = (await execute('node', ['--version'], { timeout: 3000, maxBuffer: 1024, windowsHide: true })).stdout.trim() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FileTransferError('IO_ERROR', 'Could not inspect the Node executable on PATH.')
      nodeVersion = 'Not found'
    }
    const entry = app.isPackaged ? join(process.resourcesPath, 'cli', 'taskcontinuum-files-mcp.cjs')
      : join(app.getAppPath(), 'out', 'cli', 'taskcontinuum-files-mcp.cjs')
    const configuration = { command: 'node', args: [entry], env: {
      TASKCONTINUUM_WORKSPACE: root, TASKCONTINUUM_DATA_DIR: app.getPath('userData'), TASKCONTINUUM_MCP_FEATURES: 'delivery',
    } }
    return { ...preferences, nodeVersion, configurations: {
      vscode: JSON.stringify({ servers: { 'taskcontinuum-files': { type: 'stdio', ...configuration } } }, null, 2),
      mcpServers: JSON.stringify({ mcpServers: { 'taskcontinuum-files': configuration } }, null, 2),
    } }
  })
  handle('sender', async (window, root, check, id, enabled) => {
    const clientId = z.uuid().parse(id)
    const allowed = z.boolean().parse(enabled)
    if (allowed) {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Allow incoming file delivery?',
        message: 'Allow this paired TC client to deliver files to this workspace inbox without per-file prompts?',
        detail: `Client: ${clientId}\nFiles stay in private retained storage. This does not grant writes to working directories, overwrite files, execute content, or send messages to an agent.`,
        buttons: ['Cancel', 'Allow receiving'], defaultId: 0, cancelId: 0,
      })
      await check()
      if (result.response !== 1) return
    }
    await service.setSender(root, clientId, allowed)
  })
  handle('add-destination', async (window, root, check) => {
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Authorize an MCP save directory (existing files are never overwritten)',
      properties: ['openDirectory'],
    })
    await check()
    if (!chosen.canceled && chosen.filePaths[0]) await service.addDestination(root, chosen.filePaths[0])
  })
  handle('remove-destination', async (_window, root, _check, id) => service.removeDestination(root, z.uuid().parse(id)))
  handle('resume', async (_window, root, _check, id) => service.forWorkspace(root).resume(z.uuid().parse(id)))
  handle('cancel', async (_window, root, _check, id) => service.forWorkspace(root).cancel(z.uuid().parse(id)))
}
