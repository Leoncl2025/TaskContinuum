import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { agentHostKey } from '../shared/agentHost'
import type { DesktopInfo, DesktopWindowContext, DockedTaskPage, SessionWindowMode } from '../shared/desktop'
import type { TaskRecord } from '../shared/tasks'
import type { WorkspaceSnapshot } from '../shared/workspace'
import { sessionBindingKey } from './chat/sessionBindings'
import type { SessionBinding, SessionBindings } from './chat/sessionBindings'
import { buildSessionTree, treeSessionBindings } from './chat/sessionGroups'
import { useSessionLinks } from './chat/useSessionLinks'
import { useSessionTitles } from './chat/useSessionTitles'
import { useWorkbenchSelection } from './chat/useWorkbenchSelection'
import { PaneWorkspaceGrid } from './components/PaneWorkspaceGrid'
import { Icon, IconButton } from './components/Primitives'
import { UpdateNotice } from './components/UpdateSettings'
import type { useUpdates } from './components/UpdateSettings'
import { readLayout } from './layout'
import { machineLabel, useMachineAliases } from './machineAliases'
import { MachineAliasesProvider } from './MachineAliasesProvider'
import {
  activePaneGroup,
  closeTaskPageInGroup,
  createInitialPaneTree,
  findPaneGroup,
  listPaneGroups,
  openTaskPageInGroup,
  reconcilePaneTreeWithTasks,
  removePaneGroup,
  resolveGroupActiveBinding,
  ROOT_PANE_GROUP_ID,
  selectSessionInGroup,
  splitPaneGroup,
} from './paneTree'
import type { PaneTreeState } from './paneTree'
import appIcon from '../../build/icon.png'

type SessionContext = Extract<DesktopWindowContext, { kind: 'session' }>

export function SessionWindowApp({ context, updates, updateSafetyError }: {
  context: SessionContext
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
}) {
  return <MachineAliasesProvider workspaceId={context.workspaceId}>
    <SessionWindowShell context={context} updates={updates} updateSafetyError={updateSafetyError} />
  </MachineAliasesProvider>
}

