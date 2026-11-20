import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { agentHostKey } from '../shared/agentHost'
import type { AgentHostTarget } from '../shared/agentHost'
import { MAX_CHAT_TEXT_LENGTH } from '../shared/chatAttachments'
import type { DesktopWindowContext, SessionWindowMode, SessionWindowSummary } from '../shared/desktop'
import type { WorkspaceState } from '../shared/workspace'
import { agentHostTargetSchema } from './agentHostProtocol'
import { isTrustedRendererUrl } from './security'

export const MAX_SESSION_WINDOWS = 12

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const draftSchema = z.string().max(MAX_CHAT_TEXT_LENGTH).optional()

const openSessionWindowSchema = z.object({
  taskId: taskIdSchema,
  target: agentHostTargetSchema,
  draft: draftSchema,
  mode: z.enum(['move', 'copy']).optional(),
}).strict()

const focusSessionWindowSchema = z.object({
  taskId: taskIdSchema,
  target: agentHostTargetSchema,
}).strict()

const dockSessionWindowSchema = z.object({
  taskId: taskIdSchema.optional(),
  target: agentHostTargetSchema.optional(),
  draft: draftSchema,
}).strict().optional()

type SessionContext = Extract<DesktopWindowContext, { kind: 'session' }>

interface PopoutEntry {
  readonly entryKey: string
  readonly panelKey: string
  readonly workspaceRoot: string
  mode: SessionWindowMode
  context: SessionContext
  readonly window: BrowserWindow
}

type RegisteredWindow =
  | { readonly kind: 'main'; readonly window: BrowserWindow }
  | { readonly kind: 'session'; readonly entry: PopoutEntry; readonly window: BrowserWindow }

export function sessionWindowPanelKey(taskId: string, target: AgentHostTarget): string {
  return `${taskId}:ahp:${agentHostKey(target)}`
}

export interface SessionWindowManagerOptions {
  readonly devUrl?: string
  getWorkspaceState(): Promise<WorkspaceState>
  authorizeSession(root: string, target: AgentHostTarget): Promise<void>
  createBrowserWindow(context: SessionContext, cascadeIndex: number): BrowserWindow
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
  private activeWorkspaceRoot: string | undefined
  private cascadeCounter = 0
  private closingAll = false

  constructor(private readonly options: SessionWindowManagerOptions) {}

  get main(): BrowserWindow | undefined {
    return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined
  }

  registerMainWindow(window: BrowserWindow): void {
    const senderId = window.webContents.id
    this.mainWindow = window
    this.mainSenderId = senderId
    this.bySenderId.set(senderId, { kind: 'main', window })
  }

