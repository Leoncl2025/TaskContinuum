import { Activity, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { DesktopInfo, DesktopWindowContext, SessionWindowActivatedEvent, SessionWindowMode, SessionWindowSummary } from '../shared/desktop'
import { filterTasks } from '../shared/tasks'
import type { WorkspaceSnapshot } from '../shared/workspace'
import { useSessionLinks } from './chat/useSessionLinks'
import { useWorkbenchSelection } from './chat/useWorkbenchSelection'
import { sessionBindingKey } from './chat/sessionBindings'
import type { SessionBinding } from './chat/sessionBindings'
import { buildSessionTree, treeSessionBindings } from './chat/sessionGroups'
import { taskSessionLinks } from '../shared/sessionBindings'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { defaultLayout, isCompact, panelSizes, readLayout, resizePanel, saveLayout, subscribeCompact, subscribeViewport, viewportWidth } from './layout'
import type { LayoutPanel, LayoutPreferences, SplitDirection } from './layout'
import { PanelSash } from './components/PanelSash'
import { PaneWorkspaceGrid } from './components/PaneWorkspaceGrid'
import { SessionContextMenu } from './components/SessionContextMenu'
import type { SessionContextMenuTarget } from './components/SessionContextMenu'
import {
  activePaneGroup,
  clearDetachedSessionFromTree,
  closeTaskPageInGroup,
  createInitialPaneTree,
  findPaneGroup,
  findParentSplit,
  listPaneGroups,
  openTaskPageInGroup,
  reconcilePaneTreeWithTasks,
  removePaneGroup,
  resolveGroupActiveBinding,
  selectSessionInGroup,
  splitPaneGroup,
  swapParentSplitChildren,
  toggleParentSplitOrientation,
} from './paneTree'
import type { PaneTreeState } from './paneTree'
import { useWorkspaces } from './useWorkspaces'
import { WorkspacePicker } from './components/WorkspacePicker'
import { RepositorySetup } from './components/RepositorySetup'
import { TaskCreationDialog } from './components/TaskCreationDialog'
import { LocalTaskAgent } from './components/LocalTaskAgent'
import type { TaskCreationMode } from './components/TaskCreationDialog'
import { RemoteDevicesDialog } from './components/RemoteDevicesDialog'
import { AgentHostSessionsSidebar } from './components/AgentHostSessionsSidebar'
import type { AgentHostHistoryTransfer, AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import { agentHostKey } from '../shared/agentHost'
import { useSessionTitles } from './chat/useSessionTitles'
import { machineLabel, useMachineAliases, useWorkspaceGitSync } from './machineAliases'
import { MachineAliasesProvider } from './MachineAliasesProvider'
import { USER_DISPLAY_NAME_MAX_LENGTH, UserProfileContext, useUserProfileState } from './userProfile'
import { UpdateNotice, UpdateSettings, UpdateStatus, useUpdates } from './components/UpdateSettings'
import { registerInstallSafety } from './installSafety'
import { SessionWindowApp } from './SessionWindow'
import appIcon from '../../build/icon.png'

type DialogName = 'quick-open' | 'settings' | 'remote-devices' | 'updates' | null

function WorkbenchBody({ layout, children }: { layout: LayoutPreferences; children: ReactNode }) {
  const width = useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
  const sizes = panelSizes(layout, width)
  return <div className="workbench-body" style={{ '--sidebar-width': `${sizes.sidebar.width}px`, '--details-width': `${sizes.details.width}px` } as CSSProperties}>{children}</div>
}

function WorkbenchSash({ layout, panel, onResize, onReset }: {
  layout: LayoutPreferences
  panel: LayoutPanel
  onResize(width: number): void
  onReset(): void
}) {
  const width = useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
  return <PanelSash panel={panel} {...panelSizes(layout, width)[panel]} onResize={onResize} onReset={onReset} />
}

export default function App() {
  const updates = useUpdates()
  const [updateSafetyError, setUpdateSafetyError] = useState<string>()
  const [windowContext, setWindowContext] = useState<DesktopWindowContext | undefined>(() =>
    window.desktop?.windows ? undefined : { kind: 'main' },
  )
  useEffect(() => {
    if (window.updates) return registerInstallSafety(window.updates, document, setUpdateSafetyError)
  }, [])
  useEffect(() => {
    const windowsBridge = window.desktop?.windows
    if (!windowsBridge) return
    let mounted = true
    void windowsBridge.getContext().then((ctx) => {
      if (mounted) setWindowContext(ctx)
    }).catch(() => {
      if (mounted) setWindowContext({ kind: 'main' })
    })
    return () => { mounted = false }
  }, [])

  if (!windowContext) return <div className="workbench" data-theme={readLayout().theme} />
  if (windowContext.kind === 'session') {
    return <SessionWindowApp context={windowContext} updates={updates} updateSafetyError={updateSafetyError} />
  }
  return <MainWorkbenchRoot updates={updates} updateSafetyError={updateSafetyError} />
}

function MainWorkbenchRoot({ updates, updateSafetyError }: {
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
}) {
  const workspaces = useWorkspaces()
  const [repositorySetup, setRepositorySetup] = useState<'new' | WorkspaceSnapshot | null>(null)
  return <>
    <MachineAliasesProvider workspaceId={workspaces.state.current?.id ?? null}><Workbench key={workspaces.state.current?.id ?? 'empty'} workspaces={workspaces} updates={updates} updateSafetyError={updateSafetyError} repositorySetupOpen={repositorySetup !== null} onCreateRepository={() => setRepositorySetup('new')} onPublishRepository={setRepositorySetup} /></MachineAliasesProvider>
    {repositorySetup && <div className="repository-dialog-theme" data-theme={readLayout().theme} data-update-blocker="Finish or close repository creation before updating."><RepositorySetup workspace={repositorySetup === 'new' ? null : repositorySetup} workspaces={workspaces} onClose={() => setRepositorySetup(null)} /></div>}
  </>
}

function Workbench({ workspaces, updates, updateSafetyError, repositorySetupOpen, onCreateRepository, onPublishRepository }: {
  workspaces: ReturnType<typeof useWorkspaces>
  updates: ReturnType<typeof useUpdates>
  updateSafetyError?: string
  repositorySetupOpen: boolean
  onCreateRepository(): void
  onPublishRepository(workspace: WorkspaceSnapshot): void
}) {
  const workspace = workspaces.state.current
  const workspaceRoot = workspace?.root
  const sessionTitles = useSessionTitles(workspace?.id)
  const selection = useWorkbenchSelection(workspace?.id)
  const aliases = useMachineAliases()
  const { status: gitSyncStatus, error: machineAliasesError, refresh: refreshMachineAliases } = useWorkspaceGitSync()
  const [taskAgentOpen, setTaskAgentOpen] = useState(false)
  const links = useSessionLinks(!taskAgentOpen && workspace?.tasks.length ? workspace : null)
  const bindings = links.bindings
  const tasks = useMemo(() => workspace?.tasks ?? [], [workspace])
  const validTaskIds = useMemo(() => new Set(tasks.map((item) => item.id)), [tasks])

  const [paneTree, setPaneTree] = useState<PaneTreeState>(() => {
    if (selection.paneTree) {
      return selection.paneTree
    }
    const requested = selection.taskId === undefined ? tasks[0]?.id ?? null : selection.taskId
    const validSelected = requested !== null && !tasks.some((item) => item.id === requested) ? tasks[0]?.id ?? null : requested
    const savedOpen = selection.openTaskIds ?? (validSelected ? [validSelected] : [])
    const validOpen = [...new Set([...savedOpen.filter((id) => tasks.some((item) => item.id === id)), ...(validSelected ? [validSelected] : [])])]
    return createInitialPaneTree(validOpen, validSelected, selection.sessions)
  })
  const userEmptiedTabsRef = useRef(selection.taskId === null)

  const effectiveTree = useMemo(
    () => reconcilePaneTreeWithTasks(paneTree, validTaskIds, userEmptiedTabsRef.current ? null : tasks[0]?.id ?? null),
    [paneTree, validTaskIds, tasks],
  )
  const paneGroups = useMemo(() => listPaneGroups(effectiveTree.root), [effectiveTree.root])
  const splitActive = !taskAgentOpen && paneGroups.length > 1
  const focusedGroup = useMemo(() => activePaneGroup(effectiveTree), [effectiveTree])
  const selectedId = focusedGroup.activeTaskId
  const openTasks = focusedGroup.openTaskIds

  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [sidebarView, setSidebarView] = useState<'tasks' | 'sessions'>('tasks')
  const [expandSessionRequest, setExpandSessionRequest] = useState<{ taskId: string; key: string; id: number; active: boolean }>()
  const [renameSessionRequest, setRenameSessionRequest] = useState<{ taskId: string; key: string; id: number }>()
  const [popoutWindows, setPopoutWindows] = useState<SessionWindowSummary[]>([])
  const [restoredDrafts, setRestoredDrafts] = useState<Record<string, { nonce: number; text: string }>>({})
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SessionContextMenuTarget | null>(null)
  const [busyPanels, setBusyPanels] = useState<Record<string, boolean>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const chordUntilRef = useRef(0)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [chatHeaderTarget, setChatHeaderTarget] = useState<HTMLDivElement | null>(null)
  const [taskCreationMode, setTaskCreationMode] = useState<'form' | 'draft' | null>(null)
  const [taskAgentBusy, setTaskAgentBusy] = useState(false)
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | 'details'>(() => workspace?.tasks.length ? 'chat' : 'details')
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const userProfile = useUserProfileState(desktop?.userProfile)
  const profileInitial = (userProfile.effectiveDisplayName ? Array.from(userProfile.effectiveDisplayName.trim())[0]?.toUpperCase() : undefined) || 'Y'
  const [fullScreen, setFullScreen] = useState(false)
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)

  const task = tasks.find((item) => item.id === selectedId)
  const primaryPanel = task || taskAgentOpen ? 'chat' : 'details'

  const taskSortMode = selection.taskSortMode
  const sessionOrders = selection.sessionOrders
  const sessionGroups = selection.sessionGroups
  const orderedBindingsForTask = useMemo(() => {
    const cache = new Map<string, readonly SessionBinding[]>()
    return (taskId: string): readonly SessionBinding[] => {
      const cached = cache.get(taskId)
      if (cached) return cached
      const raw = bindings[taskId] ?? []
      if (!raw.length) {
        cache.set(taskId, raw)
        return raw
      }
      const ordered = treeSessionBindings(buildSessionTree(raw, {
        mode: taskSortMode(taskId),
        orderedKeys: sessionOrders[taskId],
        titles: sessionTitles.titles,
        timestamps: sessionTitles.timestamps,
        aliases,
      }, sessionGroups[taskId]).entries)
      cache.set(taskId, ordered)
      return ordered
    }
  }, [bindings, taskSortMode, sessionOrders, sessionGroups, sessionTitles.titles, sessionTitles.timestamps, aliases])

  const taskBindings = useMemo(
    () => task ? orderedBindingsForTask(task.id) : [],
    [task, orderedBindingsForTask],
  )
  const { sessionKey: activeKey, binding: activeBinding } = useMemo(
    () => resolveGroupActiveBinding(focusedGroup, task?.id ?? null, taskBindings, selection.sessions),
    [focusedGroup, task, taskBindings, selection.sessions],
  )
  const activePanelKey = task && activeBinding ? `${task.id}:${sessionBindingKey(activeBinding)}` : undefined

  const popoutPanelKeys = useMemo(() => new Set(popoutWindows.map((item) => item.key)), [popoutWindows])
  const sidebarTask = task
  const sidebarSortMode = selection.taskSortMode(sidebarTask?.id)
  const sidebarOrderedKeys = sidebarTask ? selection.sessionOrders[sidebarTask.id] : undefined
  const sidebarSessionLayout = sidebarTask ? selection.sessionGroups[sidebarTask.id] : undefined
  const sidebarActiveKey = activeKey
  const sidebarPopoutKeys = useMemo(() => {
    if (!sidebarTask) return undefined
    const keys = new Set<string>()
    for (const item of popoutWindows) {
      if (item.taskId === sidebarTask.id && item.target) keys.add(`ahp:${agentHostKey(item.target)}`)
    }
    return keys
  }, [sidebarTask, popoutWindows])
  const awaitingSyncCountForTask = useCallback(
    (taskId: string) => (gitSyncStatus?.awaitingSync ?? []).filter((marker) => marker.taskId === taskId).length,
    [gitSyncStatus?.awaitingSync],
  )
  const sidebarAwaitingSyncCount = sidebarTask ? awaitingSyncCountForTask(sidebarTask.id) : 0
  const sidebarProvisional = Boolean(sidebarTask && gitSyncStatus?.provisionalTasks.includes(sidebarTask.id))

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
  const handleDraftSnapshot = useCallback((groupId: string, taskId: string, sessionKey: string, draft: string) => {
    draftsRef.current[`${groupId}:${taskId}:${sessionKey}`] = draft
  }, [])

  const agentHostBusy = Object.keys(busyPanels).length > 0
  const [syncingLinks, setSyncingLinks] = useState(false)
  const [agentHostRevision, setAgentHostRevision] = useState(0)
  const [historyTransfers, setHistoryTransfers] = useState<Record<string, AgentHostHistoryTransfer>>({})
  const reportHistoryTransfer = useCallback((target: AgentHostTarget, progress: AgentHostHistoryTransfer | undefined) => {
    const key = agentHostKey(target)
    setHistoryTransfers((current) => {
      if (!progress && !current[key]) return current
      const next = { ...current }
      if (progress) next[key] = progress
      else delete next[key]
      return next
    })
  }, [])
  useEffect(() => {
    const bridge = window.agentHost
    if (!bridge || !workspaceRoot) return
    return bridge.onHistoryTransfer((event) => {
      if (event.root === workspaceRoot) reportHistoryTransfer(event.target, event.progress)
    })
  }, [workspaceRoot, reportHistoryTransfer])

  const creationLifetime = useRef({ active: false })
  const sessionViewLifetime = useRef({ active: false })
  const currentTaskId = useRef(selectedId)
  const currentSessionKey = useRef(activeKey)
  const sidebarVisible = compact ? compactPanel === 'tasks' : layout.sidebar
  const chatVisible = compact ? compactPanel === 'chat' : layout.chat
  const detailsVisible = compact ? compactPanel === 'details' : layout.details
  const unifiedChatHeader = chatVisible && !taskAgentOpen && !splitActive && Boolean(activePanelKey)
  const focusedBinding = activeBinding
  const sessionBusy = agentHostBusy || taskAgentBusy
  const workspaceLocked = repositorySetupOpen || taskCreationMode !== null || links.busy || sessionBusy || dialog === 'remote-devices'
  const connectionError = (taskAgentOpen ? null : links.error) ?? actionError

  const paneTreeRef = useRef(effectiveTree)
  useEffect(() => { paneTreeRef.current = effectiveTree }, [effectiveTree])

  const syncPaneSelection = selection.syncPaneSelection
  const applyTreeChange = useCallback((updater: (current: PaneTreeState) => PaneTreeState, options?: { skipSync?: boolean }) => {
    const base = reconcilePaneTreeWithTasks(paneTreeRef.current, validTaskIds, userEmptiedTabsRef.current ? null : tasks[0]?.id ?? null)
    const next = updater(base)
    paneTreeRef.current = next
    const nextFocused = activePaneGroup(next)
    userEmptiedTabsRef.current = nextFocused.activeTaskId === null && listPaneGroups(next.root).length === 1
    currentTaskId.current = nextFocused.activeTaskId
    if (!options?.skipSync) {
      syncPaneSelection(nextFocused.activeTaskId, nextFocused.openTaskIds, nextFocused.sessions, next)
    }
    if (next !== base) setPaneTree(next)
    return next
  }, [validTaskIds, tasks, syncPaneSelection])

  useEffect(() => {
    const scope = { active: true }
    creationLifetime.current = scope
    return () => { scope.active = false }
  }, [])
  useEffect(() => { currentTaskId.current = selectedId }, [selectedId])
  useEffect(() => { currentSessionKey.current = activeKey }, [activeKey])
  const rememberDefaultSession = selection.rememberDefaultSession
  useEffect(() => {
    if (!task || !activeBinding || !links.ready) return
    rememberDefaultSession(task.id, sessionBindingKey(activeBinding))
  }, [task, activeBinding, links.ready, rememberDefaultSession])
  useEffect(() => {
    const scope = { active: sidebarVisible && sidebarView === 'sessions' }
    sessionViewLifetime.current = scope
    return () => { scope.active = false }
  }, [sidebarVisible, sidebarView, selectedId])

  useEffect(() => { saveLayout(layout) }, [layout])
  useEffect(() => {
    const onStorage = () => {
      const next = readLayout().theme
      setLayout((current) => current.theme === next ? current : { ...current, theme: next })
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

  const showChat = useCallback(() => {
    setCompactPanel('chat')
    if (!compact) setLayout((value) => value.chat ? value : { ...value, chat: true })
    const previousFocus = document.activeElement
    requestAnimationFrame(() => {
      const composer = document.getElementById('chat-composer')
      const focused = document.activeElement
      if (document.querySelector('dialog[open]') || focused !== previousFocus && focused !== document.body && focused !== composer) return
      composer?.focus({ preventScroll: true })
    })
  }, [compact])

  const showTaskChat = useCallback(() => {
    setTaskAgentOpen(false)
    showChat()
  }, [showChat])

  const activateDockedSession = useEffectEvent((event: SessionWindowActivatedEvent) => {
    const pagesToDock = event.pages?.length
      ? event.pages.filter((page) => tasks.some((item) => item.id === page.taskId))
      : tasks.some((item) => item.id === event.taskId)
        ? [{
            taskId: event.taskId,
            sessionKey: event.sessionKey ?? (event.target ? `ahp:${agentHostKey(event.target)}` : undefined),
            draft: event.draft,
          }]
        : []
    if (!pagesToDock.length) return

    setRestoredDrafts((current) => {
      let updated = current
      for (const item of pagesToDock) {
        if (!item.draft) continue
        const resolvedKey = item.sessionKey
        if (!resolvedKey) continue
        const localKey = `${item.taskId}:${resolvedKey}`
        updated = {
          ...updated,
          [localKey]: { nonce: (updated[localKey]?.nonce ?? 0) + 1, text: item.draft },
        }
      }
      return updated
    })

    applyTreeChange((current) => {
      let next = current
      for (const item of pagesToDock) {
        next = openTaskPageInGroup(next, next.activeGroupId, item.taskId, item.sessionKey)
      }
      const primary = pagesToDock.find((item) => item.taskId === event.taskId) ?? pagesToDock.at(-1)!
      return openTaskPageInGroup(next, next.activeGroupId, primary.taskId, primary.sessionKey)
    })
    showTaskChat()
  })

  useEffect(() => {
    const windowsBridge = window.desktop?.windows
    if (!windowsBridge) return
    let mounted = true
    void windowsBridge.list().then((items) => { if (mounted) setPopoutWindows(items) }).catch(() => undefined)
    const unlistenChanged = windowsBridge.onChanged((items) => { if (mounted) setPopoutWindows(items) })
    const unlistenActivate = windowsBridge.onActivateSession((event) => activateDockedSession(event))
    return () => {
      mounted = false
      unlistenChanged()
      unlistenActivate()
    }
  }, [workspaceRoot])

  const toggleSidebar = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'tasks' ? primaryPanel : 'tasks')
    else setLayout((value) => ({ ...value, sidebar: !value.sidebar }))
  }, [compact, primaryPanel, setCompactPanel, setLayout])
  const toggleChat = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'chat' ? 'details' : 'chat')
    else setLayout((value) => ({ ...value, chat: !value.chat, details: value.chat || value.details }))
  }, [compact, setCompactPanel, setLayout])
  const toggleDetails = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'details' ? 'chat' : 'details')
    else setLayout((value) => ({ ...value, details: !value.details, chat: value.details || value.chat }))
  }, [compact, setCompactPanel, setLayout])

  const switchTaskFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || workspaces.busy || !openTasks.length || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (openTasks.length === 1) return
    const index = openTasks.indexOf(currentTaskId.current ?? '')
    const next = index < 0 ? event.key === 'PageDown' ? 0 : openTasks.length - 1
      : (index + (event.key === 'PageDown' ? 1 : openTasks.length - 1)) % openTasks.length
    selectTask(openTasks[next])
    const focusedTablist = document.querySelector<HTMLElement>(`.pane-group-unit[data-group-id="${CSS.escape(focusedGroup.id)}"] [role="tablist"]`)
      ?? document.querySelector<HTMLElement>('.editor-tabs[role="tablist"]')
    focusedTablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  })

  const switchSessionFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || workspaces.busy || taskAgentOpen || !task
      || !links.ready || !taskBindings.length || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (taskBindings.length === 1) return
    const currentKey = currentTaskId.current === task.id ? currentSessionKey.current : activeKey
    const index = taskBindings.findIndex((binding) => sessionBindingKey(binding) === currentKey)
    const step = event.key === 'PageDown' ? 1 : taskBindings.length - 1
    const next = index < 0 ? event.key === 'PageDown' ? 0 : taskBindings.length - 1
      : (index + step) % taskBindings.length
    selectSession(task.id, taskBindings[next])
  })

  const handleSplitShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || workspaces.busy || taskAgentOpen || !task || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (event.shiftKey) {
      if (paneGroups.length > 1) {
        applyTreeChange((current) => removePaneGroup(current, current.activeGroupId))
      }
      return
    }
    applyTreeChange((current) => splitPaneGroup(current, current.activeGroupId, 'right', { sessionKey: activeKey }))
    showTaskChat()
  })

  const handleChordFollowup = useEffectEvent((event: KeyboardEvent): boolean => {
    if (performance.now() > chordUntilRef.current) return false
    if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Shift' || event.key === 'Alt') return false
    chordUntilRef.current = 0
    const key = event.key.toLowerCase()
    if (key === 'o' && !event.altKey && !event.shiftKey) {
      if (task && !workspaces.busy && !taskAgentOpen) {
        event.preventDefault()
        void popOutTaskPage({
          groupId: focusedGroup.id,
          taskId: task.id,
          binding: activeBinding,
          mode: 'copy',
        })
        return true
      }
    }
    if ((event.code === 'Backslash' || event.key === '\\') && !event.altKey && !event.shiftKey) {
      if (task && !workspaces.busy && !taskAgentOpen) {
        event.preventDefault()
        applyTreeChange((current) => splitPaneGroup(current, current.activeGroupId, 'down', { sessionKey: activeKey }))
        showTaskChat()
        return true
      }
    }
    return false
  })

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (dialog || taskCreationMode || repositorySetupOpen || event.isComposing) return
      if (handleChordFollowup(event)) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        chordUntilRef.current = performance.now() + 1500
        return
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
        if (event.shiftKey) switchSessionFromShortcut(event)
        else switchTaskFromShortcut(event)
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'Backslash' || event.key === '\\' || event.key === '|')) {
        handleSplitShortcut(event)
      } else if ((event.ctrlKey || event.metaKey) && key === 'b' && !event.shiftKey) {
        event.preventDefault()
        if (event.altKey) toggleChat()
        else toggleSidebar()
      } else if ((event.ctrlKey || event.metaKey) && key === 'd' && event.altKey && !event.shiftKey) {
        event.preventDefault(); toggleDetails()
      } else if ((event.ctrlKey || event.metaKey) && key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault(); setQuickQuery(''); setDialog('quick-open')
      } else if ((event.ctrlKey || event.metaKey) && key === 'n' && !event.shiftKey && !event.altKey && workspace && workspaces.available && !workspaceLocked && !workspaces.busy) {
        event.preventDefault(); setTaskCreationMode('form')
      } else if (event.key === 'Escape' && compact) setCompactPanel(primaryPanel)
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [compact, primaryPanel, dialog, taskCreationMode, repositorySetupOpen, workspace, workspaces.available, workspaces.busy, workspaceLocked, toggleChat, toggleDetails, toggleSidebar])

  function selectTask(id: string): void {
    currentTaskId.current = id
    applyTreeChange((current) => openTaskPageInGroup(current, current.activeGroupId, id))
    showChat()
  }

  function openTaskCreation(mode: TaskCreationMode): void {
    if (!workspace || !workspaces.available || workspaceLocked || workspaces.busy) {
      workspaces.setError('Select a task workspace and finish the active operation before creating a task.')
      return
    }
    if (mode === 'agent') {
      setTaskAgentOpen(true)
      showChat()
    } else setTaskCreationMode(mode)
  }

  function taskCreated(taskId: string): void {
    setQuery('')
    setCreatedTaskId(taskId)
    selectTask(taskId)
    setTaskCreationMode(null)
  }

  function closeTask(id: string): void {
    applyTreeChange((current) => closeTaskPageInGroup(current, current.activeGroupId, id))
  }

  function changePanelWidth(panel: LayoutPanel, width: number): void {
    const desktopWidth = viewportWidth()
    setLayout((current) => resizePanel(current, panel, width, desktopWidth))
  }

  function openSidebar(): void {
    setSidebarView('tasks')
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => value.sidebar ? value : { ...value, sidebar: true })
  }

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'toggleFullScreen' | 'close'): void {
    void window.desktop?.[action]().catch(() => setDesktopError(true))
  }

  function openAgentHostSessions(): void {
    if (!workspace) { setActionError('Open a task workspace before selecting an Agent Host session.'); return }
    if (!window.agentHost) { setActionError('The Agent Host desktop API is unavailable. Open this workspace in the desktop app.'); return }
    setActionError(null)
    setTaskAgentOpen(false)
    setExpandSessionRequest((current) => current ? { ...current, active: false } : undefined)
    setSidebarView('sessions')
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => value.sidebar ? value : { ...value, sidebar: true })
  }

  function openSessionDetach(taskId: string, binding: SessionBinding): void {
    openAgentHostSessions()
    if (!workspace || !window.agentHost) return
    const key = sessionBindingKey(binding)
    selection.revealSessionGroup(taskId, key)
    setExpandSessionRequest((current) => ({ taskId, key, id: (current?.id ?? 0) + 1, active: true }))
  }

  function selectSession(taskId: string, binding: SessionBinding): void {
    const key = sessionBindingKey(binding)
    const ordered = orderedBindingsForTask(taskId)
    const fallbackKey = Object.hasOwn(selection.sessions, taskId)
      ? selection.sessions[taskId] ?? undefined
      : ordered[0]
        ? sessionBindingKey(ordered[0])
        : undefined
    currentTaskId.current = taskId
    currentSessionKey.current = key
    const nextTree = applyTreeChange((current) => selectSessionInGroup(current, current.activeGroupId, taskId, key, fallbackKey), { skipSync: true })
    const nextFocused = activePaneGroup(nextTree)
    selection.selectSession(taskId, key, nextFocused.openTaskIds, nextTree)
    showTaskChat()
  }

  function splitFromSidebarSession(direction: SplitDirection, taskId: string, binding: SessionBinding): void {
    setActionError(null)
    const sessionKey = sessionBindingKey(binding)
    applyTreeChange((current) => splitPaneGroup(current, current.activeGroupId, direction, { taskId, sessionKey }))
    showTaskChat()
  }

  async function popOutTaskPage({
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
    if (!windowsBridge) {
      setActionError('Opening a separate task window requires the desktop app.')
      return false
    }
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
        applyTreeChange((current) => {
          const source = findPaneGroup(current.root, groupId)
          if (!source) return current
          return closeTaskPageInGroup(current, groupId, taskId)
        })
        return true
      }
      return false
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'The task window could not be opened.')
      return false
    }
  }

  function focusPopOut(taskId: string, binding: SessionBinding): void {
    setActionError(null)
    void window.desktop?.windows?.focus({ taskId, target: binding.agentHost }).catch((failure: unknown) => {
      setActionError(failure instanceof Error ? failure.message : 'The task window could not be focused.')
    })
  }

  async function linkAgentHost(session: AgentHostSession): Promise<void> {
    const targetTask = sidebarTask
    if (!workspace || !targetTask || !links.ready) throw new Error('Select a task and reload its workspace links before linking an Agent Host chat.')
    const taskId = targetTask.id
    const scope = creationLifetime.current
    const sessionView = sessionViewLifetime.current
    const binding = { id: session.sessionId, title: session.title, owner: session.owner, agentHost: { sessionId: session.sessionId, chatId: session.chatId, owner: session.owner } }
    const existing = Object.entries(bindings).find(([, members]) => members.some((current) => current.id === binding.id && current.owner.clientId === binding.owner.clientId))?.[0]
    if (existing && existing !== taskId) throw new Error(`This session is already linked to ${existing}. Detach it there before moving it.`)
    await links.attach(taskId, binding)
    if (!scope.active) throw new Error('The original workspace was closed. Reopen it to view the saved session link.')
    setAgentHostRevision((value) => value + 1)
    setActionError(null)
    if (sessionView.active && currentTaskId.current === taskId) selectSession(taskId, binding)
  }

  async function agentHostCreated(taskId: string, session: AgentHostSession): Promise<void> {
    const scope = creationLifetime.current
    const sessionView = sessionViewLifetime.current
    if (!scope.active || !workspace || !tasks.some((item) => item.id === taskId)) throw new Error(`The original task ${taskId} is unavailable in this workspace.`)
    const snapshot = await links.reload()
    if (!scope.active) throw new Error('The original workspace was closed. Reopen it to recover the saved chat.')
    if (!snapshot) throw new Error('Reload the saved Agent Host binding before opening the created chat.')
    const linked = taskSessionLinks(snapshot.document.bindings, taskId).find((link) => agentHostKey(link) === agentHostKey(session))
    if (!linked) throw new Error('The task binding no longer includes the created chat. No replacement chat was selected.')
    if (sessionView.active && currentTaskId.current === taskId) selectSession(taskId, { id: session.sessionId, title: session.title, owner: session.owner, agentHost: linked })
  }

  async function detachSession(taskId: string, binding: SessionBinding): Promise<void> {
    setActionError(null)
    const key = sessionBindingKey(binding)
    const panelSuffix = `:${taskId}:${key}`
    if (!bindings[taskId]?.some((current) => sessionBindingKey(current) === key)) throw new Error('The task binding changed. Review the current Agent Host chat before detaching.')
    if (Object.keys(busyPanels).some((panelKey) => panelKey.endsWith(panelSuffix))) throw new Error('Wait for the current Agent Host operation to finish before detaching this session.')
    const popoutKey = `${taskId}:${key}`
    if (popoutPanelKeys.has(popoutKey)) await window.desktop?.windows?.dock({ taskId, target: binding.agentHost }).catch(() => undefined)
    await links.detach(taskId, binding)
    if (!creationLifetime.current.active) return
    setPaneTree((current) => clearDetachedSessionFromTree(current, taskId, key))
    selection.clearSession(taskId, key, focusedGroup.sessions[taskId] === key || taskId === selectedId && key === activeKey)
  }

  async function syncLinksNow(): Promise<void> {
    const api = window.remoteVSCode?.gitSync
    if (!api || syncingLinks) return
    setSyncingLinks(true)
    setActionError(null)
    try {
      await api.syncNow()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'Git synchronization failed.')
    } finally {
      await Promise.allSettled([refreshMachineAliases(), links.reload()])
      setSyncingLinks(false)
    }
  }

  function openWorkspace(): void {
    if (!workspaceLocked) { setActionError(null); void workspaces.openFolder() }
  }

  function selectWorkspace(id: string): void {
    if (workspaceLocked) return
    if (id === '') void workspaces.closeWorkspace()
    else void workspaces.openRecent(id)
  }

  const workspaceControls = <WorkspacePicker state={workspaces.state} busy={workspaces.busy} locked={!workspaces.available || workspaceLocked} onOpen={openWorkspace} onSelect={selectWorkspace} onRefresh={() => { if (!workspaceLocked) void workspaces.refresh() }} onPublish={() => { if (workspace && !workspaceLocked) onPublishRepository(workspace) }} />
  const sidebarParentSplit = sidebarContextMenu ? findParentSplit(effectiveTree.root, sidebarContextMenu.groupId) : undefined

  return <UserProfileContext.Provider value={userProfile}><div className="workbench" data-theme={layout.theme} data-compact={compact} aria-busy={workspaces.busy} inert={workspaces.busy} onFocusCapture={(event) => {
    if (!compact) {
      if (event.target.closest('.chat-panel')) setCompactPanel('chat')
      else if (event.target.closest('.sidebar')) setCompactPanel('tasks')
      else if (event.target.closest('.task-details-panel')) setCompactPanel('details')
    }
  }}>
    <header className="titlebar" aria-label="Workbench toolbar" data-chat-header={unifiedChatHeader}>
      <div className="app-brand"><span className="brand-mark"><img src={appIcon} alt="" width={24} height={24} /></span><span>Task Continuum</span></div>
      <div className="titlebar-chat" ref={setChatHeaderTarget} hidden={!unifiedChatHeader} />
      <button type="button" className="command-center" aria-label="Search tasks and jump back in" title="Search tasks (Ctrl+P)" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}><Icon name="search" /><span>Search tasks and jump back in</span><kbd>Ctrl P</kbd></button>
      <div className="titlebar-actions"><UpdateStatus updates={updates} onOpen={() => setDialog('updates')} />{workspaces.available && <IconButton icon="folder-opened" label="Switch workspace folder" disabled={workspaceLocked || workspaces.busy} onClick={openWorkspace} />}{!compact && <><IconButton icon="layout-sidebar-left" label="Toggle task sidebar" title="Toggle task sidebar (Ctrl+B)" aria-pressed={sidebarVisible} onClick={toggleSidebar} /><IconButton icon="comment-discussion" label="Toggle chat panel" title="Toggle chat panel (Ctrl+Alt+B)" aria-pressed={chatVisible} onClick={toggleChat} /><IconButton icon="layout-sidebar-right" label="Toggle task details" title="Toggle task details (Ctrl+Alt+D)" aria-pressed={detailsVisible} onClick={toggleDetails} /></>}</div>
      {window.desktop && <div className="window-controls"><IconButton icon={fullScreen ? 'screen-normal' : 'screen-full'} label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={`${fullScreen ? 'Exit' : 'Enter'} full screen (F11 / Shift+Alt+Enter)`} aria-pressed={fullScreen} onClick={() => windowAction('toggleFullScreen')} /><IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} /><IconButton icon="chrome-maximize" label="Maximize or restore window" disabled={fullScreen} onClick={() => windowAction('toggleMaximize')} /><IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} /></div>}
    </header>

    {compact && <nav className="compact-navigation" aria-label="Workspace panes">
      <button type="button" aria-label="Toggle task sidebar" aria-pressed={sidebarVisible} onClick={toggleSidebar}><Icon name={sidebarView === 'sessions' ? 'server-environment' : 'checklist'} />{sidebarView === 'sessions' ? 'Sessions' : 'Tasks'}</button>
      <button type="button" aria-label="Toggle chat panel" aria-pressed={chatVisible} onClick={toggleChat}><Icon name="comment-discussion" />Chat</button>
      <button type="button" aria-label="Toggle task details" aria-pressed={detailsVisible} onClick={toggleDetails}><Icon name="file-text" />Details</button>
    </nav>}

    {updateSafetyError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{updateSafetyError}</span></div>}
    {workspaces.error && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{workspaces.error}</span><IconButton icon="close" label="Dismiss workspace error" onClick={() => workspaces.setError(null)} /></div>}
    {selection.error && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{selection.error}</span><IconButton icon="close" label="Dismiss selection memory error" onClick={selection.dismissError} /></div>}
    {machineAliasesError && dialog !== 'remote-devices' && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{machineAliasesError}</span><IconButton icon="refresh" label="Reload workspace machine aliases" onClick={() => { void refreshMachineAliases() }} /></div>}
    {connectionError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{connectionError}</span>{links.error ? <IconButton icon="refresh" label="Reload session links" disabled={links.busy || sessionBusy} onClick={() => { setActionError(null); void links.reload() }} /> : <IconButton icon="close" label="Dismiss Agent Host error" onClick={() => setActionError(null)} />}</div>}
    <WorkbenchBody layout={layout}>
      <nav className="activity-bar" aria-label="Workbench navigation">
        <button type="button" className={sidebarVisible && sidebarView === 'tasks' ? 'activity active' : 'activity'} aria-label="Tasks" title="Tasks" aria-pressed={sidebarVisible && sidebarView === 'tasks'} onClick={openSidebar}><Icon name="checklist" /></button>
        <button type="button" className={sidebarVisible && sidebarView === 'sessions' ? 'activity active' : 'activity'} aria-label="Agent Host sessions" title="Native Agent Host sessions" aria-pressed={sidebarVisible && sidebarView === 'sessions'} onClick={openAgentHostSessions}><Icon name="server-environment" /></button>
        {workspace && window.remoteVSCode && <button type="button" className="activity" aria-label="Remote devices" title="Remote devices" onClick={() => setDialog('remote-devices')}><Icon name="remote" /></button>}
        <button type="button" className="activity" aria-label="Search tasks" title="Search tasks" onClick={() => { openSidebar(); requestAnimationFrame(() => document.getElementById('task-filter')?.focus()) }}><Icon name="search" /></button>
        <div className="activity-spacer" />
        <span className="avatar profile-avatar" title={userProfile.effectiveDisplayName ? `Local profile: ${userProfile.effectiveDisplayName}` : 'Local profile'}>{profileInitial}</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && (sidebarView === 'sessions' ? <AgentHostSessionsSidebar taskId={sidebarTask?.id} taskTitle={sidebarTask?.title}
        taskReady={Boolean(sidebarTask && links.ready)} bindings={bindings} orderedKeys={sidebarOrderedKeys} sessionLayout={sidebarSessionLayout}
        sortMode={sidebarSortMode} activeKey={sidebarActiveKey} popoutKeys={sidebarPopoutKeys}
        provisional={sidebarProvisional} awaitingSyncCount={sidebarAwaitingSyncCount}
        onSyncNow={window.remoteVSCode?.gitSync ? syncLinksNow : undefined}
        expandSession={expandSessionRequest?.active && expandSessionRequest.taskId === sidebarTask?.id ? expandSessionRequest : undefined}
        renameSession={renameSessionRequest && renameSessionRequest.taskId === sidebarTask?.id ? renameSessionRequest : undefined}
        localOwnerId={links.localOwner?.clientId} cachedTitles={sessionTitles.titles} sessionTimestamps={sessionTitles.timestamps} historyTransfers={historyTransfers}
        titleCacheError={sessionTitles.error} onTitles={sessionTitles.remember} busy={links.busy || syncingLinks}
        onSelect={sidebarTask ? (binding) => selectSession(sidebarTask.id, binding) : undefined}
        onSplit={sidebarTask ? (binding, direction = 'right') => splitFromSidebarSession(direction, sidebarTask.id, binding) : undefined}
        onPopOut={sidebarTask && window.desktop?.windows ? (binding) => {
          const panelKey = `${sidebarTask.id}:${sessionBindingKey(binding)}`
          if (popoutPanelKeys.has(panelKey)) focusPopOut(sidebarTask.id, binding)
          else void popOutTaskPage({ groupId: focusedGroup.id, taskId: sidebarTask.id, binding, mode: 'copy' })
        } : undefined}
        onSessionContextMenu={sidebarTask ? (binding, anchor) => {
          const key = sessionBindingKey(binding)
          setSidebarContextMenu({
            x: anchor.x,
            y: anchor.y,
            groupId: focusedGroup.id,
            taskId: sidebarTask.id,
            binding,
            detailsOpen: anchor.detailsOpen,
            toggleDetails: anchor.toggleDetails,
            unlink: anchor.unlink,
            beginRename: () => {
              selection.revealSessionGroup(sidebarTask.id, key)
              setRenameSessionRequest((current) => ({ taskId: sidebarTask.id, key, id: (current?.id ?? 0) + 1 }))
            },
          })
        } : undefined}
        onRenameSession={(binding, nextName) => sessionTitles.rename(binding.agentHost, nextName)}
        onLayoutChange={sidebarTask ? (next, makeManual) => selection.setSessionLayout(sidebarTask.id, next, makeManual, selectedId, openTasks) : undefined}
        onSortMode={sidebarTask ? (mode) => selection.setSessionSort(sidebarTask.id, mode, selectedId, openTasks) : undefined}
        onDetach={sidebarTask ? (binding) => detachSession(sidebarTask.id, binding) : undefined} onLink={linkAgentHost} onCreated={agentHostCreated}
        onDevices={() => setDialog('remote-devices')} onClose={toggleSidebar} /> : <TaskSidebar key={createdTaskId ?? 'initial'} tasks={tasks} selectedId={selectedId} query={query} onQuery={setQuery} onSelect={selectTask} onCreate={onCreateRepository} onCreateTask={openTaskCreation} creationDisabled={!workspaces.available || workspaceLocked || workspaces.busy} onClose={toggleSidebar} workspace={workspace ?? undefined} workspaceControls={workspaceControls} />)}
      {!compact && sidebarVisible && <WorkbenchSash layout={layout} panel="sidebar" onResize={(width) => changePanelWidth('sidebar', width)} onReset={() => changePanelWidth('sidebar', defaultLayout.sidebarWidth)} />}

      <Activity mode={compact && sidebarVisible ? 'hidden' : 'visible'}><main className="main-panel" aria-label="Task workspace" aria-keyshortcuts="Control+Shift+PageUp Control+Shift+PageDown">
        {(!chatVisible || taskAgentOpen) && (
          <div className="editor-tabs" role="tablist" aria-label="Open tasks" aria-keyshortcuts="Control+PageUp Control+PageDown">
            {openTasks.map((id, index) => {
              const item = tasks.find((value) => value.id === id)
              if (!item) return null
              return <div key={id} className={`editor-tab ${id === selectedId ? 'selected' : ''}`}>
                <button type="button" role="tab" title={item.title} aria-selected={id === selectedId} aria-controls="active-task" tabIndex={id === selectedId ? 0 : -1} onClick={() => selectTask(id)} onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault()
                    const next = (index + (event.key === 'ArrowRight' ? 1 : openTasks.length - 1)) % openTasks.length
                    selectTask(openTasks[next])
                    const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    buttons?.[next]?.focus()
                  }
                }}><Icon name={item.kind === 'epic' ? 'layers' : 'file-text'} /><span>{item.title}</span></button>
                <IconButton icon="close" label={`Close ${item.title}`} onClick={() => closeTask(id)} />
              </div>
            })}
          </div>
        )}
        <div id="active-task" className="active-task" data-chat-visible={chatVisible}>
          <Activity mode={chatVisible && !taskAgentOpen ? 'visible' : 'hidden'}>
            <PaneWorkspaceGrid
              tree={effectiveTree}
              onTreeChange={applyTreeChange}
              tasks={tasks}
              bindings={bindings}
              rememberedSessions={selection.sessions}
              orderedBindingsForTask={orderedBindingsForTask}
              awaitingSyncCountForTask={awaitingSyncCountForTask}
              gitSyncError={gitSyncStatus?.error}
              syncingLinks={syncingLinks}
              linksBusy={links.busy}
              linksReady={links.ready}
              workspaceAvailable={Boolean(workspace)}
              theme={layout.theme}
              compact={compact}
              isPopupWindow={false}
              unifiedHeaderTarget={unifiedChatHeader ? chatHeaderTarget : null}
              connectionRevision={agentHostRevision}
              cachedTitles={sessionTitles.titles}
              customTitles={sessionTitles.customTitles}
              restoredDrafts={restoredDrafts}
              onTitles={sessionTitles.remember}
              onRenameSession={sessionTitles.rename}
              onDraftSnapshot={handleDraftSnapshot}
              onBusyChange={reportPanelBusy}
              onPopOutTaskPage={popOutTaskPage}
              onBrowseSessions={() => openAgentHostSessions()}
              onOpenSessionDetach={openSessionDetach}
              onSyncNow={window.remoteVSCode?.gitSync ? () => { void syncLinksNow() } : undefined}
              onOpenDevices={workspace && window.remoteVSCode ? () => setDialog('remote-devices') : undefined}
              onCloseSingleChat={toggleChat}
              onTaskChatActivated={showTaskChat}
            />
          </Activity>
          {taskAgentOpen && workspace && chatVisible && (
            <LocalTaskAgent workspace={workspace} workspaces={workspaces} onCreated={taskCreated} onReviewDraft={() => setTaskCreationMode('draft')} onTaskChat={task ? showTaskChat : undefined} onClose={toggleChat} onBusy={setTaskAgentBusy} />
          )}
          {!compact && chatVisible && detailsVisible && <WorkbenchSash layout={layout} panel="details" onResize={(width) => changePanelWidth('details', width)} onReset={() => changePanelWidth('details', defaultLayout.detailsWidth)} />}
          <Activity mode={detailsVisible ? 'visible' : 'hidden'}><aside className="task-details-panel" aria-label="Task details">
            <header className="panel-header"><span>TASK DETAILS</span><IconButton icon="layout-sidebar-right-off" label="Hide task details" onClick={toggleDetails} /></header>
            <div className="task-details-content">
              {task ? <TaskViewer task={task} workspaceName={workspace?.name} onChat={showTaskChat} /> : <div className="empty-workbench workspace-empty">
                <Icon name={workspace ? 'folder-opened' : 'repo'} />
                <h1>{workspaces.busy ? 'Loading workspace...' : workspace ? !tasks.length ? 'No tasks in this workspace' : 'Make room for meaningful work.' : 'Create your task repository'}</h1>
                <p>{workspace ? workspace.name : 'A dedicated Git repository for your task files and configuration. Start empty, then publish to GitHub when you are ready.'}</p>
                {!workspace && <div className="workspace-welcome-actions"><button type="button" className="primary-button" disabled={!workspaces.available || workspaces.busy || workspaceLocked} onClick={onCreateRepository}><Icon name="repo-create" />Create task repository</button><button type="button" className="secondary-button" disabled={!workspaces.available || workspaces.busy || workspaceLocked} onClick={openWorkspace}><Icon name="folder-opened" />Open existing workspace</button></div>}
                {!workspace && !workspaces.available && <p className="muted">Open the desktop app to create a repository or open a local folder.</p>}
                {tasks.length > 0 && <button type="button" className="primary-button" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}>Open a task <kbd>Ctrl P</kbd></button>}
                {workspace && !tasks.length && <><p>Create your first task here, or let an agent create the files and refresh. No sample tasks are added automatically.</p><div className="workspace-welcome-actions"><button type="button" className="primary-button" disabled={!workspaces.available || workspaceLocked || workspaces.busy} onClick={() => openTaskCreation('form')}><Icon name="add" />Create task</button><button type="button" className="secondary-button" disabled={!workspaces.available || workspaceLocked || workspaces.busy} onClick={() => openTaskCreation('agent')}><Icon name="copilot" />Create with agent</button></div><button type="button" className="secondary-button" disabled={workspaceLocked} onClick={() => onPublishRepository(workspace)}><Icon name="github" />Publish repository to GitHub</button></>}
              </div>}
            </div>
          </aside></Activity>
        </div>
      </main></Activity>
    </WorkbenchBody>

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={taskAgentOpen || focusedBinding?.agentHost ? 'server-environment' : workspace ? 'folder' : 'repo'} />{taskAgentOpen ? 'TASK CREATION' : splitActive ? `SPLIT (${paneGroups.length})` : focusedBinding?.agentHost ? 'AGENT HOST' : workspace ? 'LOCAL WORKSPACE' : 'NO WORKSPACE'}</span><span><Icon name="checklist" />{tasks.length} tasks</span><span>{selectedId ?? 'No task selected'}</span>{popoutWindows.length > 0 && <span><Icon name="multiple-windows" />{popoutWindows.length} {popoutWindows.length === 1 ? 'window' : 'windows'}</span>}<span className="statusbar-spacer" /><span className="response-status" role="status" title={taskAgentOpen ? undefined : focusedBinding?.agentHost.owner.machineName}>{workspaces.busy ? 'Loading workspace...' : links.busy ? 'Saving or loading session links...' : sessionBusy ? 'Agent Host active' : taskAgentOpen ? 'Local task creation chat' : focusedBinding?.agentHost ? `Agent Host @ ${machineLabel(focusedBinding.agentHost.owner, aliases)}` : workspace ? 'Select an Agent Host chat' : 'Create or open a task repository'}</span><button type="button" onClick={taskAgentOpen ? showChat : openAgentHostSessions}><Icon name={taskAgentOpen ? 'comment-discussion' : focusedBinding?.agentHost ? 'link' : 'plug'} />{taskAgentOpen ? 'Task creation chat' : focusedBinding?.agentHost ? 'Agent Host linked' : 'No Agent Host linked'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    <UpdateNotice updates={updates} />
    {dialog === 'updates' && <Dialog title="About and updates" onClose={() => setDialog(null)}><UpdateSettings updates={updates} /></Dialog>}
    {taskCreationMode && workspace && <div data-update-blocker="Finish or close task creation before updating."><TaskCreationDialog workspace={workspace} workspaces={workspaces} initialMode={taskCreationMode} onCreated={taskCreated} onAgent={() => { setTaskCreationMode(null); setTaskAgentOpen(true); showChat() }} onClose={() => setTaskCreationMode(null)} /></div>}
    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Profile</h3><label className="form-field"><span>Display name</span><input type="text" aria-label="Display name" maxLength={USER_DISPLAY_NAME_MAX_LENGTH} placeholder={userProfile.displayName || userProfile.loginUsername || 'Your name'} value={userProfile.customDisplayName} onChange={(event) => userProfile.setCustomDisplayName(event.target.value)} /></label><p className="muted settings-field-hint">Shown on your messages instead of your raw OS login{userProfile.displayName && userProfile.displayName !== userProfile.loginUsername ? ` (auto-detected from Git: ${userProfile.displayName})` : ''}.</p></section><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); applyTreeChange(() => createInitialPaneTree(focusedGroup.openTaskIds, focusedGroup.activeTaskId, focusedGroup.sessions)); setCompactPanel(primaryPanel) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3><div className="integration-row"><span>Native Agent Host (AHP)</span><span className="integration-state">{window.agentHost ? 'Desktop API available' : 'Desktop API unavailable'}</span></div><div className="integration-row"><span>Remote devices and automatic workspace links</span><span className="integration-state">{window.remoteVSCode ? 'Desktop API available' : 'Desktop API unavailable'}</span></div></section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>New task</span><kbd>Ctrl / ⌘ N</kbd></div><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Previous task tab</span><kbd>Ctrl PgUp</kbd></div><div className="shortcut-row"><span>Next task tab</span><kbd>Ctrl PgDown</kbd></div><div className="shortcut-row"><span>Previous session in current task</span><kbd>Ctrl Shift PgUp</kbd></div><div className="shortcut-row"><span>Next session in current task</span><kbd>Ctrl Shift PgDown</kbd></div><div className="shortcut-row"><span>Split focused task page right</span><kbd>Ctrl / ⌘ \</kbd></div><div className="shortcut-row"><span>Split focused task page down</span><kbd>Ctrl / ⌘ K Ctrl / ⌘ \</kbd></div><div className="shortcut-row"><span>Copy task page into new window</span><kbd>Ctrl / ⌘ K O</kbd></div><div className="shortcut-row"><span>Close focused split pane</span><kbd>Ctrl / ⌘ Shift \</kbd></div><div className="shortcut-row"><span>Move session up or down</span><kbd>Alt ↑ / ↓</kbd></div><div className="shortcut-row"><span>Reconnect Agent Host and retry models</span><kbd>F5</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div><div className="shortcut-row"><span>Toggle task details</span><kbd>Ctrl / ⌘ Alt D</kbd></div></section><p className="dialog-hint">{workspace ? `Workspace: ${workspace.root}. Create new tasks in the Explorer; existing task views remain read-only. Session links: immutable Agent Host metadata.` : 'No workspace is selected. Create or open a task repository to get started; nothing is published automatically.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'remote-devices' && workspace && <RemoteDevicesDialog onClose={() => setDialog(null)} />}

    {sidebarContextMenu && <SessionContextMenu
      target={sidebarContextMenu}
      theme={layout.theme}
      splitActive={Boolean(sidebarParentSplit)}
      splitOrientation={sidebarParentSplit?.orientation ?? 'horizontal'}
      canSwap={Boolean(sidebarParentSplit)}
      allowOpenWindow={true}
      onRename={sidebarContextMenu.beginRename}
      onResetName={sidebarContextMenu.binding && sessionTitles.customTitles[agentHostKey(sidebarContextMenu.binding.agentHost)]
        ? () => sessionTitles.rename(sidebarContextMenu.binding!.agentHost, null)
        : undefined}
      onToggleDetails={sidebarContextMenu.toggleDetails}
      onUnlink={sidebarContextMenu.unlink}
      onSplit={(direction) => {
        if (sidebarContextMenu.binding) splitFromSidebarSession(direction, sidebarContextMenu.taskId, sidebarContextMenu.binding)
        else applyTreeChange((current) => splitPaneGroup(current, sidebarContextMenu.groupId, direction, { taskId: sidebarContextMenu.taskId }))
      }}
      onToggleOrientation={() => applyTreeChange((current) => toggleParentSplitOrientation(current, sidebarContextMenu.groupId))}
      onSwap={() => applyTreeChange((current) => swapParentSplitChildren(current, sidebarContextMenu.groupId))}
      onCloseSplit={() => applyTreeChange((current) => removePaneGroup(current, sidebarContextMenu.groupId))}
      onOpenWindow={(mode) => {
        void popOutTaskPage({
          groupId: sidebarContextMenu.groupId,
          taskId: sidebarContextMenu.taskId,
          binding: sidebarContextMenu.binding,
          mode,
        })
      }}
      onClose={() => setSidebarContextMenu(null)}
    />}

  </div></UserProfileContext.Provider>
}
