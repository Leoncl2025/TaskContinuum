import { app, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { canOpenChatDocument, parseChatLink } from '../shared/chatLinks'
import { FILE_TRANSFER_LIMITS, FileTransferError, transferFailure } from '../shared/fileTransfer'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { ChatLinkService } from './chatLinkService'

const openSchema = z.object({ href: z.string().min(1).max(8192), requestId: z.uuid(), target: agentHostTargetSchema.optional() }).strict()
const referenceSchema = z.object({ transferId: z.uuid(), target: agentHostTargetSchema }).strict()
const previewSchema = referenceSchema.extend({
  fileId: z.uuid(), offset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().min(4).max(FILE_TRANSFER_LIMITS.readBytes).optional(),
}).strict()
const saveSchema = previewSchema.extend({ openAfterSave: z.boolean().optional() }).strict()

function suggestedName(value: string): string {
  const name = value.replace(/[\\/:*?"<>|\p{Cc}\p{Zl}\p{Zp}]/gu, '_').replace(/[. ]+$/, '').slice(0, 200)
  return name && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? name : 'received-file'
}

export function registerChatLinkBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
  currentRoot: () => Promise<string>, service: Pick<ChatLinkService, 'open' | 'status' | 'preview' | 'file' | 'save' | 'cancel'>): void {
  function handle(channel: string, action: (value: unknown, window: BrowserWindow, check: (root?: string) => Promise<void>) => Promise<unknown>) {
    ipcMain.handle(`desktop:chat-link-${channel}`, async (event, value: unknown) => {
      const window = requireWindow(event)
      const check = async (root?: string) => {
        if (window.isDestroyed() || window.webContents.isDestroyed() || requireWindow(event) !== window
          || root !== undefined && await currentRoot() !== root) {
          throw new FileTransferError('ACCESS_DENIED', 'The original workspace or window changed. Open the link again from its chat.')
        }
      }
      try { return { ok: true, result: await action(value, window, check) } }
      catch (error) { return { ok: false, error: transferFailure(error) } }
    })
  }
  handle('open', async (value, _window, check) => {
    const request = openSchema.parse(value)
    const link = parseChatLink(request.href)
    const root = link?.kind === 'file' ? await currentRoot() : undefined
    return service.open(root, request, () => check(root))
  })
  handle('menu', async (value, window, check) => {
    const href = z.string().min(1).max(8192).parse(value)
    if (!parseChatLink(href)) throw new FileTransferError('INVALID_REQUEST', 'This link type is not supported.')
    await check()
    return new Promise<{ copied: boolean }>((resolve, reject) => {
      let copied = false
      Menu.buildFromTemplate([{
        label: 'Copy link address',
        click: () => {
          try {
            if (window.isDestroyed()) throw new Error('The link window closed.')
            clipboard.writeText(href)
            copied = true
          } catch { reject(new FileTransferError('IO_ERROR', 'The link address could not be copied.')) }
        },
      }]).popup({ window, callback: () => resolve({ copied }) })
    })
  })
  handle('status', async (value, _window, check) => {
    const request = referenceSchema.parse(value)
    const root = await currentRoot()
    return service.status(root, request, () => check(root))
  })
  handle('preview', async (value, _window, check) => {
    const request = previewSchema.parse(value)
    const root = await currentRoot()
    return service.preview(root, request, () => check(root))
  })
  handle('cancel', async (value, _window, check) => {
    const request = referenceSchema.parse(value)
    const root = await currentRoot()
    return service.cancel(root, request, () => check(root))
  })
  handle('save', async (value, window, check) => {
    const request = saveSchema.parse(value)
    const root = await currentRoot()
    const file = await service.file(root, request, () => check(root))
    if (request.openAfterSave && !canOpenChatDocument(file.name)) {
      throw new FileTransferError('UNSUPPORTED', 'This file can be previewed or saved, but it is not opened as an executable or script.')
    }
    const chosen = await dialog.showSaveDialog(window, {
      title: 'Save received file', defaultPath: join(app.getPath('downloads'), suggestedName(file.name)),
      properties: ['showOverwriteConfirmation'],
    })
    await check(root)
    if (chosen.canceled || !chosen.filePath) return { saved: false }
    if (request.openAfterSave && (!canOpenChatDocument(chosen.filePath) || !isAbsolute(chosen.filePath)
      || /^[\\/]{2}/.test(chosen.filePath) || process.platform === 'win32' && chosen.filePath.slice(2).includes(':'))) {
      throw new FileTransferError('UNSUPPORTED', 'Choose a local document filename with a supported extension to save and open it.')
    }
    await service.save(root, request, chosen.filePath, () => check(root))
    if (request.openAfterSave) {
      await service.file(root, request, () => check(root))
      await check(root)
      const error = await shell.openPath(chosen.filePath)
      if (error) throw new FileTransferError('IO_ERROR', 'The local copy was saved, but its default application could not open it. Check the file association.')
      return { saved: true, opened: true }
    }
    return { saved: true }
  })
}
