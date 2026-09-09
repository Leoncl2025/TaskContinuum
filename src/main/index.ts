import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, net, protocol } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_URL, PRODUCTION_CSP, isTrustedRendererUrl, rendererSecurityPreferences, resolveRendererAsset, validateDevUrl } from './security'
import { registerCopilotBridge } from './copilotBridge'
import { registerWorkspaceBridge } from './workspaceBridge'
import { registerSharedBridge } from './sharedBridge'
import { registerVSCodeChatBridge } from './vscodeChatBridge'
import { registerRemoteVSCodeBridge } from './remoteVSCodeBridge'

app.setName('Task Continuum')
const dataDirectory = process.env.TASKCONTINUUM_DATA_DIR
if (dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true })
  app.setPath('userData', dataDirectory)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'taskcontinuum', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const devUrl = app.isPackaged ? undefined : validateDevUrl(process.env.ELECTRON_RENDERER_URL)
let mainWindow: BrowserWindow | undefined
let copilotHost: ReturnType<typeof registerCopilotBridge> | undefined
let sharedDesktop: ReturnType<typeof registerSharedBridge> | undefined
let vscodeChat: ReturnType<typeof registerVSCodeChatBridge> | undefined
let remoteVSCode: ReturnType<typeof registerRemoteVSCodeBridge> | undefined
let quitting = false
let cleanupComplete = false

function requireTrustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url, devUrl)) {
    throw new Error('Untrusted desktop IPC request.')
  }
  return mainWindow
}

function registerDesktopBridge(): void {
  ipcMain.handle('desktop:info', (event) => {
    requireTrustedWindow(event)
    return { name: app.name, version: app.getVersion(), platform: process.platform }
  })
  ipcMain.handle('desktop:minimize', (event) => requireTrustedWindow(event).minimize())
  ipcMain.handle('desktop:toggle-maximize', (event) => {
    const window = requireTrustedWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle('desktop:close', (event) => requireTrustedWindow(event).close())
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: 'Task Continuum',
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      ...rendererSecurityPreferences,
      spellcheck: false,
    },
  })
  mainWindow = window
  let initialNavigation = true
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { if (initialNavigation) { initialNavigation = false; return }; copilotHost?.cancelAll(); vscodeChat?.close() } })
  window.webContents.on('render-process-gone', () => { copilotHost?.cancelAll(); void remoteVSCode?.close().catch(() => undefined) })
  window.webContents.on('destroyed', () => { copilotHost?.cancelAll(); vscodeChat?.close(); void remoteVSCode?.close().catch(() => undefined) })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  if (devUrl) {
    const origin = new URL(devUrl).origin
    const policy = PRODUCTION_CSP
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'none'", `connect-src 'self' ${origin.replace('http:', 'ws:')}`)
    window.webContents.session.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } })
    })
  }
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => { mainWindow = undefined })
  await window.loadURL(devUrl ?? APP_URL)
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const rendererRoot = join(__dirname, '../renderer')
  protocol.handle('taskcontinuum', async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const file = resolveRendererAsset(request.url, rendererRoot)
    if (!file) return new Response(null, { status: 404 })
    try {
      const response = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', PRODUCTION_CSP)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  registerDesktopBridge()
  copilotHost = registerCopilotBridge(requireTrustedWindow, () => mainWindow)
  const workspaces = registerWorkspaceBridge(requireTrustedWindow, copilotHost.allowDirectory, async (root, target) => remoteVSCode?.manager.remoteOwner(root, target))
  remoteVSCode = registerRemoteVSCodeBridge(requireTrustedWindow, workspaces.currentRoot)
  vscodeChat = registerVSCodeChatBridge(requireTrustedWindow, () => mainWindow, remoteVSCode.manager, workspaces.currentRoot)
  sharedDesktop = registerSharedBridge(requireTrustedWindow, () => mainWindow, workspaces.currentRoot, copilotHost.requireDirectory)
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error: unknown) => { console.error(error); app.exit(1) })
    }
  })
}).catch((error: unknown) => { console.error(error); app.exit(1) })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  if (cleanupComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void Promise.all([copilotHost?.disconnect(), sharedDesktop?.close(), remoteVSCode?.close()]).catch((error: unknown) => console.error(error)).finally(() => {
    cleanupComplete = true
    app.quit()
  })
  if (!copilotHost) { cleanupComplete = true; app.quit() }
})