  unregisterMainWindow(window: BrowserWindow): void {
    if (this.mainSenderId !== undefined && (!this.mainWindow || this.mainWindow === window)) {
      this.bySenderId.delete(this.mainSenderId)
      this.mainSenderId = undefined
      this.mainWindow = undefined
    }
    this.options.onAnyWindowClosedDuringInstall?.()
    this.closeAllPopouts()
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
      const { context } = item.entry
      if (context.initialDraft !== undefined) {
        item.entry.context = {
          kind: 'session',
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          workspaceRoot: context.workspaceRoot,
          task: context.task,
          target: context.target,
        }
      }
      return context
    }
    return { kind: 'main' }
  }

  list(workspaceRoot = this.activeWorkspaceRoot): SessionWindowSummary[] {
    if (!workspaceRoot) return []
    const summaries: SessionWindowSummary[] = []
    for (const entry of this.popouts.values()) {
      if (entry.workspaceRoot !== workspaceRoot || entry.window.isDestroyed()) continue
      summaries.push({
        key: entry.panelKey,
        taskId: entry.context.task.id,
        target: entry.context.target,
        mode: entry.mode,
      })
    }
    return summaries
  }

  syncWorkspace(nextRoot: string | undefined): void {
    if (this.activeWorkspaceRoot === nextRoot) return
    this.activeWorkspaceRoot = nextRoot
    let changed = false
    for (const entry of [...this.popouts.values()]) {
      if (entry.workspaceRoot !== nextRoot) {
        changed = true
        this.popouts.delete(entry.entryKey)
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
    }
    if (changed) this.publishChanged()
  }

  closeAllPopouts(): void {
    if (this.closingAll) return
    this.closingAll = true
    try {
      for (const entry of [...this.popouts.values()]) {
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

  async open(requestInput: unknown): Promise<{ opened: boolean; reused: boolean }> {
    const request = openSessionWindowSchema.parse(requestInput)
    const state = await this.options.getWorkspaceState()
    const workspace = state.current
    if (!workspace) throw new Error('Open a task workspace before popping out a session.')
    this.activeWorkspaceRoot = workspace.root
    const task = workspace.tasks.find((item) => item.id === request.taskId)
    if (!task) throw new Error(`Task ${request.taskId} is unavailable in the current workspace.`)
    await this.options.authorizeSession(workspace.root, request.target)

    const requestedMode: SessionWindowMode = request.mode ?? 'move'
    const panelKey = sessionWindowPanelKey(task.id, request.target)
    const entryKey = `${workspace.root}::${panelKey}`
    const existing = this.popouts.get(entryKey)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.mode !== requestedMode) {
        existing.mode = requestedMode
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

    const context: SessionContext = {
      kind: 'session',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      task,
      target: request.target,
      ...(request.draft ? { initialDraft: request.draft } : {}),
    }

    const creation = (async () => {
      const window = this.options.createBrowserWindow(context, this.cascadeCounter++)
      const senderId = window.webContents.id
      const entry: PopoutEntry = { entryKey, panelKey, workspaceRoot: workspace.root, mode: requestedMode, context, window }
      this.popouts.set(entryKey, entry)
      this.bySenderId.set(senderId, { kind: 'session', entry, window })
      const cleanup = () => {
        const removed = this.popouts.get(entryKey) === entry
        if (removed) this.popouts.delete(entryKey)
        this.bySenderId.delete(senderId)
        this.options.onSessionWindowClosed?.(window)
        this.options.onAnyWindowClosedDuringInstall?.()
        if (removed && !this.closingAll) this.publishChanged()
      }
      window.webContents.once('render-process-gone', () => this.options.onSessionWindowClosed?.(window))
      window.once('closed', cleanup)
      try {
        await this.options.loadWindow(window)
      } catch (error) {
        if (!window.isDestroyed()) window.destroy()
        throw error
      }
      if (window.isDestroyed() || this.activeWorkspaceRoot !== workspace.root) {
        if (!window.isDestroyed()) window.destroy()
        return { opened: false, reused: false }
      }
      this.publishChanged()
      this.focusBrowserWindow(window)
      return { opened: true, reused: false }
    })().finally(() => {
      this.opening.delete(entryKey)
    })

    this.opening.set(entryKey, creation)
    return creation
  }

  async focus(requestInput: unknown): Promise<boolean> {
    const request = focusSessionWindowSchema.parse(requestInput)
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
    } else if (request?.taskId && request.target) {
      const state = await this.options.getWorkspaceState()
      const root = state.current?.root
      if (root) entry = this.popouts.get(`${root}::${sessionWindowPanelKey(request.taskId, request.target)}`)
    }
    const taskId = entry?.context.task.id ?? request?.taskId
    const target = entry?.context.target ?? request?.target
    const draft = request?.draft
    const main = this.main
    if (entry) {
      this.popouts.delete(entry.entryKey)
      if (!entry.window.isDestroyed()) entry.window.close()
      this.publishChanged()
    }
    if (main && !main.webContents.isDestroyed() && taskId && target) {
      this.focusBrowserWindow(main)
      main.webContents.send('desktop:activate-session', {
        taskId,
        target,
        ...(draft ? { draft } : {}),
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
