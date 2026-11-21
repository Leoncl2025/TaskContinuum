import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { agentHostKey } from '../shared/agentHost'
import type { AgentHostTarget } from '../shared/agentHost'
import { MAX_CHAT_TEXT_LENGTH } from '../shared/chatAttachments'
import type { DesktopWindowContext, SessionWindowBounds, SessionWindowMode, SessionWindowSummary } from '../shared/desktop'
import { persistedPaneTreeSchema } from '../shared/paneTreeSchema'
import type { PersistedPaneTreeNode, PersistedPaneTreeState } from '../shared/paneTreeSchema'
import type { WorkspaceState } from '../shared/workspace'
import { agentHostTargetSchema } from './agentHostProtocol'
import { isTrustedRendererUrl } from './security'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export const MAX_SESSION_WINDOWS = 12
const MAX_PERSISTED_WORKSPACES = 32

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const sessionKeySchema = z.string().startsWith('ahp:').max(2048).nullable().optional()
const draftSchema = z.string().max(MAX_CHAT_TEXT_LENGTH).optional()

const boundsSchema = z.object({
  x: z.number().int().min(-32768).max(32768),
  y: z.number().int().min(-32768).max(32768),
  width: z.number().int().min(320).max(16384),
  height: z.number().int().min(280).max(16384),
  maximized: z.boolean().optional(),
}).strict()

const persistedSessionWindowSchema = z.object({
  windowId: z.string().uuid(),
  taskId: taskIdSchema,
  target: agentHostTargetSchema.optional(),
  sessionKey: sessionKeySchema,
  mode: z.enum(['move', 'copy']),
  paneTree: persistedPaneTreeSchema.optional(),
  bounds: boundsSchema.optional(),
}).strict()

type PersistedSessionWindowRecord = z.infer<typeof persistedSessionWindowSchema>

const persistedStoreSchema = z.object({
  version: z.literal(1),
  workspaces: z.unknown().refine(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length <= MAX_PERSISTED_WORKSPACES,
    'Too many persisted workspaces.',
  ).pipe(z.record(z.string().min(1).max(256), z.array(persistedSessionWindowSchema).max(MAX_SESSION_WINDOWS))),
}).strict()

const openSessionWindowSchema = z.object({
  taskId: taskIdSchema,
  target: agentHostTargetSchema.optional(),
  sessionKey: sessionKeySchema,
  draft: draftSchema,
  mode: z.enum(['move', 'copy']).optional(),
}).strict()

const focusSessionWindowSchema = z.object({
  windowId: z.string().uuid().optional(),
  taskId: taskIdSchema.optional(),
  target: agentHostTargetSchema.optional(),
}).strict()

const dockedPageSchema = z.object({
  taskId: taskIdSchema,
  sessionKey: sessionKeySchema,
  target: agentHostTargetSchema.optional(),
  draft: draftSchema,
}).strict()

const dockSessionWindowSchema = z.object({
  windowId: z.string().uuid().optional(),
  taskId: taskIdSchema.optional(),
  target: agentHostTargetSchema.optional(),
  sessionKey: sessionKeySchema,
  draft: draftSchema,
  pages: z.array(dockedPageSchema).max(32).optional(),
}).strict().optional()

type SessionContext = Extract<DesktopWindowContext, { kind: 'session' }>

interface PopoutEntry {
  readonly windowId: string
  readonly entryKey: string
  readonly panelKey: string
  readonly workspaceId: string
  readonly workspaceRoot: string
  mode: SessionWindowMode
  paneTree?: PersistedPaneTreeState
  bounds?: SessionWindowBounds
  context: SessionContext
  readonly window: BrowserWindow
}

type RegisteredWindow =
  | { readonly kind: 'main'; readonly window: BrowserWindow }
  | { readonly kind: 'session'; readonly entry: PopoutEntry; readonly window: BrowserWindow }

