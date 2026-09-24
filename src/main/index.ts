import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, Menu, net, protocol } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_URL, PRODUCTION_CSP, isTrustedRendererUrl, rendererSecurityPreferences, resolveRendererAsset, validateDevUrl } from './security'
import { registerWorkspaceBridge } from './workspaceBridge'
import { registerRemoteVSCodeBridge } from './remoteVSCodeBridge'
import { registerWindowZoom, WindowZoomPreferences } from './windowZoom'
import { registerAgentHostBridge } from './agentHostBridge'
import { startAgentHostDiagnostics, stopAgentHostDiagnostics } from './agentHostDiagnostics'

app.setName('Task Continuum')
if (process.platform === 'win32') app.setAppUserModelId('com.leoncl2025.taskcontinuum')
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
let agentHost: ReturnType<typeof registerAgentHostBridge> | undefined
let remoteVSCode: ReturnType<typeof registerRemoteVSCodeBridge> | undefined
let windowZoom: WindowZoomPreferences | undefined
let quitting = false
let cleanupComplete = false
const primaryInstance = app.requestSingleInstanceLock()

if (!primaryInstance) app.quit()
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

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
  ipcMain.handle('desktop:copy-text', (event, value: unknown) => {
    requireTrustedWindow(event)
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('Clipboard text must be a string no larger than 1 MiB.')
    return clipboard.writeText(value)
  })
}

async function createWindow(): Promise<void> {
  const zoom = windowZoom ??= new WindowZoomPreferences(app.getPath('userData'))
  await zoom.load()
  const window = new BrowserWindow({
    title: 'Task Continuum',
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png'),
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
      zoomFactor: 1.2 ** zoom.getLevel(),
    },
  })
  mainWindow = window
  registerWindowZoom(window, zoom, devUrl)
  let initialNavigation = true
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) { if (initialNavigation) { initialNavigation = false; return }; agentHost?.close() } })
  const closeConnections = () => {
    agentHost?.close()
    void remoteVSCode?.close().catch((error: unknown) => console.error('Remote device shutdown failed:', error))
  }
  window.webContents.on('render-process-gone', closeConnections)
  window.webContents.on('destroyed', closeConnections)
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
  window.on('closed', () => { mainWindow = undefined })
  await window.loadURL(devUrl ?? APP_URL)
  if (!window.isDestroyed()) window.show()
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return
  if (process.env.TASKCONTINUUM_AHP_DIAGNOSTICS && !['0', '1'].includes(process.env.TASKCONTINUUM_AHP_DIAGNOSTICS)) {
    throw new Error('TASKCONTINUUM_AHP_DIAGNOSTICS must be 1 or 0.')
  }
  if (process.env.TASKCONTINUUM_AHP_DIAGNOSTICS === '1') await startAgentHostDiagnostics(app.getPath('userData'))
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
  const workspaces = registerWorkspaceBridge(requireTrustedWindow, async (root, target) => {
    if (!remoteVSCode) throw new Error('Agent Host access is not ready.')
    return remoteVSCode.agentHosts.verifyLink(root, target)
  }, async (root) => { await remoteVSCode?.gitSync.open(root) })
  remoteVSCode = registerRemoteVSCodeBridge(requireTrustedWindow, workspaces.currentRoot, () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-vscode:git-bindings-changed')
  })
  await remoteVSCode.filesReady
  agentHost = registerAgentHostBridge(requireTrustedWindow, workspaces.currentRoot, remoteVSCode.agentHosts)
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
  agentHost?.close()
  void Promise.all([remoteVSCode?.close(), windowZoom?.flush()]).finally(() => stopAgentHostDiagnostics()).catch((error: unknown) => console.error(error)).finally(() => {
    cleanupComplete = true
    app.quit()
  })
})