import { Activity, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import type { DesktopInfo, DesktopWindowContext, SessionWindowSummary } from '../shared/desktop'
import { filterTasks } from '../shared/tasks'
import type { TaskRecord } from '../shared/tasks'
import type { WorkspaceSnapshot } from '../shared/workspace'
import { useSessionLinks } from './chat/useSessionLinks'
import { useWorkbenchSelection } from './chat/useWorkbenchSelection'
import { sessionBindingKey, sessionBindingTitle } from './chat/sessionBindings'
import type { SessionBinding } from './chat/sessionBindings'
import { buildSessionTree, treeSessionBindings } from './chat/sessionGroups'
import { taskSessionLinks } from '../shared/sessionBindings'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { defaultLayout, isCompact, panelSizes, readLayout, resizePanel, saveLayout, subscribeCompact, subscribeViewport, viewportWidth } from './layout'
import type { LayoutPanel, LayoutPreferences } from './layout'
import { ChatSplitSash, PanelSash } from './components/PanelSash'
import { SESSION_BINDING_DRAG_MIME } from './components/LinkedSessionTree'
import { useWorkspaces } from './useWorkspaces'
import { WorkspacePicker } from './components/WorkspacePicker'
import { RepositorySetup } from './components/RepositorySetup'
import { TaskCreationDialog } from './components/TaskCreationDialog'
import { LocalTaskAgent } from './components/LocalTaskAgent'
import type { TaskCreationMode } from './components/TaskCreationDialog'
import { RemoteDevicesDialog } from './components/RemoteDevicesDialog'
import { AgentHostPanel } from './components/AgentHostPanel'
import { AgentHostSessionsSidebar } from './components/AgentHostSessionsSidebar'
import type { AgentHostHistoryTransfer, AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import { agentHostKey } from '../shared/agentHost'
import { useSessionTitles } from './chat/useSessionTitles'
import { machineLabel, useMachineAliases, useWorkspaceGitSync } from './machineAliases'
import { MachineAliasesProvider } from './MachineAliasesProvider'
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

function PoppedOutSessionPane({ slot, focused, task, binding, title, ownerDisplay, alternatives, onActivate, onFocusWindow, onDockHere, onSelectAlternative, onClose, closeLabel }: {
  slot: 'single' | 'primary' | 'secondary'
  focused: boolean
  task: TaskRecord
  binding: SessionBinding
  title: string
  ownerDisplay: string
  alternatives: readonly { binding: SessionBinding; label: string }[]
  onActivate?(): void
  onFocusWindow(): void
  onDockHere(): void
  onSelectAlternative(binding: SessionBinding): void
  onClose(): void
  closeLabel: string
}) {
  return <aside className="chat-panel empty-chat popped-out-chat" data-pane-slot={slot} data-pane-focused={slot !== 'single' ? focused || undefined : undefined} aria-label={slot === 'secondary' ? 'Secondary split task chat' : 'Task chat'} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="ahp-chat-header popped-out-header">
      <div className="ahp-chat-title"><Icon name="multiple-windows" /><span className="ahp-chat-task-badge">{task.id}</span><strong title={title}>{title}</strong></div>
      <div className="ahp-chat-meta"><span className="ahp-chat-machine" title={binding.owner.machineName}><Icon name="server" /><span>Copilot @ {ownerDisplay}</span></span></div>
      <div className="ahp-chat-actions"><IconButton icon="close" label={closeLabel} onClick={onClose} /></div>
    </header>
    <div className="empty-workbench">
      <span className="chat-welcome-icon"><Icon name="multiple-windows" /></span>
      <h2>Open in separate window</h2>
      <p role="status"><strong>{title}</strong> ({task.id}) is active in its own window so you can arrange conversations across displays without duplicate drafts.</p>
      <div className="workspace-welcome-actions">
        <button type="button" className="primary-button" onClick={onFocusWindow}><Icon name="link-external" /><span>Focus window</span></button>
        <button type="button" className="secondary-button" onClick={onDockHere}><Icon name="layout-panel-dock" /><span>Dock back here</span></button>
      </div>
      {alternatives.length > 0 && <div className="split-picker-candidates" aria-label="Other sessions in this task">
        <span className="split-picker-heading">Switch this pane to another session</span>
        <div className="split-picker-list">
          {alternatives.slice(0, 4).map(({ binding: candidate, label }) => <button key={sessionBindingKey(candidate)} type="button" className="secondary-button split-picker-chip" onClick={() => onSelectAlternative(candidate)}>
            <Icon name="copilot" /><span>{label}</span>
          </button>)}
        </div>
      </div>}
    </div>
  </aside>
}

function SplitSessionPickerPane({ slot, focused, task, candidates, onActivate, onPick, onBrowseSessions, onClose }: {
  slot: 'single' | 'primary' | 'secondary'
  focused: boolean
  task: TaskRecord | undefined
  candidates: readonly { task: TaskRecord; binding: SessionBinding; label: string; machine: string }[]
  onActivate(): void
  onPick(taskId: string, binding: SessionBinding): void
  onBrowseSessions(): void
  onClose(): void
}) {
  return <aside className="chat-panel empty-chat split-picker-chat" data-pane-slot={slot} data-pane-focused={slot !== 'single' ? focused || undefined : undefined} aria-label="Split session picker" onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="ahp-chat-header popped-out-header">
      <div className="ahp-chat-title"><Icon name="split-horizontal" /><strong>Split chat view</strong></div>
      <div className="ahp-chat-meta"><span>{task ? `${task.id} · ${task.title}` : 'Select a session'}</span></div>
      <div className="ahp-chat-actions"><IconButton icon="close" label="Close split pane" onClick={onClose} /></div>
    </header>
    <div className="empty-workbench">
      <span className="chat-welcome-icon"><Icon name="split-horizontal" /></span>
      <h2>Choose a session for the right pane</h2>
      <p>{candidates.length ? 'Pick another linked conversation to compare or run side by side, or drag any session from the sidebar here.' : task ? `Link or create another Agent Host session for ${task.id} to view two conversations side by side.` : 'Select a task and link a session to open it in split view.'}</p>
      {candidates.length > 0 && <div className="split-picker-candidates" aria-label="Available sessions for split view">
        <div className="split-picker-list">
          {candidates.slice(0, 6).map((item) => <button key={`${item.task.id}:${sessionBindingKey(item.binding)}`} type="button" className="secondary-button split-picker-chip" onClick={() => onPick(item.task.id, item.binding)}>
            <Icon name="copilot" />
            <span>{item.label}</span>
            <small>{item.task.id} · {item.machine}</small>
          </button>)}
        </div>
      </div>}
      <div className="workspace-welcome-actions">
        <button type="button" className="primary-button" onClick={onBrowseSessions}><Icon name="server-environment" /><span>Link or create session</span></button>
        <button type="button" className="secondary-button" onClick={onClose}><span>Close split</span></button>
      </div>
    </div>
  </aside>
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
  const requestedId = selection.taskId === undefined ? tasks[0]?.id ?? null : selection.taskId
  const selectedId = requestedId !== null && !tasks.some((item) => item.id === requestedId) ? tasks[0]?.id ?? null : requestedId
  const openTasks = useMemo(() => {
    const tabIds = selection.openTaskIds ?? (selectedId ? [selectedId] : [])
    return [...new Set([...tabIds.filter((id) => tasks.some((item) => item.id === id)), ...(selectedId ? [selectedId] : [])])]
  }, [selection.openTaskIds, selectedId, tasks])
  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [sidebarView, setSidebarView] = useState<'tasks' | 'sessions'>('tasks')
  const [expandSessionRequest, setExpandSessionRequest] = useState<{ taskId: string; key: string; id: number; active: boolean }>()
  const selectedSessions = selection.sessions
  const [visitedSessions, setVisitedSessions] = useState<string[]>([])
  const [splitPane, setSplitPane] = useState<{ taskId: string; sessionKey?: string } | null>(null)
  const [focusedSlot, setFocusedSlot] = useState<'primary' | 'secondary'>('primary')
  const [popoutWindows, setPopoutWindows] = useState<SessionWindowSummary[]>([])
  const [restoredDrafts, setRestoredDrafts] = useState<Record<string, { nonce: number; text: string }>>({})
  const [chatDropZone, setChatDropZone] = useState<'primary' | 'secondary'>()
  const [busyPanels, setBusyPanels] = useState<Record<string, boolean>>({})
  const [dialog, setDialog] = useState<DialogName>(null)
  const [chatHeaderTarget, setChatHeaderTarget] = useState<HTMLDivElement | null>(null)
  const [taskCreationMode, setTaskCreationMode] = useState<'form' | 'draft' | null>(null)
  const [taskAgentBusy, setTaskAgentBusy] = useState(false)
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | 'details'>(() => workspace?.tasks.length ? 'chat' : 'details')
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [fullScreen, setFullScreen] = useState(false)
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const task = tasks.find((item) => item.id === selectedId)
  const primaryPanel = task || taskAgentOpen ? 'chat' : 'details'
  const activeSortMode = selection.taskSortMode(task?.id)
  const activeOrderedKeys = task ? selection.sessionOrders[task.id] : undefined
  const activeSessionLayout = task ? selection.sessionGroups[task.id] : undefined
  const taskBindings = useMemo(() => {
    if (!task) return []
    return treeSessionBindings(buildSessionTree(bindings[task.id] ?? [], {
      mode: activeSortMode,
      orderedKeys: activeOrderedKeys,
      titles: sessionTitles.titles,
      timestamps: sessionTitles.timestamps,
      aliases,
    }, activeSessionLayout).entries)
  }, [task, bindings, activeSortMode, activeOrderedKeys, sessionTitles.titles, sessionTitles.timestamps, aliases, activeSessionLayout])
  const activeKey = task ? Object.hasOwn(selectedSessions, task.id) ? selectedSessions[task.id]
    : taskBindings[0] ? sessionBindingKey(taskBindings[0]) : undefined : undefined
  const activeBinding = taskBindings.find((binding) => sessionBindingKey(binding) === activeKey)
  const taskAwaitingSyncCount = task ? (gitSyncStatus?.awaitingSync ?? []).filter((marker) => marker.taskId === task.id).length : 0
  const missingSelectedSession = links.ready && !taskAwaitingSyncCount && typeof activeKey === 'string' && !activeBinding
  const agentHostBinding = activeBinding?.agentHost
  const activePanelKey = task && activeBinding ? `${task.id}:${sessionBindingKey(activeBinding)}` : undefined
  const popoutPanelKeys = useMemo(() => new Set(popoutWindows.map((item) => item.key)), [popoutWindows])
  const splitActive = Boolean(splitPane && !taskAgentOpen)
  const secondaryTask = splitActive && splitPane ? tasks.find((item) => item.id === splitPane.taskId) ?? task : undefined
  const rawSecondaryBinding = secondaryTask && splitPane?.sessionKey
    ? (bindings[secondaryTask.id] ?? []).find((item) => sessionBindingKey(item) === splitPane.sessionKey)
    : undefined
  const rawSecondaryPanelKey = secondaryTask && rawSecondaryBinding ? `${secondaryTask.id}:${sessionBindingKey(rawSecondaryBinding)}` : undefined
  const secondaryBinding = rawSecondaryPanelKey && rawSecondaryPanelKey !== activePanelKey ? rawSecondaryBinding : undefined
  const secondaryPanelKey = secondaryTask && secondaryBinding ? `${secondaryTask.id}:${sessionBindingKey(secondaryBinding)}` : undefined
  const effectiveFocusedSlot: 'primary' | 'secondary' = splitActive ? focusedSlot : 'primary'
  const splitLayoutActive = splitActive && !compact
  const primaryPoppedOut = Boolean(activePanelKey && popoutPanelKeys.has(activePanelKey))
  const secondaryPoppedOut = Boolean(secondaryPanelKey && popoutPanelKeys.has(secondaryPanelKey))
  const sidebarTask = effectiveFocusedSlot === 'secondary' && secondaryTask ? secondaryTask : task
  const sidebarSortMode = selection.taskSortMode(sidebarTask?.id)
  const sidebarOrderedKeys = sidebarTask ? selection.sessionOrders[sidebarTask.id] : undefined
  const sidebarSessionLayout = sidebarTask ? selection.sessionGroups[sidebarTask.id] : undefined
  const sidebarTaskBindings = useMemo(() => {
    if (!sidebarTask) return []
    return treeSessionBindings(buildSessionTree(bindings[sidebarTask.id] ?? [], {
      mode: sidebarSortMode,
      orderedKeys: sidebarOrderedKeys,
      titles: sessionTitles.titles,
      timestamps: sessionTitles.timestamps,
      aliases,
    }, sidebarSessionLayout).entries)
  }, [sidebarTask, bindings, sidebarSortMode, sidebarOrderedKeys, sessionTitles.titles, sessionTitles.timestamps, aliases, sidebarSessionLayout])
  const sidebarActiveKey = effectiveFocusedSlot === 'secondary'
    ? secondaryBinding && secondaryTask?.id === sidebarTask?.id ? sessionBindingKey(secondaryBinding) : undefined
    : activeBinding && task?.id === sidebarTask?.id ? sessionBindingKey(activeBinding) : undefined
  const sidebarSecondaryKey = splitActive
    ? effectiveFocusedSlot === 'secondary'
      ? activeBinding && task?.id === sidebarTask?.id ? sessionBindingKey(activeBinding) : undefined
      : secondaryBinding && secondaryTask?.id === sidebarTask?.id ? sessionBindingKey(secondaryBinding) : undefined
    : undefined
  const sidebarPopoutKeys = useMemo(() => {
    if (!sidebarTask) return undefined
    const keys = new Set<string>()
    for (const item of popoutWindows) {
      if (item.taskId === sidebarTask.id) keys.add(`ahp:${agentHostKey(item.target)}`)
    }
    return keys
  }, [sidebarTask, popoutWindows])
  const sidebarAwaitingSyncCount = sidebarTask ? (gitSyncStatus?.awaitingSync ?? []).filter((marker) => marker.taskId === sidebarTask.id).length : 0
  const sidebarProvisional = Boolean(sidebarTask && gitSyncStatus?.provisionalTasks.includes(sidebarTask.id))
  const panelKeys = new Set([
    ...visitedSessions,
    ...(activePanelKey ? [activePanelKey] : []),
    ...(secondaryPanelKey ? [secondaryPanelKey] : []),
  ])
  const chatPanels = tasks.flatMap((item) => (bindings[item.id] ?? []).flatMap((binding) => {
    const key = `${item.id}:${sessionBindingKey(binding)}`
    return panelKeys.has(key) ? [{ task: item, binding, key }] : []
  }))
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
  const agentHostBusy = Boolean(
    (activePanelKey && !primaryPoppedOut && busyPanels[activePanelKey])
    || (secondaryPanelKey && !secondaryPoppedOut && busyPanels[secondaryPanelKey]),
  )
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
  const unifiedChatHeader = chatVisible && !taskAgentOpen && !splitActive && Boolean(activePanelKey) && !primaryPoppedOut
  const focusedBinding = effectiveFocusedSlot === 'secondary' ? secondaryBinding ?? activeBinding : activeBinding
  const sessionBusy = ((Boolean(agentHostBinding) || Boolean(secondaryBinding)) && agentHostBusy) || taskAgentBusy
  const workspaceLocked = repositorySetupOpen || taskCreationMode !== null || links.busy || sessionBusy || dialog === 'remote-devices'
  const connectionError = (taskAgentOpen ? null : links.error) ?? actionError

  useEffect(() => {
    const scope = { active: true }
    creationLifetime.current = scope
    return () => { scope.active = false }
  }, [])
  useEffect(() => { currentTaskId.current = selectedId }, [selectedId])
  useEffect(() => { currentSessionKey.current = activeKey }, [activeKey])
  const rememberDefaultSession = selection.rememberDefaultSession
  useEffect(() => {
    if (task && activeBinding && links.ready) rememberDefaultSession(task.id, sessionBindingKey(activeBinding))
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

  const activateDockedSession = useEffectEvent((event: { taskId: string; target: AgentHostTarget; draft?: string }) => {
    if (!tasks.some((item) => item.id === event.taskId)) return
    const key = `ahp:${agentHostKey(event.target)}`
    const panelKey = `${event.taskId}:${key}`
    if (event.draft) {
      setRestoredDrafts((current) => ({
        ...current,
        [panelKey]: { nonce: (current[panelKey]?.nonce ?? 0) + 1, text: event.draft! },
      }))
    }
    if (splitPane && secondaryPanelKey === panelKey) {
      setFocusedSlot('secondary')
      showTaskChat()
      return
    }
    setFocusedSlot('primary')
    currentTaskId.current = event.taskId
    currentSessionKey.current = key
    selection.selectSession(event.taskId, key, openTasks)
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
    document.querySelectorAll<HTMLButtonElement>('.editor-tabs [role="tab"]')[next]?.focus()
  })

  const switchSessionFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    const targetTask = sidebarTask
    if (event.defaultPrevented || workspaces.busy || taskAgentOpen || !targetTask
      || !links.ready || !sidebarTaskBindings.length || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (sidebarTaskBindings.length === 1) return
    const currentKey = effectiveFocusedSlot === 'secondary'
      ? secondaryBinding && secondaryTask?.id === targetTask.id ? sessionBindingKey(secondaryBinding) : undefined
      : currentTaskId.current === targetTask.id ? currentSessionKey.current : undefined
    const index = sidebarTaskBindings.findIndex((binding) => sessionBindingKey(binding) === currentKey)
    const step = event.key === 'PageDown' ? 1 : sidebarTaskBindings.length - 1
    let next = index < 0 ? event.key === 'PageDown' ? 0 : sidebarTaskBindings.length - 1
      : (index + step) % sidebarTaskBindings.length
    if (splitActive && sidebarSecondaryKey && sidebarTaskBindings.length > 1 && sessionBindingKey(sidebarTaskBindings[next]) === sidebarSecondaryKey) {
      next = (next + step) % sidebarTaskBindings.length
    }
    selectSession(targetTask.id, sidebarTaskBindings[next])
  })

  const handleSplitShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || workspaces.busy || taskAgentOpen || !task || document.querySelector('dialog[open]')) return
    event.preventDefault()
    if (event.shiftKey) {
      if (splitPane) closeSplitSlot('secondary')
      return
    }
    if (!splitPane) {
      openSplitRight()
      return
    }
    setFocusedSlot((current) => current === 'primary' ? 'secondary' : 'primary')
    showTaskChat()
  })

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (dialog || taskCreationMode || repositorySetupOpen || event.isComposing) return
      const key = event.key.toLowerCase()
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
    rememberChat()
    setFocusedSlot('primary')
    currentTaskId.current = id
    selection.selectTask(id, openTasks)
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
    rememberChat()
    selection.closeTask(id, openTasks, selectedId)
  }

  function showChat(): void {
    setCompactPanel('chat')
    if (!compact) setLayout((value) => ({ ...value, chat: true }))
    const previousFocus = document.activeElement
    requestAnimationFrame(() => {
      const composer = document.getElementById('chat-composer')
      const focused = document.activeElement
      if (document.querySelector('dialog[open]') || focused !== previousFocus && focused !== document.body && focused !== composer) return
      composer?.focus({ preventScroll: true })
    })
  }

  function showTaskChat(): void {
    setTaskAgentOpen(false)
    showChat()
  }

  function changePanelWidth(panel: LayoutPanel, width: number): void {
    const desktopWidth = viewportWidth()
    setLayout((current) => resizePanel(current, panel, width, desktopWidth))
  }

  function openSidebar(): void {
    setSidebarView('tasks')
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => ({ ...value, sidebar: true }))
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
    else setLayout((value) => ({ ...value, sidebar: true }))
  }

  function openSessionDetach(taskId: string, binding: SessionBinding): void {
    openAgentHostSessions()
    if (!workspace || !window.agentHost) return
    const key = sessionBindingKey(binding)
    selection.revealSessionGroup(taskId, key)
    setExpandSessionRequest((current) => ({ taskId, key, id: (current?.id ?? 0) + 1, active: true }))
  }

  function rememberChat(): void {
    const toRemember = [activePanelKey, secondaryPanelKey].filter((item): item is string => Boolean(item))
    if (!toRemember.length) return
    setVisitedSessions((current) => {
      const missing = toRemember.filter((item) => !current.includes(item))
      return missing.length ? [...current, ...missing] : current
    })
  }

  function selectPrimarySession(taskId: string, binding: SessionBinding): void {
    rememberChat()
    const key = sessionBindingKey(binding)
    currentTaskId.current = taskId
    currentSessionKey.current = key
    selection.selectSession(taskId, key, openTasks)
    setFocusedSlot('primary')
    showTaskChat()
  }

  function selectSession(taskId: string, binding: SessionBinding): void {
    const key = sessionBindingKey(binding)
    const targetPanelKey = `${taskId}:${key}`
    if (splitActive) {
      if (effectiveFocusedSlot === 'secondary') {
        if (targetPanelKey === activePanelKey) {
          if (secondaryTask && secondaryBinding) swapSplitPanes()
          else setFocusedSlot('primary')
        } else {
          rememberChat()
          setSplitPane({ taskId, sessionKey: key })
          setFocusedSlot('secondary')
        }
        showTaskChat()
        return
      }
      if (targetPanelKey === secondaryPanelKey) {
        if (task && activeBinding) swapSplitPanes()
        else setFocusedSlot('secondary')
        showTaskChat()
        return
      }
    }
    selectPrimarySession(taskId, binding)
  }

  const splitCandidates = useMemo(() => {
    const result: { task: TaskRecord; binding: SessionBinding; label: string; machine: string }[] = []
    const seen = new Set<string>()
    const candidateTasks = [
      ...(task ? [task] : []),
      ...openTasks.map((id) => tasks.find((item) => item.id === id)).filter((item): item is TaskRecord => Boolean(item && item.id !== task?.id)),
    ]
    for (const candidateTask of candidateTasks) {
      const members = candidateTask.id === task?.id ? taskBindings : (bindings[candidateTask.id] ?? [])
      for (const member of members) {
        const panelKey = `${candidateTask.id}:${sessionBindingKey(member)}`
        if (panelKey === activePanelKey || seen.has(panelKey) || popoutPanelKeys.has(panelKey)) continue
        seen.add(panelKey)
        result.push({
          task: candidateTask,
          binding: member,
          label: sessionBindingTitle(member, sessionTitles.titles),
          machine: machineLabel(member.owner, aliases),
        })
      }
    }
    return result
  }, [task, openTasks, tasks, taskBindings, bindings, activePanelKey, popoutPanelKeys, sessionTitles.titles, aliases])

  function openSplitRight(targetTaskId?: string, binding?: SessionBinding): void {
    setActionError(null)
    if (targetTaskId && binding) {
      const key = sessionBindingKey(binding)
      const targetPanelKey = `${targetTaskId}:${key}`
      if (!activeBinding) {
        selectPrimarySession(targetTaskId, binding)
        return
      }
      rememberChat()
      if (targetPanelKey === activePanelKey) {
        const fallback = splitCandidates[0]
        setSplitPane(fallback ? { taskId: fallback.task.id, sessionKey: sessionBindingKey(fallback.binding) } : { taskId: targetTaskId })
      } else {
        setSplitPane({ taskId: targetTaskId, sessionKey: key })
      }
      setFocusedSlot('secondary')
      showTaskChat()
      return
    }
    if (!task) return
    rememberChat()
    const candidate = splitCandidates[0]
    setSplitPane(candidate ? { taskId: candidate.task.id, sessionKey: sessionBindingKey(candidate.binding) } : { taskId: task.id })
    setFocusedSlot('secondary')
    showTaskChat()
  }

  function swapSplitPanes(): void {
    if (!task || !activeBinding || !secondaryTask || !secondaryBinding) return
    rememberChat()
    const priorPrimaryTask = task.id
    const priorPrimaryKey = sessionBindingKey(activeBinding)
    const nextPrimaryKey = sessionBindingKey(secondaryBinding)
    currentTaskId.current = secondaryTask.id
    currentSessionKey.current = nextPrimaryKey
    selection.selectSession(secondaryTask.id, nextPrimaryKey, openTasks)
    setSplitPane({ taskId: priorPrimaryTask, sessionKey: priorPrimaryKey })
    showTaskChat()
  }

  function closeSplitSlot(slot: 'primary' | 'secondary'): void {
    rememberChat()
    if (slot === 'primary' && secondaryTask && secondaryBinding) {
      const promotedKey = sessionBindingKey(secondaryBinding)
      currentTaskId.current = secondaryTask.id
      currentSessionKey.current = promotedKey
      selection.selectSession(secondaryTask.id, promotedKey, openTasks)
    }
    setSplitPane(null)
    setFocusedSlot('primary')
  }

  async function popOutSession(taskId: string, binding: SessionBinding, draft?: string): Promise<boolean> {
    const windowsBridge = window.desktop?.windows
    if (!windowsBridge) {
      setActionError('Opening a separate session window requires the desktop app.')
      return false
    }
    setActionError(null)
    try {
      const key = sessionBindingKey(binding)
      const targetPanelKey = `${taskId}:${key}`
      const trimmedDraft = draft?.trim() ? draft : undefined
      const result = await windowsBridge.open({ taskId, target: binding.agentHost, ...(trimmedDraft ? { draft: trimmedDraft } : {}) })
      if (!result.opened) return false
      if (splitActive) {
        if (targetPanelKey === secondaryPanelKey) {
          setSplitPane(null)
          setFocusedSlot('primary')
        } else if (targetPanelKey === activePanelKey && secondaryTask && secondaryBinding) {
          const promotedKey = sessionBindingKey(secondaryBinding)
          currentTaskId.current = secondaryTask.id
          currentSessionKey.current = promotedKey
          selection.selectSession(secondaryTask.id, promotedKey, openTasks)
          setSplitPane(null)
          setFocusedSlot('primary')
        }
      }
      return true
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'The session window could not be opened.')
      return false
    }
  }

  function focusPopOut(taskId: string, binding: SessionBinding): void {
    setActionError(null)
    void window.desktop?.windows?.focus({ taskId, target: binding.agentHost }).catch((failure: unknown) => {
      setActionError(failure instanceof Error ? failure.message : 'The session window could not be focused.')
    })
  }

  function dockPopOut(taskId: string, binding: SessionBinding): void {
    setActionError(null)
    void window.desktop?.windows?.dock({ taskId, target: binding.agentHost }).catch((failure: unknown) => {
      setActionError(failure instanceof Error ? failure.message : 'The session window could not be docked.')
    })
  }

  function onChatDragOver(event: DragEvent<HTMLDivElement>): void {
    if (taskAgentOpen || !event.dataTransfer.types.includes(SESSION_BINDING_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const zone: 'primary' | 'secondary' = !activeBinding || event.clientX < bounds.left + bounds.width * 0.5 ? 'primary' : 'secondary'
    setChatDropZone((current) => current === zone ? current : zone)
  }

  function onChatDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom) return
    setChatDropZone(undefined)
  }

  function onChatDrop(event: DragEvent<HTMLDivElement>): void {
    const zone = chatDropZone
    setChatDropZone(undefined)
    if (taskAgentOpen || !event.dataTransfer.types.includes(SESSION_BINDING_DRAG_MIME)) return
    event.preventDefault()
    try {
      const payload = JSON.parse(event.dataTransfer.getData(SESSION_BINDING_DRAG_MIME)) as { taskId?: string; key?: string }
      if (!payload.taskId || !payload.key) return
      const droppedBinding = (bindings[payload.taskId] ?? []).find((item) => sessionBindingKey(item) === payload.key)
      if (!droppedBinding) return
      if (zone === 'secondary' && activeBinding) {
        openSplitRight(payload.taskId, droppedBinding)
      } else {
        selectPrimarySession(payload.taskId, droppedBinding)
      }
    } catch {
      // Ignore malformed drag payloads.
    }
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
    if (sessionView.active && (currentTaskId.current === taskId || (splitActive && effectiveFocusedSlot === 'secondary'))) selectSession(taskId, binding)
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
    if (sessionView.active && (currentTaskId.current === taskId || (splitActive && effectiveFocusedSlot === 'secondary'))) selectSession(taskId, { id: session.sessionId, title: session.title, owner: session.owner, agentHost: linked })
  }

  async function detachSession(taskId: string, binding: SessionBinding): Promise<void> {
    setActionError(null)
    const key = sessionBindingKey(binding)
    const panelKey = `${taskId}:${key}`
    if (!bindings[taskId]?.some((current) => sessionBindingKey(current) === key)) throw new Error('The task binding changed. Review the current Agent Host chat before detaching.')
    if (busyPanels[panelKey]) throw new Error('Wait for the current Agent Host operation to finish before detaching this session.')
    if (popoutPanelKeys.has(panelKey)) await window.desktop?.windows?.dock({ taskId, target: binding.agentHost }).catch(() => undefined)
    await links.detach(taskId, binding)
    if (!creationLifetime.current.active) return
    setSplitPane((current) => current?.taskId === taskId && current.sessionKey === key ? { taskId } : current)
    selection.clearSession(taskId, key, selectedSessions[taskId] === key || taskId === selectedId && key === activeKey)
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

  return <div className="workbench" data-theme={layout.theme} data-compact={compact} aria-busy={workspaces.busy} inert={workspaces.busy} onFocusCapture={(event) => {
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
        <span className="avatar profile-avatar" title="Local profile">Y</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && (sidebarView === 'sessions' ? <AgentHostSessionsSidebar key={sidebarTask?.id ?? 'no-task'} taskId={sidebarTask?.id} taskTitle={sidebarTask?.title}
        taskReady={Boolean(sidebarTask && links.ready)} bindings={bindings} orderedKeys={sidebarOrderedKeys} sessionLayout={sidebarSessionLayout}
        sortMode={sidebarSortMode} activeKey={sidebarActiveKey} secondaryKey={sidebarSecondaryKey} popoutKeys={sidebarPopoutKeys}
        provisional={sidebarProvisional} awaitingSyncCount={sidebarAwaitingSyncCount}
        onSyncNow={window.remoteVSCode?.gitSync ? syncLinksNow : undefined}
        expandSession={expandSessionRequest?.active && expandSessionRequest.taskId === sidebarTask?.id ? expandSessionRequest : undefined}
        localOwnerId={links.localOwner?.clientId} cachedTitles={sessionTitles.titles} sessionTimestamps={sessionTitles.timestamps} historyTransfers={historyTransfers}
        titleCacheError={sessionTitles.error} onTitles={sessionTitles.remember} busy={links.busy || syncingLinks}
        onSelect={sidebarTask ? (binding) => selectSession(sidebarTask.id, binding) : undefined}
        onSplit={sidebarTask ? (binding) => openSplitRight(sidebarTask.id, binding) : undefined}
        onPopOut={sidebarTask && window.desktop?.windows ? (binding) => {
          const panelKey = `${sidebarTask.id}:${sessionBindingKey(binding)}`
          if (popoutPanelKeys.has(panelKey)) focusPopOut(sidebarTask.id, binding)
          else void popOutSession(sidebarTask.id, binding)
        } : undefined}
        onLayoutChange={sidebarTask ? (next, makeManual) => selection.setSessionLayout(sidebarTask.id, next, makeManual, selectedId, openTasks) : undefined}
        onSortMode={sidebarTask ? (mode) => selection.setSessionSort(sidebarTask.id, mode, selectedId, openTasks) : undefined}
        onDetach={sidebarTask ? (binding) => detachSession(sidebarTask.id, binding) : undefined} onLink={linkAgentHost} onCreated={agentHostCreated}
        onDevices={() => setDialog('remote-devices')} onClose={toggleSidebar} /> : <TaskSidebar key={createdTaskId ?? 'initial'} tasks={tasks} selectedId={selectedId} query={query} onQuery={setQuery} onSelect={selectTask} onCreate={onCreateRepository} onCreateTask={openTaskCreation} creationDisabled={!workspaces.available || workspaceLocked || workspaces.busy} onClose={toggleSidebar} workspace={workspace ?? undefined} workspaceControls={workspaceControls} />)}
      {!compact && sidebarVisible && <WorkbenchSash layout={layout} panel="sidebar" onResize={(width) => changePanelWidth('sidebar', width)} onReset={() => changePanelWidth('sidebar', defaultLayout.sidebarWidth)} />}

      <Activity mode={compact && sidebarVisible ? 'hidden' : 'visible'}><main className="main-panel" aria-label="Task workspace" aria-keyshortcuts="Control+Shift+PageUp Control+Shift+PageDown">
        <div className="editor-tabs" role="tablist" aria-label="Open tasks" aria-keyshortcuts="Control+PageUp Control+PageDown">
          {openTasks.map((id, index) => {
            const item = tasks.find((value) => value.id === id)!
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
        <div id="active-task" className="active-task" data-chat-visible={chatVisible}>
          <Activity mode={chatVisible ? 'visible' : 'hidden'}>
            <div className="chat-workspace" data-split={splitLayoutActive || undefined}
              style={splitLayoutActive ? { '--split-left-grow': layout.splitRatio, '--split-right-grow': 1 - layout.splitRatio } as CSSProperties : undefined}
              onDragOver={onChatDragOver} onDragLeave={onChatDragLeave} onDrop={onChatDrop}>
              {compact && splitActive && !taskAgentOpen && <div className="compact-split-switcher" role="tablist" aria-label="Split chat panes">
                <button type="button" role="tab" aria-selected={effectiveFocusedSlot === 'primary'} onClick={() => setFocusedSlot('primary')}>
                  <Icon name="layout-panel-left" /><span>{activeBinding ? sessionBindingTitle(activeBinding, sessionTitles.titles) : 'Left pane'}</span>
                </button>
                <button type="button" role="tab" aria-selected={effectiveFocusedSlot === 'secondary'} onClick={() => setFocusedSlot('secondary')}>
                  <Icon name="layout-panel-right" /><span>{secondaryBinding ? sessionBindingTitle(secondaryBinding, sessionTitles.titles) : 'Right pane'}</span>
                </button>
                <IconButton icon="close" label="Close split pane" onClick={() => closeSplitSlot('secondary')} />
              </div>}
              {chatPanels.map((panel) => {
                const isPrimary = !taskAgentOpen && panel.key === activePanelKey && !primaryPoppedOut
                const isSecondary = !taskAgentOpen && splitActive && panel.key === secondaryPanelKey && !secondaryPoppedOut
                const visible = compact && splitActive
                  ? effectiveFocusedSlot === 'secondary' ? isSecondary : isPrimary
                  : isPrimary || isSecondary
                const slot: 'single' | 'primary' | 'secondary' = !splitLayoutActive ? 'single' : isSecondary ? 'secondary' : 'primary'
                const slotFocused = isSecondary ? effectiveFocusedSlot === 'secondary' : effectiveFocusedSlot === 'primary'
                return <Activity key={panel.key} mode={visible ? 'visible' : 'hidden'}>
                  <AgentHostPanel
                    task={panel.task}
                    target={panel.binding.agentHost}
                    paneSlot={slot}
                    showTaskBadge={splitActive && Boolean(secondaryTask && task && secondaryTask.id !== task.id)}
                    closeLabel={splitActive ? 'Close split pane' : 'Hide chat panel'}
                    restoredDraft={restoredDrafts[panel.key]}
                    headerTarget={unifiedChatHeader && isPrimary ? chatHeaderTarget : undefined}
                    cachedTitle={sessionTitles.titles[agentHostKey(panel.binding.agentHost)]}
                    onTitles={sessionTitles.remember}
                    active={visible && (!splitActive || slotFocused)}
                    connectionRevision={agentHostRevision}
                    onActivatePane={splitActive ? () => setFocusedSlot(isSecondary ? 'secondary' : 'primary') : undefined}
                    onSplitRight={!splitActive ? () => openSplitRight() : undefined}
                    onSwapSplit={splitActive && activeBinding && secondaryBinding ? swapSplitPanes : undefined}
                    onPopOut={window.desktop?.windows ? (draft) => popOutSession(panel.task.id, panel.binding, draft) : undefined}
                    onDetach={() => openSessionDetach(panel.task.id, panel.binding)}
                    onClose={() => { if (splitActive) closeSplitSlot(isSecondary ? 'secondary' : 'primary'); else toggleChat() }}
                    onDevices={window.remoteVSCode ? () => setDialog('remote-devices') : undefined}
                    onSessions={() => { if (splitActive) setFocusedSlot(isSecondary ? 'secondary' : 'primary'); openAgentHostSessions() }}
                    panelKey={panel.key}
                    onBusy={reportPanelBusy}
                  />
                </Activity>
              })}
              {splitLayoutActive && <ChatSplitSash ratio={layout.splitRatio} onResize={(ratio) => setLayout((current) => ({ ...current, splitRatio: ratio }))} onReset={() => setLayout((current) => ({ ...current, splitRatio: defaultLayout.splitRatio }))} />}
              {!taskAgentOpen && task && activeBinding && primaryPoppedOut && (!compact || !splitActive || effectiveFocusedSlot === 'primary') && <PoppedOutSessionPane
                slot={splitLayoutActive ? 'primary' : 'single'}
                focused={effectiveFocusedSlot === 'primary'}
                task={task}
                binding={activeBinding}
                title={sessionTitles.titles[agentHostKey(activeBinding.agentHost)] || (activeBinding.title !== 'Agent Host' ? activeBinding.title : 'Original Host chat')}
                ownerDisplay={machineLabel(activeBinding.owner, aliases)}
                alternatives={taskBindings.filter((item) => !popoutPanelKeys.has(`${task.id}:${sessionBindingKey(item)}`) && `${task.id}:${sessionBindingKey(item)}` !== secondaryPanelKey).map((item) => ({ binding: item, label: sessionBindingTitle(item, sessionTitles.titles) }))}
                onActivate={splitActive ? () => setFocusedSlot('primary') : undefined}
                onFocusWindow={() => focusPopOut(task.id, activeBinding)}
                onDockHere={() => dockPopOut(task.id, activeBinding)}
                onSelectAlternative={(candidate) => selectPrimarySession(task.id, candidate)}
                onClose={() => { if (splitActive) closeSplitSlot('primary'); else toggleChat() }}
                closeLabel={splitActive ? 'Close split pane' : 'Hide chat panel'}
              />}
              {!taskAgentOpen && splitActive && secondaryTask && secondaryBinding && secondaryPoppedOut && (!compact || effectiveFocusedSlot === 'secondary') && <PoppedOutSessionPane
                slot={splitLayoutActive ? 'secondary' : 'single'}
                focused={effectiveFocusedSlot === 'secondary'}
                task={secondaryTask}
                binding={secondaryBinding}
                title={sessionTitles.titles[agentHostKey(secondaryBinding.agentHost)] || (secondaryBinding.title !== 'Agent Host' ? secondaryBinding.title : 'Original Host chat')}
                ownerDisplay={machineLabel(secondaryBinding.owner, aliases)}
                alternatives={(bindings[secondaryTask.id] ?? []).filter((item) => !popoutPanelKeys.has(`${secondaryTask.id}:${sessionBindingKey(item)}`) && `${secondaryTask.id}:${sessionBindingKey(item)}` !== activePanelKey).map((item) => ({ binding: item, label: sessionBindingTitle(item, sessionTitles.titles) }))}
                onActivate={() => setFocusedSlot('secondary')}
                onFocusWindow={() => focusPopOut(secondaryTask.id, secondaryBinding)}
                onDockHere={() => dockPopOut(secondaryTask.id, secondaryBinding)}
                onSelectAlternative={(candidate) => setSplitPane({ taskId: secondaryTask.id, sessionKey: sessionBindingKey(candidate) })}
                onClose={() => closeSplitSlot('secondary')}
                closeLabel="Close split pane"
              />}
              {!taskAgentOpen && splitActive && !secondaryBinding && (!compact || effectiveFocusedSlot === 'secondary') && <SplitSessionPickerPane
                slot={splitLayoutActive ? 'secondary' : 'single'}
                focused={effectiveFocusedSlot === 'secondary'}
                task={secondaryTask}
                candidates={splitCandidates}
                onActivate={() => setFocusedSlot('secondary')}
                onPick={(pickedTaskId, pickedBinding) => {
                  rememberChat()
                  setSplitPane({ taskId: pickedTaskId, sessionKey: sessionBindingKey(pickedBinding) })
                  setFocusedSlot('secondary')
                  showTaskChat()
                }}
                onBrowseSessions={() => { setFocusedSlot('secondary'); openAgentHostSessions() }}
                onClose={() => closeSplitSlot('secondary')}
              />}
              {taskAgentOpen && workspace && <LocalTaskAgent workspace={workspace} workspaces={workspaces} onCreated={taskCreated} onReviewDraft={() => setTaskCreationMode('draft')} onTaskChat={task ? showTaskChat : undefined} onClose={toggleChat} onBusy={setTaskAgentBusy} />}
              {!taskAgentOpen && !agentHostBinding && (!compact || !splitActive || effectiveFocusedSlot === 'primary') && <aside className="chat-panel empty-chat" data-pane-slot={splitLayoutActive ? 'primary' : undefined} aria-label="Task chat" onPointerDownCapture={splitActive ? () => setFocusedSlot('primary') : undefined}>
                <header className="panel-header"><span>AGENT HOST</span><IconButton icon="close" label={splitActive ? 'Close split pane' : 'Hide chat panel'} onClick={() => { if (splitActive) closeSplitSlot('primary'); else toggleChat() }} /></header>
                <div className="chat-context"><Icon name="server-environment" /><div><strong>{task?.title ?? 'Native Agent Host chats'}</strong><span>{task?.id ?? 'No task selected'}</span></div></div>
                <div className="empty-workbench">
                  <span className="chat-welcome-icon"><Icon name={task && taskAwaitingSyncCount > 0 ? 'sync' : 'comment-discussion'} /></span>
                  {task && taskAwaitingSyncCount > 0 ? <>
                    <h2>Session links waiting for Git sync</h2>
                    <p role="status">{taskBindings.length
                      ? `A remote session binding change for ${task.id} is waiting for the publishing device to finish Git synchronization. ${taskBindings.length} confirmed ${taskBindings.length === 1 ? 'session remains' : 'sessions remain'} available in the Agent Host sessions sidebar.`
                      : `A remote session binding change for ${task.id} is waiting for the publishing device to finish Git synchronization. Existing links were not deleted; inspect or cancel pending changes in Remote devices if the publishing device is unavailable.`}</p>
                    {gitSyncStatus?.error && <p className="copilot-error" role="alert">{gitSyncStatus.error}</p>}
                    <div className="workspace-welcome-actions">
                      {window.remoteVSCode?.gitSync && <button type="button" className="secondary-button" disabled={links.busy || syncingLinks} onClick={() => { void syncLinksNow() }}><Icon name="sync" /><span>{syncingLinks ? 'Syncing...' : 'Sync now'}</span></button>}
                      {workspace && window.remoteVSCode && <button type="button" className="secondary-button" onClick={() => setDialog('remote-devices')}><Icon name="remote" /><span>Remote devices</span></button>}
                      {workspace && <button type="button" className="primary-button" disabled={links.busy} onClick={openAgentHostSessions}>Browse Agent Host sessions</button>}
                    </div>
                  </> : <>
                    <h2>{task ? 'Keep the conversation moving' : 'Your task conversations, front and center'}</h2>
                    <p>{!task ? 'Select a task to open its Agent Host chat.' : taskBindings.length ? `Choose a linked session for ${task.id} in the Agent Host sessions sidebar.` : `No Agent Host chat is linked to ${task.id}. Link an existing chat or create one from the Agent Host sessions sidebar.`}</p>
                    {missingSelectedSession && <p role="status">The last selected session is no longer linked to this task. Choose a current session; no replacement was opened.</p>}
                    <p className="muted">Local SDK and Companion sessions are not supported. Existing session data is left untouched.</p>
                    {task && workspace && <button type="button" className="primary-button" disabled={links.busy} onClick={openAgentHostSessions}>Browse Agent Host sessions</button>}
                  </>}
                </div>
              </aside>}
              {chatDropZone && <div className="chat-drop-overlay" data-zone={chatDropZone} aria-hidden="true">
                <div className="chat-drop-badge">
                  <Icon name={chatDropZone === 'secondary' ? 'split-horizontal' : 'comment-discussion'} />
                  <span>{chatDropZone === 'secondary' ? 'Split right' : 'Open here'}</span>
                </div>
              </div>}
            </div>
          </Activity>
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

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={taskAgentOpen || focusedBinding?.agentHost ? 'server-environment' : workspace ? 'folder' : 'repo'} />{taskAgentOpen ? 'TASK CREATION' : splitActive ? 'SPLIT CHAT' : focusedBinding?.agentHost ? 'AGENT HOST' : workspace ? 'LOCAL WORKSPACE' : 'NO WORKSPACE'}</span><span><Icon name="checklist" />{tasks.length} tasks</span><span>{selectedId ?? 'No task selected'}</span>{popoutWindows.length > 0 && <span><Icon name="multiple-windows" />{popoutWindows.length} {popoutWindows.length === 1 ? 'window' : 'windows'}</span>}<span className="statusbar-spacer" /><span className="response-status" role="status" title={taskAgentOpen ? undefined : focusedBinding?.agentHost.owner.machineName}>{workspaces.busy ? 'Loading workspace...' : links.busy ? 'Saving or loading session links...' : sessionBusy ? 'Agent Host active' : taskAgentOpen ? 'Local task creation chat' : focusedBinding?.agentHost ? `Agent Host @ ${machineLabel(focusedBinding.agentHost.owner, aliases)}` : workspace ? 'Select an Agent Host chat' : 'Create or open a task repository'}</span><button type="button" onClick={taskAgentOpen ? showChat : openAgentHostSessions}><Icon name={taskAgentOpen ? 'comment-discussion' : focusedBinding?.agentHost ? 'link' : 'plug'} />{taskAgentOpen ? 'Task creation chat' : focusedBinding?.agentHost ? 'Agent Host linked' : 'No Agent Host linked'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    <UpdateNotice updates={updates} />
    {dialog === 'updates' && <Dialog title="About and updates" onClose={() => setDialog(null)}><UpdateSettings updates={updates} /></Dialog>}
    {taskCreationMode && workspace && <div data-update-blocker="Finish or close task creation before updating."><TaskCreationDialog workspace={workspace} workspaces={workspaces} initialMode={taskCreationMode} onCreated={taskCreated} onAgent={() => { setTaskCreationMode(null); setTaskAgentOpen(true); showChat() }} onClose={() => setTaskCreationMode(null)} /></div>}
    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); setSplitPane(null); setFocusedSlot('primary'); setCompactPanel(primaryPanel) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3><div className="integration-row"><span>Native Agent Host (AHP)</span><span className="integration-state">{window.agentHost ? 'Desktop API available' : 'Desktop API unavailable'}</span></div><div className="integration-row"><span>Remote devices and automatic workspace links</span><span className="integration-state">{window.remoteVSCode ? 'Desktop API available' : 'Desktop API unavailable'}</span></div></section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>New task</span><kbd>Ctrl / ⌘ N</kbd></div><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Previous task tab</span><kbd>Ctrl PgUp</kbd></div><div className="shortcut-row"><span>Next task tab</span><kbd>Ctrl PgDown</kbd></div><div className="shortcut-row"><span>Previous session in current task</span><kbd>Ctrl Shift PgUp</kbd></div><div className="shortcut-row"><span>Next session in current task</span><kbd>Ctrl Shift PgDown</kbd></div><div className="shortcut-row"><span>Split chat right or switch split focus</span><kbd>Ctrl / ⌘ \</kbd></div><div className="shortcut-row"><span>Close split chat pane</span><kbd>Ctrl / ⌘ Shift \</kbd></div><div className="shortcut-row"><span>Move session up or down</span><kbd>Alt ↑ / ↓</kbd></div><div className="shortcut-row"><span>Reconnect Agent Host and retry models</span><kbd>F5</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div><div className="shortcut-row"><span>Toggle task details</span><kbd>Ctrl / ⌘ Alt D</kbd></div></section><p className="dialog-hint">{workspace ? `Workspace: ${workspace.root}. Create new tasks in the Explorer; existing task views remain read-only. Session links: immutable Agent Host metadata.` : 'No workspace is selected. Create or open a task repository to get started; nothing is published automatically.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'remote-devices' && workspace && <RemoteDevicesDialog onClose={() => setDialog(null)} />}

  </div>
}