export function sessionWindowPanelKey(taskId: string, target?: AgentHostTarget): string {
  return target ? `${taskId}:ahp:${agentHostKey(target)}` : `${taskId}:task`
}

function collectPaneTreeTaskIds(node: PersistedPaneTreeNode, target = new Set<string>()): Set<string> {
  if (node.kind === 'group') {
    for (const id of node.openTaskIds) target.add(id)
    return target
  }
  collectPaneTreeTaskIds(node.first, target)
  collectPaneTreeTaskIds(node.second, target)
  return target
}

function readBrowserWindowBounds(window: BrowserWindow): SessionWindowBounds | undefined {
  if (window.isDestroyed()) return undefined
  const maximized = typeof window.isMaximized === 'function' ? window.isMaximized() : false
  const reader = maximized && typeof window.getNormalBounds === 'function'
    ? () => window.getNormalBounds()
    : typeof window.getBounds === 'function'
      ? () => window.getBounds()
      : undefined
  if (!reader) return undefined
  const raw = reader()
  const parsed = boundsSchema.safeParse({
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    ...(maximized ? { maximized: true } : {}),
  })
  return parsed.success ? parsed.data : undefined
}

export interface SessionWindowManagerOptions {
  readonly devUrl?: string
  readonly storageFile?: string
  getWorkspaceState(): Promise<WorkspaceState>
  prepareWorkspace?(root: string): Promise<void>
  authorizeSession(root: string, target: AgentHostTarget): Promise<void>
  createBrowserWindow(context: SessionContext, cascadeIndex: number, savedBounds?: SessionWindowBounds): BrowserWindow
  loadWindow(window: BrowserWindow): Promise<void>
  onSessionWindowClosed?(window: BrowserWindow): void
  onAnyWindowClosedDuringInstall?(): void
}

