// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { APP_URL } from '../src/main/security'
import { MAX_SESSION_WINDOWS, MultiWindowInstallCoordinator, SessionWindowManager, sessionWindowPanelKey } from '../src/main/sessionWindows'
import { agentHostTargetFixture } from './immutable-bindings-fixture'
import { fixtureTasks } from './task-fixture'

function mockWindow(id: number, url = APP_URL) {
  const winEvents = new EventEmitter()
  const wcEvents = new EventEmitter()
  let destroyed = false
  let minimized = false
  const mainFrame = { url }
  const webContents = {
    id,
    mainFrame,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: (event: string, listener: (...args: unknown[]) => void) => { wcEvents.once(event, listener) },
  }
  const window = {
    id,
    webContents,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(() => { minimized = false }),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      if (destroyed) return
      destroyed = true
      winEvents.emit('closed')
    }),
    destroy: vi.fn(() => {
      if (destroyed) return
      destroyed = true
      winEvents.emit('closed')
    }),
    once: (event: string, listener: (...args: unknown[]) => void) => { winEvents.once(event, listener) },
    setMinimized(value: boolean) { minimized = value },
    emitCrash() { wcEvents.emit('render-process-gone') },
  }
  const ipcEvent = (frameUrl = url): IpcMainInvokeEvent => ({
    sender: webContents as unknown as IpcMainInvokeEvent['sender'],
    senderFrame: (frameUrl === url ? mainFrame : { url: frameUrl }) as unknown as IpcMainInvokeEvent['senderFrame'],
  } as IpcMainInvokeEvent)
  return { window: window as unknown as BrowserWindow & { setMinimized(v: boolean): void; emitCrash(): void }, webContents, ipcEvent }
}

function setupManager() {
  let nextId = 10
  let workspaceRoot: string | null = 'Q:\\workspace'
  const created: ReturnType<typeof mockWindow>[] = []
  const authorizeSession = vi.fn(async () => {})
  const onSessionWindowClosed = vi.fn()
  const onAnyWindowClosedDuringInstall = vi.fn()
  const manager = new SessionWindowManager({
    getWorkspaceState: async () => ({
      current: workspaceRoot ? {
        id: 'a'.repeat(64),
        name: 'tc-workspace',
        title: 'TC Workspace',
        root: workspaceRoot,
        loadedAt: '2026-11-20T00:00:00.000Z',
        warnings: [],
        tasks: [{ ...fixtureTasks[0], id: 'T-0001', title: 'Implement popout windows' }],
      } : null,
      recent: [],
    }),
    authorizeSession,
    createBrowserWindow: () => {
      const entry = mockWindow(nextId++)
      created.push(entry)
      return entry.window
    },
    loadWindow: vi.fn(async () => {}),
    onSessionWindowClosed,
    onAnyWindowClosedDuringInstall,
  })
  const main = mockWindow(1)
  manager.registerMainWindow(main.window)
  return {
    manager,
    main,
    created,
    authorizeSession,
    onSessionWindowClosed,
    onAnyWindowClosedDuringInstall,
    setWorkspaceRoot(next: string | null) { workspaceRoot = next },
  }
}

