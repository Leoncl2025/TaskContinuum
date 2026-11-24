import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, screen, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_URL, PRODUCTION_CSP, rendererSecurityPreferences, resolveRendererAsset, validateDevUrl } from './security'
import { registerWorkspaceBridge } from './workspaceBridge'
import { registerRemoteVSCodeBridge } from './remoteVSCodeBridge'
import { registerWindowZoom, WindowZoomPreferences } from './windowZoom'
import { registerWindowFullscreen, toggleWindowFullscreen } from './windowFullscreen'
import { registerAgentHostBridge } from './agentHostBridge'
import { registerChatLinkBridge } from './chatLinkBridge'
import { startAgentHostDiagnostics, stopAgentHostDiagnostics } from './agentHostDiagnostics'
import { UpdateRestartGuard } from './updateRestartGuard'
import { desktopOperations, handleDesktopOperation } from './desktopOperations'
import { createDesktopUpdateService } from './updates'
import { registerUpdateBridge } from './updateBridge'
import { MultiWindowInstallCoordinator, SessionWindowManager } from './sessionWindows'
import { resolveLocalUserProfile } from './userProfile'
import type { SessionWindowBounds } from '../shared/desktop'

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
let sessionWindows: SessionWindowManager | undefined
let agentHost: ReturnType<typeof registerAgentHostBridge> | undefined
let remoteVSCode: ReturnType<typeof registerRemoteVSCodeBridge> | undefined
let windowZoom: WindowZoomPreferences | undefined
let rendererSessionConfigured = false
let quitting = false
let cleanupComplete = false
let cleanupPromise: Promise<void> | undefined
let updateRestart: UpdateRestartGuard | undefined
let updates: Awaited<ReturnType<typeof createDesktopUpdateService>> | undefined
const primaryInstance = app.requestSingleInstanceLock()

if (!primaryInstance) app.quit()
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function cleanupDesktop(): Promise<void> {
  return cleanupPromise ??= (async () => {
    sessionWindows?.prepareMainWindowClose()
    sessionWindows?.closeAllPopouts(true)
    const results = await Promise.allSettled([
      Promise.resolve().then(() => agentHost?.close()),
      Promise.resolve().then(() => remoteVSCode?.close()),
      Promise.resolve().then(() => windowZoom?.flush()),
      Promise.resolve().then(() => sessionWindows?.flush()),
      Promise.resolve().then(() => updates?.flushPreferences()),
    ])
    const diagnostics = await Promise.allSettled([stopAgentHostDiagnostics()])
    const failures = [...results, ...diagnostics].filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application services or local state could not finish closing.')
    cleanupComplete = true
  })().catch((error: unknown) => { cleanupPromise = undefined; throw error })
}

async function recoverAfterUpdateFailure(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'error', title: 'Restart required',
    message: 'The update could not finish after application services were stopped.',
    detail: 'Restart the current application before continuing. No session was deleted and no message will be replayed.',
    buttons: ['Restart application', 'Close application'], defaultId: 0, cancelId: 1,
  })
  if (result.response === 0) app.relaunch()
  app.quit()
}

function requireTrustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!sessionWindows) throw new Error('Untrusted desktop IPC request.')
  return sessionWindows.requireTrustedWindow(event)
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (!sessionWindows) throw new Error('Untrusted desktop IPC request.')
  return sessionWindows.requireMainWindow(event)
}