export class SessionWindowManager {
  private mainWindow: BrowserWindow | undefined
  private mainSenderId: number | undefined
  private readonly bySenderId = new Map<number, RegisteredWindow>()
  private readonly popouts = new Map<string, PopoutEntry>()
  private readonly opening = new Map<string, Promise<{ opened: boolean; reused: boolean }>>()
  private readonly persistedByWorkspace = new Map<string, PersistedSessionWindowRecord[]>()
  private activeWorkspaceRoot: string | undefined
  private cascadeCounter = 0
  private closingAll = false
  private preservingShutdown = false
  private loadedPromise?: Promise<void>
  private restoring?: Promise<number>
  private saveTimer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly options: SessionWindowManagerOptions) {}

  get main(): BrowserWindow | undefined {
    return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined
  }

  load(): Promise<void> {
    if (!this.options.storageFile) return Promise.resolve()
    return this.loadedPromise ??= (async () => {
      try {
        const raw = await readJsonBounded(this.options.storageFile!, 512 * 1024)
        const parsed = persistedStoreSchema.safeParse(raw)
        if (!parsed.success) return
        for (const [workspaceId, list] of Object.entries(parsed.data.workspaces)) {
          if (list.length) this.persistedByWorkspace.set(workspaceId, [...list])
        }
      } catch {
        // Missing or unreadable session-windows.json starts empty without blocking startup.
      }
    })()
  }

  private persistEntry(entry: PopoutEntry): void {
    if (!this.options.storageFile) return
    const latestBounds = readBrowserWindowBounds(entry.window) ?? entry.bounds
    if (latestBounds) entry.bounds = latestBounds
    const record: PersistedSessionWindowRecord = {
      windowId: entry.windowId,
      taskId: entry.context.task.id,
      ...(entry.context.target ? { target: entry.context.target } : {}),
      ...(entry.context.sessionKey !== undefined ? { sessionKey: entry.context.sessionKey } : {}),
      mode: entry.mode,
      ...(entry.paneTree ? { paneTree: entry.paneTree } : {}),
      ...(entry.bounds ? { bounds: entry.bounds } : {}),
    }
    const existing = this.persistedByWorkspace.get(entry.workspaceId) ?? []
    const next = [...existing.filter((item) => item.windowId !== entry.windowId), record].slice(-MAX_SESSION_WINDOWS)
    this.persistedByWorkspace.set(entry.workspaceId, next)
    if (this.persistedByWorkspace.size > MAX_PERSISTED_WORKSPACES) {
      const oldestKey = this.persistedByWorkspace.keys().next().value
      if (oldestKey && oldestKey !== entry.workspaceId) this.persistedByWorkspace.delete(oldestKey)
    }
    this.scheduleSave()
  }

  private removePersistedEntry(workspaceId: string, windowId: string): void {
    if (!this.options.storageFile) return
    const existing = this.persistedByWorkspace.get(workspaceId)
    if (!existing) return
    const remaining = existing.filter((item) => item.windowId !== windowId)
    if (remaining.length === existing.length) return
    if (remaining.length) this.persistedByWorkspace.set(workspaceId, remaining)
    else this.persistedByWorkspace.delete(workspaceId)
    this.scheduleSave()
  }

  private snapshotLivePopouts(): void {
    if (!this.options.storageFile) return
    for (const entry of this.popouts.values()) {
      if (!entry.window.isDestroyed()) this.persistEntry(entry)
    }
  }

  private scheduleSave(): void {
    const file = this.options.storageFile
    if (!file) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.enqueueWrite()
    }, 80)
    this.saveTimer.unref?.()
  }

  private enqueueWrite(): void {
    const file = this.options.storageFile
    if (!file) return
    const payload = {
      version: 1 as const,
      workspaces: Object.fromEntries(this.persistedByWorkspace.entries()),
    }
    const op = this.writing.then(() => writeJsonAtomic(file, payload))
    this.writing = op.catch(() => undefined)
  }

  async flush(): Promise<void> {
    if (!this.options.storageFile) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      this.enqueueWrite()
    }
    await this.writing
  }

  prepareMainWindowClose(): void {
    this.preservingShutdown = true
    this.snapshotLivePopouts()
  }

  registerMainWindow(window: BrowserWindow): void {
    this.preservingShutdown = false
    const senderId = window.webContents.id
    this.mainWindow = window
    this.mainSenderId = senderId
    this.bySenderId.set(senderId, { kind: 'main', window })
  }

  unregisterMainWindow(window: BrowserWindow): void {
    this.preservingShutdown = true
    if (this.mainSenderId !== undefined && (!this.mainWindow || this.mainWindow === window)) {
      this.bySenderId.delete(this.mainSenderId)
      this.mainSenderId = undefined
      this.mainWindow = undefined
    }
    this.options.onAnyWindowClosedDuringInstall?.()
    this.closeAllPopouts(true)
  }

  liveWindows(): BrowserWindow[] {
    const result: BrowserWindow[] = []
    for (const item of this.bySenderId.values()) {
      if (!item.window.isDestroyed() && !item.window.webContents.isDestroyed()) {
        result.push(item.window)
      }
    }
    return result
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const window of this.liveWindows()) {
      window.webContents.send(channel, ...args)
    }
  }

  requireTrustedWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const registered = this.bySenderId.get(event.sender.id)
    if (!registered
      || registered.window.isDestroyed()
      || registered.window.webContents.isDestroyed()
      || event.sender !== registered.window.webContents
      || event.senderFrame !== registered.window.webContents.mainFrame
      || !isTrustedRendererUrl(event.senderFrame.url, this.options.devUrl)) {
      throw new Error('Untrusted desktop IPC request.')
    }
    return registered.window
  }

  requireMainWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = this.requireTrustedWindow(event)
    if (window !== this.mainWindow) {
      throw new Error('This workspace action is only available in the main window.')
    }
    return window
  }

  getContext(window: BrowserWindow): DesktopWindowContext {
    for (const item of this.bySenderId.values()) {
      if (item.window !== window) continue
      if (item.kind === 'main') return { kind: 'main' }
      const { context, paneTree } = item.entry
      const resolvedContext: SessionContext = {
        ...context,
        ...(paneTree ? { initialPaneTree: paneTree } : {}),
      }
      if (context.initialDraft !== undefined) {
        item.entry.context = {
          kind: 'session',
          windowId: context.windowId,
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          workspaceRoot: context.workspaceRoot,
          task: context.task,
          ...(context.target ? { target: context.target } : {}),
          ...(context.sessionKey !== undefined ? { sessionKey: context.sessionKey } : {}),
          ...(context.initialPaneTree ? { initialPaneTree: context.initialPaneTree } : {}),
        }
      }
      return resolvedContext
    }
    return { kind: 'main' }
  }

  savePaneTree(caller: BrowserWindow, treeInput: unknown): void {
    const registered = [...this.bySenderId.values()].find((item) => item.window === caller)
    if (registered?.kind !== 'session') return
    const parsed = persistedPaneTreeSchema.parse(treeInput)
    registered.entry.paneTree = parsed
    registered.entry.context = { ...registered.entry.context, initialPaneTree: parsed }
    this.persistEntry(registered.entry)
  }

  list(workspaceRoot = this.activeWorkspaceRoot): SessionWindowSummary[] {
    if (!workspaceRoot) return []
    const summaries: SessionWindowSummary[] = []
    for (const entry of this.popouts.values()) {
      if (entry.workspaceRoot !== workspaceRoot || entry.window.isDestroyed()) continue
      summaries.push({
        key: entry.panelKey,
        taskId: entry.context.task.id,
        ...(entry.context.target ? { target: entry.context.target } : {}),
        mode: entry.mode,
      })
    }
    return summaries
  }

  syncWorkspace(nextRoot: string | undefined): void {
    if (this.activeWorkspaceRoot === nextRoot) return
    this.snapshotLivePopouts()
    this.activeWorkspaceRoot = nextRoot
    const previousClosing = this.closingAll
    this.closingAll = true
    let changed = false
    try {
      for (const entry of [...this.popouts.values()]) {
        if (entry.workspaceRoot !== nextRoot) {
          changed = true
          this.popouts.delete(entry.entryKey)
          if (!entry.window.isDestroyed()) entry.window.destroy()
        }
      }
    } finally {
      this.closingAll = previousClosing
    }
    if (changed) this.publishChanged()
    if (nextRoot && this.options.storageFile && this.main && !this.preservingShutdown) {
      void this.restoreSavedWindows().catch(() => undefined)
    }
  }

  closeAllPopouts(preservePersisted = false): void {
    if (this.closingAll) return
    if (preservePersisted) this.snapshotLivePopouts()
    this.closingAll = true
    try {
      for (const entry of [...this.popouts.values()]) {
        if (!preservePersisted) {
          this.removePersistedEntry(entry.workspaceId, entry.windowId)
        }
        this.popouts.delete(entry.entryKey)
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
    } finally {
      this.closingAll = false
    }
  }

  private publishChanged(): void {
    const main = this.main
    if (!main || main.webContents.isDestroyed()) return
    main.webContents.send('desktop:session-windows-changed', this.list())
  }

  private focusBrowserWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private showRestoredBrowserWindow(window: BrowserWindow, maximized?: boolean): void {
    if (window.isDestroyed()) return
    if (maximized && typeof window.maximize === 'function') window.maximize()
    if (typeof window.showInactive === 'function') window.showInactive()
    else window.show()
  }

  private attachBoundsListeners(entry: PopoutEntry): void {
    const { window } = entry
    if (!this.options.storageFile || typeof window.on !== 'function') return
    const onBoundsChange = () => {
      if (window.isDestroyed() || this.closingAll || this.preservingShutdown) return
      const next = readBrowserWindowBounds(window)
      if (!next) return
      entry.bounds = next
      this.persistEntry(entry)
    }
    window.on('moved', onBoundsChange)
    window.on('resized', onBoundsChange)
    window.on('maximize', onBoundsChange)
    window.on('unmaximize', onBoundsChange)
  }

  async open(requestInput: unknown): Promise<{ opened: boolean; reused: boolean }> {
    await this.load()
    const request = openSessionWindowSchema.parse(requestInput)
    const state = await this.options.getWorkspaceState()
    const workspace = state.current
    if (!workspace) throw new Error('Open a task workspace before popping out a task page.')
    this.activeWorkspaceRoot = workspace.root
    const task = workspace.tasks.find((item) => item.id === request.taskId)
    if (!task) throw new Error(`Task ${request.taskId} is unavailable in the current workspace.`)
    if (request.target) {
      await this.options.authorizeSession(workspace.root, request.target)
    }

    const requestedMode: SessionWindowMode = request.mode ?? 'move'
    const panelKey = sessionWindowPanelKey(task.id, request.target)
    const entryKey = `${workspace.root}::${panelKey}`
    const existing = this.popouts.get(entryKey)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.mode !== requestedMode) {
        existing.mode = requestedMode
        this.persistEntry(existing)
        this.publishChanged()
      }
      this.focusBrowserWindow(existing.window)
      return { opened: true, reused: true }
    }

    const pending = this.opening.get(entryKey)
    if (pending) return pending

    if (this.popouts.size >= MAX_SESSION_WINDOWS) {
      throw new Error(`Up to ${MAX_SESSION_WINDOWS} popped-out session windows can be open at once. Close one before opening another.`)
    }

    const windowId = randomUUID()
    const resolvedSessionKey = request.sessionKey ?? (request.target ? `ahp:${agentHostKey(request.target)}` : undefined)
    const context: SessionContext = {
      kind: 'session',
      windowId,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      task,
      ...(request.target ? { target: request.target } : {}),
      ...(resolvedSessionKey !== undefined ? { sessionKey: resolvedSessionKey } : {}),
      ...(request.draft ? { initialDraft: request.draft } : {}),
    }

    return this.spawnPopout({
      windowId,
      entryKey,
      panelKey,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      mode: requestedMode,
      context,
      focusOnOpen: true,
    })
  }

  restoreSavedWindows(): Promise<number> {
    if (!this.options.storageFile || this.preservingShutdown) return Promise.resolve(0)
    if (this.restoring) return this.restoring
    const run = this.restoreSavedWindowsInternal().finally(() => {
      if (this.restoring === run) this.restoring = undefined
    })
    this.restoring = run
    return run
  }

  private async restoreSavedWindowsInternal(): Promise<number> {
    if (!this.options.storageFile || this.preservingShutdown) return 0
    await this.load()
    const state = await this.options.getWorkspaceState()
    const workspace = state.current
    if (!workspace || this.preservingShutdown) return 0
    this.activeWorkspaceRoot = workspace.root
    const saved = this.persistedByWorkspace.get(workspace.id)
    if (!saved?.length) return 0

    await this.options.prepareWorkspace?.(workspace.root)
    if (this.preservingShutdown || this.activeWorkspaceRoot !== workspace.root) return 0

    let restoredCount = 0
    const survivingRecords: PersistedSessionWindowRecord[] = []
    for (const record of saved) {
      if (this.popouts.size >= MAX_SESSION_WINDOWS || this.preservingShutdown) break
      const candidateTaskIds = new Set<string>([record.taskId])
      if (record.paneTree) collectPaneTreeTaskIds(record.paneTree.root, candidateTaskIds)
      const task = workspace.tasks.find((item) => item.id === record.taskId)
        ?? workspace.tasks.find((item) => candidateTaskIds.has(item.id))
      if (!task) continue

      let verifiedTarget: AgentHostTarget | undefined = record.target
      if (verifiedTarget) {
        try {
          await this.options.authorizeSession(workspace.root, verifiedTarget)
        } catch {
          verifiedTarget = undefined
        }
      }

      const panelKey = sessionWindowPanelKey(task.id, verifiedTarget)
      const entryKey = `${workspace.root}::${panelKey}`
      const existing = this.popouts.get(entryKey)
      if (existing && !existing.window.isDestroyed()) {
        survivingRecords.push(record)
        continue
      }

      const resolvedSessionKey = record.sessionKey !== undefined
        ? record.sessionKey
        : verifiedTarget
          ? `ahp:${agentHostKey(verifiedTarget)}`
          : undefined
      const context: SessionContext = {
        kind: 'session',
        windowId: record.windowId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceRoot: workspace.root,
        task,
        ...(verifiedTarget ? { target: verifiedTarget } : {}),
        ...(resolvedSessionKey !== undefined ? { sessionKey: resolvedSessionKey } : {}),
        ...(record.paneTree ? { initialPaneTree: record.paneTree } : {}),
      }

      try {
        const result = await this.spawnPopout({
          windowId: record.windowId,
          entryKey,
          panelKey,
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          mode: record.mode,
          paneTree: record.paneTree,
          bounds: record.bounds,
          context,
          focusOnOpen: false,
        })
        if (result.opened) {
          restoredCount++
          survivingRecords.push({
            ...record,
            taskId: task.id,
            target: verifiedTarget,
          })
        }
      } catch {
        // Skip a single broken popout without aborting other windows.
      }
    }

    if (survivingRecords.length !== saved.length) {
      if (survivingRecords.length) this.persistedByWorkspace.set(workspace.id, survivingRecords)
      else this.persistedByWorkspace.delete(workspace.id)
      this.scheduleSave()
    }

    const main = this.main
    if (restoredCount > 0 && main && !main.isDestroyed()) {
      main.focus()
    }
    return restoredCount
  }

  private spawnPopout({
    windowId,
    entryKey,
    panelKey,
    workspaceId,
    workspaceRoot,
    mode,
    paneTree,
    bounds,
    context,
    focusOnOpen,
  }: {
    windowId: string
    entryKey: string
    panelKey: string
    workspaceId: string
    workspaceRoot: string
    mode: SessionWindowMode
    paneTree?: PersistedPaneTreeState
    bounds?: SessionWindowBounds
    context: SessionContext
    focusOnOpen: boolean
  }): Promise<{ opened: boolean; reused: boolean }> {
    const existingPending = this.opening.get(entryKey)
    if (existingPending) return existingPending

    const creation = (async () => {
      const window = this.options.createBrowserWindow(context, this.cascadeCounter++, bounds)
      const senderId = window.webContents.id
      const entry: PopoutEntry = {
        windowId,
        entryKey,
        panelKey,
        workspaceId,
        workspaceRoot,
        mode,
        ...(paneTree ? { paneTree } : {}),
        ...(bounds ? { bounds } : {}),
        context,
        window,
      }
      this.popouts.set(entryKey, entry)
      this.bySenderId.set(senderId, { kind: 'session', entry, window })
      this.attachBoundsListeners(entry)
      const cleanup = () => {
        const removed = this.popouts.get(entryKey) === entry
        if (removed) this.popouts.delete(entryKey)
        this.bySenderId.delete(senderId)
        if (removed && !this.closingAll && !this.preservingShutdown) {
          this.removePersistedEntry(workspaceId, windowId)
        }
        this.options.onSessionWindowClosed?.(window)
        this.options.onAnyWindowClosedDuringInstall?.()
        if (removed && !this.closingAll && !this.preservingShutdown) this.publishChanged()
      }
      window.webContents.once('render-process-gone', () => this.options.onSessionWindowClosed?.(window))
      window.once('closed', cleanup)
      try {
        await this.options.loadWindow(window)
      } catch (error) {
        if (!window.isDestroyed()) window.destroy()
        throw error
      }
      if (window.isDestroyed() || this.activeWorkspaceRoot !== workspaceRoot) {
        if (!window.isDestroyed()) window.destroy()
        return { opened: false, reused: false }
      }
      this.persistEntry(entry)
      this.publishChanged()
      if (focusOnOpen) this.focusBrowserWindow(window)
      else this.showRestoredBrowserWindow(window, bounds?.maximized)
      return { opened: true, reused: false }
    })().finally(() => {
      this.opening.delete(entryKey)
    })

    this.opening.set(entryKey, creation)
    return creation
  }

  async focus(requestInput: unknown): Promise<boolean> {
    const request = focusSessionWindowSchema.parse(requestInput)
    if (request.windowId) {
      const byId = [...this.popouts.values()].find((entry) => entry.windowId === request.windowId && !entry.window.isDestroyed())
      if (!byId) return false
      this.focusBrowserWindow(byId.window)
      return true
    }
    if (!request.taskId) return false
    const state = await this.options.getWorkspaceState()
    const root = state.current?.root
    if (!root) return false
    const entryKey = `${root}::${sessionWindowPanelKey(request.taskId, request.target)}`
    const existing = this.popouts.get(entryKey)
    if (!existing || existing.window.isDestroyed()) return false
    this.focusBrowserWindow(existing.window)
    return true
  }

  async dock(caller: BrowserWindow, requestInput?: unknown): Promise<void> {
    const request = dockSessionWindowSchema.parse(requestInput)
    let entry: PopoutEntry | undefined
    const registered = [...this.bySenderId.values()].find((item) => item.window === caller)
    if (registered?.kind === 'session') {
      entry = registered.entry
    } else if (request?.windowId) {
      entry = [...this.popouts.values()].find((item) => item.windowId === request.windowId)
    } else if (request?.taskId) {
      const state = await this.options.getWorkspaceState()
      const root = state.current?.root
      if (root) entry = this.popouts.get(`${root}::${sessionWindowPanelKey(request.taskId, request.target)}`)
    }
    const taskId = entry?.context.task.id ?? request?.taskId
    const target = entry?.context.target ?? request?.target
    const sessionKey = request?.sessionKey
    const draft = request?.draft
    const pages = request?.pages
    const main = this.main
    if (entry) {
      this.removePersistedEntry(entry.workspaceId, entry.windowId)
      this.popouts.delete(entry.entryKey)
      if (!entry.window.isDestroyed()) entry.window.close()
      this.publishChanged()
    }
    if (main && !main.webContents.isDestroyed() && taskId) {
      this.focusBrowserWindow(main)
      main.webContents.send('desktop:activate-session', {
        taskId,
        ...(target ? { target } : {}),
        ...(sessionKey !== undefined ? { sessionKey } : {}),
        ...(draft ? { draft } : {}),
        ...(pages?.length ? { pages } : {}),
      })
    }
  }
}