describe('SessionWindowManager', () => {
  it('validates trusted main vs session windows, rejects query strings, and scopes workspace actions to main', async () => {
    const { manager, main, created } = setupManager()
    const target = agentHostTargetFixture('popout-1')

    expect(manager.requireTrustedWindow(main.ipcEvent())).toBe(main.window)
    expect(manager.requireMainWindow(main.ipcEvent())).toBe(main.window)
    expect(() => manager.requireTrustedWindow(main.ipcEvent(`${APP_URL}?tampered=1`))).toThrow('Untrusted')

    const result = await manager.open({ taskId: 'T-0001', target, draft: 'Carry my unsent draft' })
    expect(result).toEqual({ opened: true, reused: false })
    expect(created).toHaveLength(1)

    const popout = created[0]
    expect(manager.requireTrustedWindow(popout.ipcEvent())).toBe(popout.window)
    expect(() => manager.requireMainWindow(popout.ipcEvent())).toThrow('only available in the main window')

    // Initial draft is delivered once and cleared from subsequent context reads (e.g. reload).
    const firstContext = manager.getContext(popout.window)
    expect(firstContext).toMatchObject({ kind: 'session', task: { id: 'T-0001' }, target, initialDraft: 'Carry my unsent draft' })
    const secondContext = manager.getContext(popout.window)
    expect(secondContext).toMatchObject({ kind: 'session', task: { id: 'T-0001' }, target })
    expect('initialDraft' in secondContext && secondContext.initialDraft).toBeFalsy()
  })

  it('reuses and focuses an already-open session window instead of spawning duplicates, and docks back with draft handoff', async () => {
    const { manager, main, created, onSessionWindowClosed } = setupManager()
    const target = agentHostTargetFixture('popout-reuse')

    await manager.open({ taskId: 'T-0001', target })
    const popout = created[0]
    popout.window.setMinimized(true)

    const second = await manager.open({ taskId: 'T-0001', target })
    expect(second).toEqual({ opened: true, reused: true })
    expect(created).toHaveLength(1)
    expect(popout.window.restore).toHaveBeenCalledOnce()
    expect(popout.window.focus).toHaveBeenCalled()

    expect(manager.list()).toEqual([{
      key: sessionWindowPanelKey('T-0001', target),
      taskId: 'T-0001',
      target,
      mode: 'move',
    }])

    // Re-opening in 'copy' mode updates the window mode in place and publishes the updated summary.
    const asCopy = await manager.open({ taskId: 'T-0001', target, mode: 'copy' })
    expect(asCopy).toEqual({ opened: true, reused: true })
    expect(manager.list()).toEqual([{
      key: sessionWindowPanelKey('T-0001', target),
      taskId: 'T-0001',
      target,
      mode: 'copy',
    }])

    // Docking from the popout window closes it, focuses main, and forwards the updated draft.
    await manager.dock(popout.window, { draft: 'Edited inside standalone window' })
    expect(popout.window.isDestroyed()).toBe(true)
    expect(onSessionWindowClosed).toHaveBeenCalledWith(popout.window)
    expect(manager.list()).toEqual([])
    expect(main.webContents.send).toHaveBeenCalledWith('desktop:activate-session', {
      taskId: 'T-0001',
      target,
      draft: 'Edited inside standalone window',
    })
  })

  it('enforces the session window cap and closes auxiliary windows on workspace switch or main window close', async () => {
    const { manager, main, created } = setupManager()
    for (let index = 0; index < MAX_SESSION_WINDOWS; index++) {
      await manager.open({ taskId: 'T-0001', target: agentHostTargetFixture(`cap-${index}`) })
    }
    await expect(manager.open({ taskId: 'T-0001', target: agentHostTargetFixture('cap-overflow') }))
      .rejects.toThrow(`Up to ${MAX_SESSION_WINDOWS}`)

    manager.syncWorkspace('Q:\\other-workspace')
    expect(manager.list()).toEqual([])
    expect(created.every((entry) => entry.window.isDestroyed())).toBe(true)

    // Re-open in new workspace and close main window -> all popouts close too.
    manager.unregisterMainWindow(main.window)
    expect(manager.liveWindows()).toEqual([])
  })

  it('supports opening a Task-Page popup window without an active session and docking multi-page split state back to main', async () => {
    const { manager, main, created, authorizeSession } = setupManager()
    const opened = await manager.open({ taskId: 'T-0001' })
    expect(opened).toEqual({ opened: true, reused: false })
    expect(authorizeSession).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([{
      key: 'T-0001:task',
      taskId: 'T-0001',
      mode: 'move',
    }])

    const popout = created[0]
    await manager.dock(popout.window, {
      taskId: 'T-0001',
      pages: [
        { taskId: 'T-0001', sessionKey: null },
        { taskId: 'T-0001', sessionKey: 'ahp:secondary', draft: 'Draft from split pane' },
      ],
    })
    expect(main.webContents.send).toHaveBeenCalledWith('desktop:activate-session', {
      taskId: 'T-0001',
      pages: [
        { taskId: 'T-0001', sessionKey: null },
        { taskId: 'T-0001', sessionKey: 'ahp:secondary', draft: 'Draft from split pane' },
      ],
    })
  })
})

describe('MultiWindowInstallCoordinator', () => {
  it('waits for every live window and merges unique install blockers across main and pop-out windows', () => {
    const winA = mockWindow(1)
    const winB = mockWindow(2)
    const completed = vi.fn()
    const coordinator = new MultiWindowInstallCoordinator(() => [winA.window, winB.window], completed)

    coordinator.request('parent-req-1')
    const subA = winA.webContents.send.mock.calls[0][1] as string
    const subB = winB.webContents.send.mock.calls[0][1] as string
    expect(subA).not.toBe(subB)

    coordinator.respond(subA, ['Unsent draft in main'])
    expect(completed).not.toHaveBeenCalled()
    expect(() => coordinator.respond(subA, [])).toThrow('no longer current')

    coordinator.respond(subB, ['Unsent draft in main', 'Active turn in popout'])
    expect(completed).toHaveBeenCalledExactlyOnceWith('parent-req-1', ['Unsent draft in main', 'Active turn in popout'])
  })
})