function SessionWindowShell({ context, updates, updateSafetyError }: {
  context: SessionContext
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
}) {
  const aliases = useMachineAliases()
  const sessionTitles = useSessionTitles(context.workspaceId)
  const selection = useWorkbenchSelection(context.workspaceId)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => readLayout().theme)
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<WorkspaceSnapshot>(() => ({
    id: context.workspaceId,
    name: context.workspaceName,
    title: context.workspaceName,
    root: context.workspaceRoot,
    tasks: [context.task],
    warnings: [],
    loadedAt: '',
  }))
  const links = useSessionLinks(workspaceSnapshot)

  const initialSessionKey = useMemo(
    () => context.sessionKey !== undefined
      ? context.sessionKey
      : context.target
        ? `ahp:${agentHostKey(context.target)}`
        : undefined,
    [context.sessionKey, context.target],
  )

  const [paneTree, setPaneTree] = useState<PaneTreeState>(() =>
    createInitialPaneTree(
      [context.task.id],
      context.task.id,
      initialSessionKey !== undefined ? { [context.task.id]: initialSessionKey } : {},
      ROOT_PANE_GROUP_ID,
    ),
  )

  const [chatHeaderTarget, setChatHeaderTarget] = useState<HTMLDivElement | null>(null)
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [fullScreen, setFullScreen] = useState(false)
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyPanels, setBusyPanels] = useState<Record<string, boolean>>({})
  const [docking, setDocking] = useState(false)
  const chordUntilRef = useRef(0)
  const draftsRef = useRef<Record<string, string>>(
    context.initialDraft && initialSessionKey
      ? { [`${ROOT_PANE_GROUP_ID}:${context.task.id}:${initialSessionKey}`]: context.initialDraft }
      : {},
  )

  const restoredDrafts = useMemo(() => {
    if (!context.initialDraft || !initialSessionKey) return undefined
    const key = `${ROOT_PANE_GROUP_ID}:${context.task.id}:${initialSessionKey}`
    return { [key]: { nonce: 1, text: context.initialDraft } }
  }, [context.initialDraft, context.task.id, initialSessionKey])

  // Load full workspace task list so Popup Windows can also open/switch other Task Pages without a sidebar.
  useEffect(() => {
    const workspaceBridge = window.workspace
    if (!workspaceBridge) return
    let active = true
    const refreshTasks = () => {
      void workspaceBridge.getState().then((state) => {
        if (active && state.current && state.current.id === context.workspaceId) {
          setWorkspaceSnapshot(state.current)
        }
      }).catch(() => undefined)
    }
    refreshTasks()
    const unsubscribe = window.remoteVSCode?.gitSync?.onBindingsChanged(refreshTasks)
    return () => { active = false; unsubscribe?.() }
  }, [context.workspaceId])

  const tasks: readonly TaskRecord[] = useMemo(() => {
    const list = workspaceSnapshot.tasks
    return list.some((item) => item.id === context.task.id) ? list : [context.task, ...list]
  }, [workspaceSnapshot.tasks, context.task])

  const validTaskIds = useMemo(() => new Set(tasks.map((item) => item.id)), [tasks])
  const effectiveTree = useMemo(
    () => reconcilePaneTreeWithTasks(paneTree, validTaskIds, context.task.id),
    [paneTree, validTaskIds, context.task.id],
  )
  const paneGroups = useMemo(() => listPaneGroups(effectiveTree.root), [effectiveTree.root])
  const isMultiPane = paneGroups.length > 1
  const focusedGroup = useMemo(() => activePaneGroup(effectiveTree), [effectiveTree])
  const activeTask = useMemo(
    () => tasks.find((item) => item.id === focusedGroup.activeTaskId) ?? context.task,
    [tasks, focusedGroup.activeTaskId, context.task],
  )

  // Merge initial target immediately on frame 1 so the popup connects without waiting for session-links IPC.
  const mergedBindings: SessionBindings = useMemo(() => {
    if (!context.target) return links.bindings
    const existing = links.bindings[context.task.id] ?? []
    const seedKey = `ahp:${agentHostKey(context.target)}`
    if (existing.some((entry) => sessionBindingKey(entry) === seedKey)) return links.bindings
    const seedBinding: SessionBinding = {
      id: context.target.sessionId,
      title: 'Agent Host',
      owner: context.target.owner,
      agentHost: context.target,
    }
    return {
      ...links.bindings,
      [context.task.id]: [seedBinding, ...existing],
    }
  }, [links.bindings, context.task.id, context.target])

  const orderedBindingsForTask = useCallback((taskId: string): readonly SessionBinding[] => {
    const raw = mergedBindings[taskId] ?? []
    if (!raw.length) return raw
    return treeSessionBindings(buildSessionTree(raw, {
      mode: selection.taskSortMode(taskId),
      orderedKeys: selection.sessionOrders[taskId],
      titles: sessionTitles.titles,
      timestamps: sessionTitles.timestamps,
      aliases,
    }, selection.sessionGroups[taskId]).entries)
  }, [mergedBindings, selection, sessionTitles.titles, sessionTitles.timestamps, aliases])

  const activeTaskBindings = useMemo(
    () => orderedBindingsForTask(activeTask.id),
    [orderedBindingsForTask, activeTask.id],
  )
  const { sessionKey: activeSessionKey, binding: activeBinding } = useMemo(
    () => resolveGroupActiveBinding(focusedGroup, activeTask.id, activeTaskBindings),
    [focusedGroup, activeTask.id, activeTaskBindings],
  )

  const handleDraftSnapshot = useCallback((groupId: string, taskId: string, sessionKey: string, draft: string) => {
    draftsRef.current[`${groupId}:${taskId}:${sessionKey}`] = draft
  }, [])

  const reportPanelBusy = useCallback((value: boolean, key?: string) => {
    if (!key) return
    setBusyPanels((current) => {
      if (Boolean(current[key]) === value) return current
      const next = { ...current }
      if (value) next[key] = true
      else delete next[key]
      return next
    })
  }, [])
  const busy = Object.keys(busyPanels).length > 0

  const applyTreeChange = useCallback((updater: (current: PaneTreeState) => PaneTreeState) => {
    setPaneTree((previous) => {
      const base = reconcilePaneTreeWithTasks(previous, validTaskIds, context.task.id)
      return updater(base)
    })
  }, [validTaskIds, context.task.id])

  useEffect(() => {
    const onStorage = () => {
      const next = readLayout().theme
      setTheme((current) => current === next ? current : next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    let mounted = true
    let changed = false
    const bridge = window.desktop
    const unlisten = bridge?.onFullScreenChanged((value) => { changed = true; if (mounted) setFullScreen(value) })
    void bridge?.getInfo().then((info) => { if (mounted) setDesktop(info) }).catch(() => { if (mounted) setDesktopError(true) })
    void bridge?.getFullScreen().then((value) => { if (mounted && !changed) setFullScreen(value) }).catch(() => { if (mounted) setDesktopError(true) })
    return () => { mounted = false; unlisten?.() }
  }, [])

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'toggleFullScreen' | 'close'): void {
    void window.desktop?.[action]().catch(() => setDesktopError(true))
  }

  async function popOutAnotherWindow({
    groupId,
    taskId,
    binding,
    draft,
    mode,
  }: {
    groupId: string
    taskId: string
    binding?: SessionBinding
    draft?: string
    mode: SessionWindowMode
  }): Promise<boolean> {
    const windowsBridge = window.desktop?.windows
    if (!windowsBridge) return false
    setActionError(null)
    try {
      const sessionKey = binding ? sessionBindingKey(binding) : undefined
      const fallbackDraft = draft ?? (sessionKey ? draftsRef.current[`${groupId}:${taskId}:${sessionKey}`] : undefined)
      const trimmedDraft = fallbackDraft?.trim() ? fallbackDraft : undefined
      const result = await windowsBridge.open({
        taskId,
        ...(binding ? { target: binding.agentHost, sessionKey } : {}),
        mode,
        ...(mode === 'move' && trimmedDraft ? { draft: trimmedDraft } : {}),
      })
      if (!result.opened) return false
      if (mode === 'move') {
        const source = findPaneGroup(effectiveTree.root, groupId)
        if (source && (paneGroups.length > 1 || source.openTaskIds.length > 1)) {
          applyTreeChange((current) => closeTaskPageInGroup(current, groupId, taskId))
          return true
        }
      }
      return false
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'The task window could not be opened.')
      return false
    }
  }

  async function dockToMainWindow(): Promise<void> {
    if (docking) return
    setDocking(true)
    setActionError(null)
    try {
      const pages: DockedTaskPage[] = []
      const seen = new Set<string>()
      for (const group of paneGroups) {
        for (const taskId of group.openTaskIds) {
          const ordered = orderedBindingsForTask(taskId)
          const { sessionKey, binding } = resolveGroupActiveBinding(group, taskId, ordered)
          const dedupeKey = `${taskId}:${sessionKey ?? ''}`
          if (seen.has(dedupeKey)) continue
          seen.add(dedupeKey)
          const rawDraft = sessionKey ? draftsRef.current[`${group.id}:${taskId}:${sessionKey}`] : undefined
          const draft = rawDraft?.trim() ? rawDraft : undefined
          pages.push({
            taskId,
            ...(sessionKey !== undefined ? { sessionKey } : {}),
            ...(binding ? { target: binding.agentHost } : {}),
            ...(draft ? { draft } : {}),
          })
        }
      }
      const primaryDraftRaw = activeSessionKey ? draftsRef.current[`${focusedGroup.id}:${activeTask.id}:${activeSessionKey}`] : undefined
      const primaryDraft = primaryDraftRaw?.trim() ? primaryDraftRaw : undefined
      await window.desktop?.windows?.dock({
        taskId: activeTask.id,
        ...(activeBinding ? { target: activeBinding.agentHost } : {}),
        ...(activeSessionKey !== undefined ? { sessionKey: activeSessionKey } : {}),
        ...(primaryDraft ? { draft: primaryDraft } : {}),
        ...(pages.length ? { pages } : {}),
      })
    } catch (failure) {
      setDocking(false)
      setActionError(failure instanceof Error ? failure.message : 'Could not dock task pages back into the main window.')
    }
  }

  const switchTaskShortcut = useEffectEvent((event: KeyboardEvent) => {
    const openIds = focusedGroup.openTaskIds
    if (event.defaultPrevented || openIds.length <= 1 || document.querySelector('dialog[open]')) return
    event.preventDefault()
    const index = openIds.indexOf(activeTask.id)
    const next = index < 0 ? 0 : (index + (event.key === 'PageDown' ? 1 : openIds.length - 1)) % openIds.length
    applyTreeChange((current) => openTaskPageInGroup(current, current.activeGroupId, openIds[next]))
  })

  const switchSessionShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || activeTaskBindings.length <= 1 || document.querySelector('dialog[open]')) return
    event.preventDefault()
    const index = activeTaskBindings.findIndex((item) => sessionBindingKey(item) === activeSessionKey)
    const step = event.key === 'PageDown' ? 1 : activeTaskBindings.length - 1
    const next = index < 0 ? 0 : (index + step) % activeTaskBindings.length
    applyTreeChange((current) => selectSessionInGroup(current, current.activeGroupId, activeTask.id, sessionBindingKey(activeTaskBindings[next])))
  })

  const handleSplitShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (event.shiftKey) {
      if (paneGroups.length > 1) applyTreeChange((current) => removePaneGroup(current, current.activeGroupId))
      return
    }
    applyTreeChange((current) => splitPaneGroup(current, current.activeGroupId, 'right', { sessionKey: activeSessionKey }))
  })

  const handleChordFollowup = useEffectEvent((event: KeyboardEvent): boolean => {
    if (performance.now() > chordUntilRef.current) return false
    if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Shift' || event.key === 'Alt') return false
    chordUntilRef.current = 0
    const key = event.key.toLowerCase()
    if (key === 'o' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      void popOutAnotherWindow({ groupId: focusedGroup.id, taskId: activeTask.id, binding: activeBinding, mode: 'copy' })
      return true
    }
    if ((event.code === 'Backslash' || event.key === '\\') && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      applyTreeChange((current) => splitPaneGroup(current, current.activeGroupId, 'down', { sessionKey: activeSessionKey }))
      return true
    }
    return false
  })

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (handleChordFollowup(event)) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        chordUntilRef.current = performance.now() + 1500
        return
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
        if (event.shiftKey) switchSessionShortcut(event)
        else switchTaskShortcut(event)
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'Backslash' || event.key === '\\' || event.key === '|')) {
        handleSplitShortcut(event)
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [])

  const unifiedChatHeader = !isMultiPane && Boolean(activeBinding)
  const ownerDisplay = activeBinding ? machineLabel(activeBinding.owner, aliases) : undefined

  return <div className="workbench session-window" data-theme={theme} data-compact={false}>
    <header className="titlebar session-window-titlebar" aria-label="Session window toolbar" data-chat-header={unifiedChatHeader}>
      <div className="app-brand session-window-brand">
        <span className="brand-mark"><img src={appIcon} alt="" width={20} height={20} /></span>
        <span className="session-window-task-pill" title={`${activeTask.id} · ${activeTask.title}`}>{activeTask.id}</span>
      </div>
      <div className="titlebar-chat" ref={setChatHeaderTarget} hidden={!unifiedChatHeader} />
      {!unifiedChatHeader && <div className="session-window-title-spacer">{activeTask.title}</div>}
      <div className="titlebar-actions">
        <button type="button" className="session-window-dock-button" aria-label="Dock session to main window" title="Dock task pages back into the main window" disabled={docking} onClick={() => { void dockToMainWindow() }}>
          <Icon name="layout-panel-dock" />
          <span>Dock</span>
        </button>
      </div>
      {window.desktop && <div className="window-controls">
        <IconButton icon={fullScreen ? 'screen-normal' : 'screen-full'} label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={`${fullScreen ? 'Exit' : 'Enter'} full screen (F11 / Shift+Alt+Enter)`} aria-pressed={fullScreen} onClick={() => windowAction('toggleFullScreen')} />
        <IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} />
        <IconButton icon="chrome-maximize" label="Maximize or restore window" disabled={fullScreen} onClick={() => windowAction('toggleMaximize')} />
        <IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} />
      </div>}
    </header>

    {updateSafetyError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{updateSafetyError}</span></div>}
    {actionError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{actionError}</span><IconButton icon="close" label="Dismiss session window error" onClick={() => setActionError(null)} /></div>}

    <main className="main-panel session-window-main" aria-label="Standalone session workspace">
      <PaneWorkspaceGrid
        tree={effectiveTree}
        onTreeChange={applyTreeChange}
        tasks={tasks}
        bindings={mergedBindings}
        orderedBindingsForTask={orderedBindingsForTask}
        linksBusy={links.busy}
        linksReady={links.ready || Boolean(context.target)}
        workspaceAvailable={true}
        theme={theme}
        compact={false}
        isPopupWindow={true}
        unifiedHeaderTarget={unifiedChatHeader ? chatHeaderTarget : null}
        cachedTitles={sessionTitles.titles}
        customTitles={sessionTitles.customTitles}
        restoredDrafts={restoredDrafts}
        onTitles={sessionTitles.remember}
        onRenameSession={sessionTitles.rename}
        onDraftSnapshot={handleDraftSnapshot}
        onBusyChange={reportPanelBusy}
        onPopOutTaskPage={window.desktop?.windows ? popOutAnotherWindow : undefined}
      />
    </main>

    <footer className="statusbar" aria-label="Session window status">
      <span className="local-status"><Icon name="multiple-windows" />{isMultiPane ? `POPUP SPLIT (${paneGroups.length})` : 'TASK WINDOW'}</span>
      <span title={context.workspaceRoot}><Icon name="folder" />{context.workspaceName}</span>
      <span className="session-window-status-task" title={activeTask.title}>{activeTask.id} · {activeTask.title}</span>
      <span className="statusbar-spacer" />
      <span className="response-status" role="status" title={activeBinding?.owner.machineName}>
        {busy ? 'Agent Host active' : ownerDisplay ? `Agent Host @ ${ownerDisplay}` : 'Select a session'}
      </span>
      <button type="button" disabled={docking} onClick={() => { void dockToMainWindow() }}><Icon name="layout-panel-dock" />Dock to main window</button>
      <span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Desktop'}</span>
    </footer>

    <UpdateNotice updates={updates} />
  </div>
}