export class MultiWindowInstallCoordinator {
  private active?: {
    parentRequestId: string
    pendingSubIds: Set<string>
    blockers: string[]
  }

  constructor(
    private readonly windows: () => BrowserWindow[],
    private readonly onComplete: (parentRequestId: string, blockers: string[]) => void,
  ) {}

  request(parentRequestId: string): void {
    const targets = this.windows()
    if (!targets.length) throw new Error('The application window is unavailable.')
    const pendingSubIds = new Set<string>()
    this.active = { parentRequestId, pendingSubIds, blockers: [] }
    for (const window of targets) {
      const subId = randomUUID()
      pendingSubIds.add(subId)
      window.webContents.send('updates:prepare-install', subId)
    }
  }

  respond(subRequestId: string, blockers: string[]): void {
    const current = this.active
    if (!current || !current.pendingSubIds.delete(subRequestId)) {
      throw new Error('This update restart request is no longer current.')
    }
    for (const blocker of blockers) {
      if (!current.blockers.includes(blocker) && current.blockers.length < 32) {
        current.blockers.push(blocker)
      }
    }
    if (current.pendingSubIds.size === 0) {
      const { parentRequestId, blockers: merged } = current
      this.active = undefined
      this.onComplete(parentRequestId, merged)
    }
  }

  clear(): void {
    this.active = undefined
  }
}