function registerDesktopBridge(): void {
  ipcMain.handle('desktop:info', async (event) => {
    requireTrustedWindow(event)
    const userProfile = await resolveLocalUserProfile(app.getPath('userData')).catch(() => undefined)
    return {
      name: app.name,
      version: app.getVersion(),
      platform: process.platform,
      ...(userProfile ? { userProfile } : {}),
    }
  })
  ipcMain.handle('desktop:minimize', (event) => requireTrustedWindow(event).minimize())
  ipcMain.handle('desktop:toggle-maximize', (event) => {
    const window = requireTrustedWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.handle('desktop:full-screen', (event) => requireTrustedWindow(event).isFullScreen())
  ipcMain.handle('desktop:toggle-full-screen', (event) => toggleWindowFullscreen(requireTrustedWindow(event)))
  ipcMain.handle('desktop:close', (event) => requireTrustedWindow(event).close())
  ipcMain.handle('desktop:copy-text', (event, value: unknown) => {
    requireTrustedWindow(event)
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('Clipboard text must be a string no larger than 1 MiB.')
    return clipboard.writeText(value)
  })
  ipcMain.handle('desktop:window-context', (event) => {
    const window = requireTrustedWindow(event)
    return sessionWindows?.getContext(window) ?? { kind: 'main' }
  })
  ipcMain.handle('desktop:session-window-list', (event) => {
    requireTrustedWindow(event)
    return sessionWindows?.list() ?? []
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-open', (event, request: unknown) => {
    requireTrustedWindow(event)
    if (!sessionWindows) throw new Error('Session windows are unavailable.')
    return sessionWindows.open(request)
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-focus', (event, request: unknown) => {
    requireTrustedWindow(event)
    if (!sessionWindows) return Promise.resolve(false)
    return sessionWindows.focus(request)
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-dock', (event, request?: unknown) => {
    const window = requireTrustedWindow(event)
    if (!sessionWindows) return Promise.resolve()
    return sessionWindows.dock(window, request)
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-save-tree', (event, tree: unknown) => {
    const window = requireTrustedWindow(event)
    sessionWindows?.savePaneTree(window, tree)
    return Promise.resolve()
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-report-state', (event, state: unknown) => {
    const window = requireTrustedWindow(event)
    sessionWindows?.reportState(window, state)
    return Promise.resolve()
  })
  handleDesktopOperation(ipcMain, 'desktop:session-window-navigate', (event, request: unknown) => {
    requireMainWindow(event)
    return Promise.resolve(sessionWindows?.navigate(request) ?? false)
  })
}

function configureRendererSession(webSession: Electron.Session): void {
  if (rendererSessionConfigured) return
  rendererSessionConfigured = true
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  webSession.setPermissionCheckHandler(() => false)
  if (devUrl) {
    const origin = new URL(devUrl).origin
    const policy = PRODUCTION_CSP
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'none'", `connect-src 'self' ${origin.replace('http:', 'ws:')}`)
    webSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } })
    })
  }
}

function hardenWindow(window: BrowserWindow, zoom: WindowZoomPreferences, onUnexpectedNavigation: () => void): void {
  registerWindowZoom(window, zoom, devUrl)
  registerWindowFullscreen(window, devUrl)
  let initialNavigation = true
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      if (initialNavigation) { initialNavigation = false; return }
      onUnexpectedNavigation()
    }
  })
  configureRendererSession(window.webContents.session)
  window.on('close', (event) => {
    if (updateRestart?.preparing && !cleanupComplete) event.preventDefault()
  })
}

function createSessionBrowserWindow(title: string, cascadeIndex: number, savedBounds?: SessionWindowBounds): BrowserWindow {
  const zoom = windowZoom ??= new WindowZoomPreferences(app.getPath('userData'))
  let width = 920
  let height = 780
  let x: number | undefined
  let y: number | undefined
  if (savedBounds) {
    const workArea = screen.getDisplayMatching({
      x: savedBounds.x,
      y: savedBounds.y,
      width: savedBounds.width,
      height: savedBounds.height,
    }).workArea
    width = Math.max(480, Math.min(workArea.width, savedBounds.width))
    height = Math.max(420, Math.min(workArea.height, savedBounds.height))
    x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, savedBounds.x))
    y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, savedBounds.y))
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    const base = mainWindow.getBounds()
    const workArea = screen.getDisplayMatching(base).workArea
    const step = (cascadeIndex % 6) * 28
    x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, base.x + Math.round((base.width - width) / 2) + step))
    y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, base.y + Math.round((base.height - height) / 2) + step))
  }
  const window = new BrowserWindow({
    title,
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png'),
    width,
    height,
    minWidth: 480,
    minHeight: 420,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
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
  hardenWindow(window, zoom, () => agentHost?.closeWindow(window))
  return window
}

async function createWindow(): Promise<void> {
  if (quitting || cleanupComplete) return
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
  sessionWindows?.registerMainWindow(window)
  hardenWindow(window, zoom, () => agentHost?.close())
  const closeConnections = () => {
    updateRestart?.abort()
    agentHost?.close()
    void remoteVSCode?.close().catch((error: unknown) => console.error('Remote device shutdown failed:', error))
  }
  window.webContents.on('render-process-gone', closeConnections)
  window.webContents.on('destroyed', closeConnections)
  window.on('close', () => {
    if (!updateRestart?.preparing || cleanupComplete) {
      sessionWindows?.prepareMainWindowClose()
    }
  })
  window.on('closed', () => {
    sessionWindows?.unregisterMainWindow(window)
    mainWindow = undefined
  })
  await window.loadURL(devUrl ?? APP_URL)
  if (!window.isDestroyed()) window.show()
}

void app.whenReady().then(async () => {
  if (!primaryInstance || quitting) return
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
  const workspaces = registerWorkspaceBridge(requireMainWindow, async (root, target) => {
    if (!remoteVSCode) throw new Error('Agent Host access is not ready.')
    return remoteVSCode.agentHosts.verifyLink(root, target)
  }, async (root) => { await remoteVSCode?.gitSync.open(root) }, (root) => {
    sessionWindows?.syncWorkspace(root)
  }, requireTrustedWindow, () => {
    sessionWindows?.broadcast('remote-vscode:git-bindings-changed')
  })
  sessionWindows = new SessionWindowManager({
    devUrl,
    storageFile: join(app.getPath('userData'), 'session-windows.json'),
    getWorkspaceState: workspaces.getState,
    prepareWorkspace: async (root) => { await remoteVSCode?.gitSync.open(root) },
    authorizeSession: async (root, target) => {
      if (!remoteVSCode) throw new Error('Agent Host access is not ready.')
      await remoteVSCode.agentHosts.authorize(root, target)
    },
    createBrowserWindow: (context, cascadeIndex, savedBounds) => createSessionBrowserWindow(`${context.task.id} · Task Continuum`, cascadeIndex, savedBounds),
    loadWindow: (window) => window.loadURL(devUrl ?? APP_URL),
    onSessionWindowClosed: (window) => agentHost?.closeWindow(window),
    onAnyWindowClosedDuringInstall: () => { if (updateRestart?.preparing) updateRestart.abort() },
  })
  await sessionWindows.load()
  remoteVSCode = registerRemoteVSCodeBridge(requireTrustedWindow, workspaces.currentRoot, () => {
    sessionWindows?.broadcast('remote-vscode:git-status-changed')
  }, () => {
    sessionWindows?.broadcast('remote-vscode:git-bindings-changed')
  })
  await remoteVSCode.filesReady
  if (quitting || cleanupComplete) return
  registerChatLinkBridge(requireTrustedWindow, workspaces.currentRoot, remoteVSCode.chatLinks)
  agentHost = registerAgentHostBridge(requireTrustedWindow, workspaces.currentRoot, remoteVSCode.agentHosts)
  const installCoordinator = new MultiWindowInstallCoordinator(
    () => sessionWindows?.liveWindows() ?? [],
    (parentId, blockers) => updateRestart?.respond(parentId, blockers),
  )
  updateRestart = new UpdateRestartGuard({
    operations: desktopOperations,
    rendererAvailable: () => Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()),
    hasActiveWork: () => remoteVSCode?.hasActiveWork() ?? false,
    requestRenderer: (requestId) => installCoordinator.request(requestId),
    resumeRenderer: (restartRequired) => {
      installCoordinator.clear()
      sessionWindows?.broadcast('updates:install-aborted')
      if (restartRequired) void recoverAfterUpdateFailure().catch((error: unknown) => console.error('Update restart recovery failed:', error))
    },
    cleanup: cleanupDesktop,
  })
  let windowLoaded = false
  const restart = updateRestart
  const updatesReady = createDesktopUpdateService({
    currentVersion: app.getVersion(), isPackaged: app.isPackaged,
    userData: app.getPath('userData'), resourcesPath: process.resourcesPath,
    openExternal: (url) => shell.openExternal(url),
    install: (installer) => restart.install(installer),
  })
  registerUpdateBridge(requireTrustedWindow, updatesReady, { respond: (id, blockers) => installCoordinator.respond(id, blockers) } as UpdateRestartGuard)
  void updatesReady.then((service) => {
    updates = service
    if (quitting || cleanupComplete) { service.close(); return }
    service.listen((state) => {
      sessionWindows?.broadcast('updates:state', state)
    })
    if (windowLoaded) service.start()
  }).catch((error: unknown) => console.error('Application updates could not initialize:', error))
  await createWindow()
  if (!quitting && !cleanupComplete) {
    await sessionWindows.restoreSavedWindows().catch((error: unknown) => console.error('Session window restore failed:', error))
  }
  windowLoaded = true
  if (!quitting && !cleanupComplete) updates?.start()
  app.on('activate', () => {
    if (!quitting && !cleanupComplete && BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then(() => sessionWindows?.restoreSavedWindows()).catch((error: unknown) => { console.error(error); app.exit(1) })
    }
  })
}).catch((error: unknown) => { console.error(error); app.exit(1) })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  if (cleanupComplete) { updates?.close(); return }
  event.preventDefault()
  if (updateRestart?.preparing) return
  if (quitting) return
  quitting = true
  updates?.close()
  void cleanupDesktop().then(() => app.quit()).catch(async (error: unknown) => {
    console.error('Task Continuum shutdown cleanup failed:', error)
    desktopOperations.requireRestart()
    const result = await dialog.showMessageBox({
      type: 'error', title: 'Task Continuum cleanup is incomplete',
      message: 'Connections or local state could not finish closing. No update was installed.',
      detail: 'Application services are stopping. Retry closing, then reopen Task Continuum before continuing.',
      buttons: ['Retry exit', 'Keep window open'], defaultId: 0, cancelId: 1,
    })
    quitting = false
    if (result.response === 0) app.quit()
  }).catch((error: unknown) => {
    quitting = false
    console.error('Task Continuum could not show its shutdown failure:', error)
  })
})