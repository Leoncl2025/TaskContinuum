import { Activity, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { DesktopInfo } from '../shared/desktop'
import { filterTasks } from '../shared/tasks'
import type { WorkspaceSnapshot } from '../shared/workspace'
import { useSessionLinks } from './chat/useSessionLinks'
import { sessionBindingKey } from './chat/sessionBindings'
import type { SessionBinding } from './chat/sessionBindings'
import { taskSessionLinks } from '../shared/sessionBindings'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { defaultLayout, isCompact, panelSizes, readLayout, resizePanel, saveLayout, subscribeCompact, subscribeViewport, viewportWidth } from './layout'
import type { LayoutPanel } from './layout'
import { PanelSash } from './components/PanelSash'
import { useWorkspaces } from './useWorkspaces'
import { WorkspacePicker } from './components/WorkspacePicker'
import { RepositorySetup } from './components/RepositorySetup'
import { TaskCreationDialog } from './components/TaskCreationDialog'
import { LocalTaskAgent } from './components/LocalTaskAgent'
import type { TaskCreationMode } from './components/TaskCreationDialog'
import { RemoteDevicesDialog } from './components/RemoteDevicesDialog'
import { AgentHostPanel } from './components/AgentHostPanel'
import { AgentHostSessionsSidebar } from './components/AgentHostSessionsSidebar'
import type { AgentHostSession } from '../shared/agentHost'
import { agentHostKey } from '../shared/agentHost'
import { useSessionTitles } from './chat/useSessionTitles'
import { machineLabel, useMachineAliases, useWorkspaceGitSync } from './machineAliases'
import { MachineAliasesProvider } from './MachineAliasesProvider'
import appIcon from '../../build/icon.png'

type DialogName = 'quick-open' | 'settings' | 'remote-devices' | null

export default function App() {
  const workspaces = useWorkspaces()
  const [repositorySetup, setRepositorySetup] = useState<'new' | WorkspaceSnapshot | null>(null)
  return <>
    <MachineAliasesProvider workspaceId={workspaces.state.current?.id ?? null}><Workbench key={workspaces.state.current?.id ?? 'empty'} workspaces={workspaces} repositorySetupOpen={repositorySetup !== null} onCreateRepository={() => setRepositorySetup('new')} onPublishRepository={setRepositorySetup} /></MachineAliasesProvider>
    {repositorySetup && <div className="repository-dialog-theme" data-theme={readLayout().theme}><RepositorySetup workspace={repositorySetup === 'new' ? null : repositorySetup} workspaces={workspaces} onClose={() => setRepositorySetup(null)} /></div>}
  </>
}

function Workbench({ workspaces, repositorySetupOpen, onCreateRepository, onPublishRepository }: {
  workspaces: ReturnType<typeof useWorkspaces>
  repositorySetupOpen: boolean
  onCreateRepository(): void
  onPublishRepository(workspace: WorkspaceSnapshot): void
}) {
  const workspace = workspaces.state.current
  const sessionTitles = useSessionTitles(workspace?.id)
  const aliases = useMachineAliases()
  const { error: machineAliasesError, refresh: refreshMachineAliases } = useWorkspaceGitSync()
  const [taskAgentOpen, setTaskAgentOpen] = useState(false)
  const links = useSessionLinks(!taskAgentOpen && workspace?.tasks.length ? workspace : null)
  const bindings = links.bindings
  const tasks = workspace?.tasks ?? []
  const [requestedId, setSelectedId] = useState<string | null>(() => workspace?.tasks[0]?.id ?? null)
  const selectedId = requestedId !== null && !tasks.some((item) => item.id === requestedId) ? tasks[0]?.id ?? null : requestedId
  const [tabIds, setOpenTasks] = useState(() => workspace?.tasks.slice(0, 1).map((item) => item.id) ?? [])
  const openTasks = [...new Set([...tabIds.filter((id) => tasks.some((item) => item.id === id)), ...(selectedId ? [selectedId] : [])])]
  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [sidebarView, setSidebarView] = useState<'tasks' | 'sessions'>('tasks')
  const [selectedSessions, setSelectedSessions] = useState<Record<string, string | null>>({})
  const [visitedSessions, setVisitedSessions] = useState<string[]>([])
  const [dialog, setDialog] = useState<DialogName>(null)
  const [taskCreationMode, setTaskCreationMode] = useState<'form' | 'draft' | null>(null)
  const [taskAgentBusy, setTaskAgentBusy] = useState(false)
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | 'details'>(() => workspace?.tasks.length ? 'chat' : 'details')
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const desktopWidth = useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
  const sizes = panelSizes(layout, desktopWidth)
  const task = tasks.find((item) => item.id === selectedId)
  const primaryPanel = task || taskAgentOpen ? 'chat' : 'details'
  const taskBindings = task ? bindings[task.id] ?? [] : []
  let activeKey = task ? selectedSessions[task.id] : undefined
  if (task && activeKey === undefined && taskBindings.length) {
    activeKey = sessionBindingKey(taskBindings[0])
    setSelectedSessions({ ...selectedSessions, [task.id]: activeKey })
  }
  const activeBinding = taskBindings.find((binding) => sessionBindingKey(binding) === activeKey)
  const agentHostBinding = activeBinding?.agentHost
  const activePanelKey = task && activeBinding ? `${task.id}:${sessionBindingKey(activeBinding)}` : undefined
  const panelKeys = new Set([...visitedSessions, ...activePanelKey ? [activePanelKey] : []])
  const chatPanels = tasks.flatMap((item) => (bindings[item.id] ?? []).flatMap((binding) => {
    const key = `${item.id}:${sessionBindingKey(binding)}`
    return panelKeys.has(key) ? [{ task: item, binding, key }] : []
  }))
  const [agentHostBusy, setAgentHostBusy] = useState(false)
  const [agentHostRevision, setAgentHostRevision] = useState(0)
  const creationLifetime = useRef({ active: false })
  const sessionViewLifetime = useRef({ active: false })
  const currentTaskId = useRef(selectedId)
  const sidebarVisible = compact ? compactPanel === 'tasks' : layout.sidebar
  const chatVisible = compact ? compactPanel === 'chat' : layout.chat
  const detailsVisible = compact ? compactPanel === 'details' : layout.details
  const sessionBusy = (Boolean(agentHostBinding) && agentHostBusy) || taskAgentBusy
  const workspaceLocked = repositorySetupOpen || taskCreationMode !== null || links.busy || sessionBusy || dialog === 'remote-devices'
  const connectionError = (taskAgentOpen ? null : links.error) ?? actionError

  useEffect(() => {
    const scope = { active: true }
    creationLifetime.current = scope
    return () => { scope.active = false }
  }, [])
  useEffect(() => { currentTaskId.current = selectedId }, [selectedId])
  useEffect(() => {
    const scope = { active: sidebarVisible && sidebarView === 'sessions' }
    sessionViewLifetime.current = scope
    return () => { scope.active = false }
  }, [sidebarVisible, sidebarView, selectedId])

  useEffect(() => { saveLayout(layout) }, [layout])
  useEffect(() => {
    let mounted = true
    void window.desktop?.getInfo().then((info) => { if (mounted) setDesktop(info) }).catch(() => { if (mounted) setDesktopError(true) })
    return () => { mounted = false }
  }, [])

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

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (dialog || taskCreationMode || repositorySetupOpen || event.isComposing) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'b' && !event.shiftKey) {
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
    currentTaskId.current = id
    setSelectedId(id)
    setOpenTasks((current) => current.includes(id) ? current : [...current, id])
    setCompactPanel('chat')
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
    const remaining = openTasks.filter((item) => item !== id)
    setOpenTasks(remaining)
    if (selectedId === id) setSelectedId(remaining.at(-1) ?? null)
  }

  function showChat(): void {
    setCompactPanel('chat')
    if (!compact) setLayout((value) => ({ ...value, chat: true }))
    requestAnimationFrame(() => document.getElementById('chat-composer')?.focus())
  }

  function showTaskChat(): void {
    setTaskAgentOpen(false)
    showChat()
  }

  function changePanelWidth(panel: LayoutPanel, width: number): void {
    setLayout((current) => resizePanel(current, panel, width, desktopWidth))
  }

  function openSidebar(): void {
    setSidebarView('tasks')
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => ({ ...value, sidebar: true }))
  }

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'close'): void {
    void window.desktop?.[action]().catch(() => setDesktopError(true))
  }

  function openAgentHostSessions(): void {
    if (!workspace) { setActionError('Open a task workspace before selecting an Agent Host session.'); return }
    if (!window.agentHost) { setActionError('The Agent Host desktop API is unavailable. Open this workspace in the desktop app.'); return }
    setActionError(null)
    setTaskAgentOpen(false)
    setSidebarView('sessions')
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => ({ ...value, sidebar: true }))
  }

  function rememberChat(): void {
    if (activePanelKey) setVisitedSessions((current) => current.includes(activePanelKey) ? current : [...current, activePanelKey])
  }

  function selectSession(taskId: string, binding: SessionBinding): void {
    rememberChat()
    setSelectedSessions((current) => ({ ...current, [taskId]: sessionBindingKey(binding) }))
    selectTask(taskId)
    showTaskChat()
  }

  async function linkAgentHost(session: AgentHostSession): Promise<void> {
    if (!workspace || !selectedId || !links.ready) throw new Error('Select a task and reload its workspace links before linking an Agent Host chat.')
    const taskId = selectedId
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
    if (!bindings[taskId]?.some((current) => sessionBindingKey(current) === key)) throw new Error('The task binding changed. Review the current Agent Host chat before detaching.')
    if (taskId === selectedId && key === activeKey && agentHostBusy) throw new Error('Wait for the current Agent Host operation to finish before detaching this session.')
    await links.detach(taskId, binding)
    if (!creationLifetime.current.active) return
    setSelectedSessions((current) => current[taskId] === key ? { ...current, [taskId]: null } : current)
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
    <header className="titlebar">
      <div className="app-brand"><span className="brand-mark"><img src={appIcon} alt="" width={24} height={24} /></span><span>Task Continuum</span></div>
      <button type="button" className="command-center" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}><Icon name="search" /><span>Search tasks and jump back in</span><kbd>Ctrl P</kbd></button>
      <div className="titlebar-actions">{workspaces.available && <IconButton icon="folder-opened" label="Switch workspace folder" disabled={workspaceLocked || workspaces.busy} onClick={openWorkspace} />}{!compact && <><IconButton icon="layout-sidebar-left" label="Toggle task sidebar" title="Toggle task sidebar (Ctrl+B)" aria-pressed={sidebarVisible} onClick={toggleSidebar} /><IconButton icon="comment-discussion" label="Toggle chat panel" title="Toggle chat panel (Ctrl+Alt+B)" aria-pressed={chatVisible} onClick={toggleChat} /><IconButton icon="layout-sidebar-right" label="Toggle task details" title="Toggle task details (Ctrl+Alt+D)" aria-pressed={detailsVisible} onClick={toggleDetails} /></>}</div>
      {window.desktop && <div className="window-controls"><IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} /><IconButton icon="chrome-maximize" label="Maximize or restore window" onClick={() => windowAction('toggleMaximize')} /><IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} /></div>}
    </header>

    {compact && <nav className="compact-navigation" aria-label="Workspace panes">
      <button type="button" aria-label="Toggle task sidebar" aria-pressed={sidebarVisible} onClick={toggleSidebar}><Icon name={sidebarView === 'sessions' ? 'server-environment' : 'checklist'} />{sidebarView === 'sessions' ? 'Sessions' : 'Tasks'}</button>
      <button type="button" aria-label="Toggle chat panel" aria-pressed={chatVisible} onClick={toggleChat}><Icon name="comment-discussion" />Chat</button>
      <button type="button" aria-label="Toggle task details" aria-pressed={detailsVisible} onClick={toggleDetails}><Icon name="file-text" />Details</button>
    </nav>}

    {workspaces.error && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{workspaces.error}</span><IconButton icon="close" label="Dismiss workspace error" onClick={() => workspaces.setError(null)} /></div>}
    {machineAliasesError && dialog !== 'remote-devices' && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{machineAliasesError}</span><IconButton icon="refresh" label="Reload workspace machine aliases" onClick={() => { void refreshMachineAliases() }} /></div>}
    {connectionError && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{connectionError}</span>{links.error ? <IconButton icon="refresh" label="Reload session links" disabled={links.busy || sessionBusy} onClick={() => { setActionError(null); void links.reload() }} /> : <IconButton icon="close" label="Dismiss Agent Host error" onClick={() => setActionError(null)} />}</div>}
    <div className="workbench-body" style={{ '--sidebar-width': `${sizes.sidebar.width}px`, '--details-width': `${sizes.details.width}px` } as CSSProperties}>
      <nav className="activity-bar" aria-label="Workbench navigation">
        <button type="button" className={sidebarVisible && sidebarView === 'tasks' ? 'activity active' : 'activity'} aria-label="Tasks" title="Tasks" aria-pressed={sidebarVisible && sidebarView === 'tasks'} onClick={openSidebar}><Icon name="checklist" /></button>
        <button type="button" className={sidebarVisible && sidebarView === 'sessions' ? 'activity active' : 'activity'} aria-label="Agent Host sessions" title="Native Agent Host sessions" aria-pressed={sidebarVisible && sidebarView === 'sessions'} onClick={openAgentHostSessions}><Icon name="server-environment" /></button>
        {workspace && window.remoteVSCode && <button type="button" className="activity" aria-label="Remote devices" title="Remote devices" onClick={() => setDialog('remote-devices')}><Icon name="remote" /></button>}
        <button type="button" className="activity" aria-label="Search tasks" title="Search tasks" onClick={() => { openSidebar(); requestAnimationFrame(() => document.getElementById('task-filter')?.focus()) }}><Icon name="search" /></button>
        <div className="activity-spacer" />
        <span className="avatar profile-avatar" title="Local profile">Y</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && (sidebarView === 'sessions' ? <AgentHostSessionsSidebar key={task?.id ?? 'no-task'} taskId={task?.id} taskTitle={task?.title} taskReady={Boolean(task && links.ready)} bindings={bindings} activeKey={activeBinding ? sessionBindingKey(activeBinding) : undefined} localOwnerId={links.localOwner?.clientId} cachedTitles={sessionTitles.titles} titleCacheError={sessionTitles.error} onTitles={sessionTitles.remember} busy={links.busy} onSelect={task ? (binding) => selectSession(task.id, binding) : undefined} onDetach={task ? (binding) => detachSession(task.id, binding) : undefined} onLink={linkAgentHost} onCreated={agentHostCreated} onDevices={() => setDialog('remote-devices')} onTasks={openSidebar} onClose={toggleSidebar} /> : <TaskSidebar key={createdTaskId ?? 'initial'} tasks={tasks} selectedId={selectedId} query={query} onQuery={setQuery} onSelect={selectTask} onCreate={onCreateRepository} onCreateTask={openTaskCreation} creationDisabled={!workspaces.available || workspaceLocked || workspaces.busy} onClose={toggleSidebar} workspace={workspace ?? undefined} workspaceControls={workspaceControls} />)}
      {!compact && sidebarVisible && <PanelSash panel="sidebar" {...sizes.sidebar} onResize={(width) => changePanelWidth('sidebar', width)} onReset={() => changePanelWidth('sidebar', defaultLayout.sidebarWidth)} />}

      <Activity mode={compact && sidebarVisible ? 'hidden' : 'visible'}><main className="main-panel" aria-label="Task workspace">
        <div className="editor-tabs" role="tablist" aria-label="Open tasks">
          {openTasks.map((id, index) => {
            const item = tasks.find((value) => value.id === id)!
            return <div key={id} className={`editor-tab ${id === selectedId ? 'selected' : ''}`}>
              <button type="button" role="tab" aria-selected={id === selectedId} aria-controls="active-task" tabIndex={id === selectedId ? 0 : -1} onClick={() => selectTask(id)} onKeyDown={(event) => {
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
            {chatPanels.map((panel) => <Activity key={panel.key} mode={!taskAgentOpen && panel.key === activePanelKey ? 'visible' : 'hidden'}><AgentHostPanel task={panel.task} target={panel.binding.agentHost} cachedTitle={sessionTitles.titles[agentHostKey(panel.binding.agentHost)]} onTitles={sessionTitles.remember} active={!taskAgentOpen && panel.key === activePanelKey} connectionRevision={agentHostRevision} onDetach={openAgentHostSessions} onClose={toggleChat} onDevices={window.remoteVSCode ? () => setDialog('remote-devices') : undefined} onSessions={openAgentHostSessions} onBusy={setAgentHostBusy} /></Activity>)}
            {taskAgentOpen && workspace && <LocalTaskAgent workspace={workspace} workspaces={workspaces} onCreated={taskCreated} onReviewDraft={() => setTaskCreationMode('draft')} onTaskChat={task ? showTaskChat : undefined} onClose={toggleChat} onBusy={setTaskAgentBusy} />}
            {!taskAgentOpen && !agentHostBinding && <aside className="chat-panel empty-chat" aria-label="Task chat">
              <header className="panel-header"><span>AGENT HOST</span><IconButton icon="close" label="Hide chat panel" onClick={toggleChat} /></header>
              <div className="chat-context"><Icon name="server-environment" /><div><strong>{task?.title ?? 'Native Agent Host chats'}</strong><span>{task?.id ?? 'No task selected'}</span></div></div>
              <div className="empty-workbench">
                <span className="chat-welcome-icon"><Icon name="comment-discussion" /></span>
                <h2>{task ? 'Keep the conversation moving' : 'Your task conversations, front and center'}</h2>
                <p>{!task ? 'Select a task to open its Agent Host chat.' : taskBindings.length ? `Choose a linked session for ${task.id} in the Agent Host sessions sidebar.` : `No Agent Host chat is linked to ${task.id}. Link an existing chat or create one from the Agent Host sessions sidebar.`}</p>
                <p className="muted">Local SDK and Companion sessions are not supported. Existing session data is left untouched.</p>
                {task && workspace && <button type="button" className="primary-button" disabled={links.busy} onClick={openAgentHostSessions}>Browse Agent Host sessions</button>}
              </div>
            </aside>}
          </Activity>
          {!compact && chatVisible && detailsVisible && <PanelSash panel="details" {...sizes.details} onResize={(width) => changePanelWidth('details', width)} onReset={() => changePanelWidth('details', defaultLayout.detailsWidth)} />}
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
    </div>

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={taskAgentOpen || agentHostBinding ? 'server-environment' : workspace ? 'folder' : 'repo'} />{taskAgentOpen ? 'TASK CREATION' : agentHostBinding ? 'AGENT HOST' : workspace ? 'LOCAL WORKSPACE' : 'NO WORKSPACE'}</span><span><Icon name="checklist" />{tasks.length} tasks</span><span>{selectedId ?? 'No task selected'}</span><span className="statusbar-spacer" /><span className="response-status" role="status" title={taskAgentOpen ? undefined : agentHostBinding?.owner.machineName}>{workspaces.busy ? 'Loading workspace...' : links.busy ? 'Saving or loading session links...' : sessionBusy ? 'Agent Host active' : taskAgentOpen ? 'Local task creation chat' : agentHostBinding ? `Agent Host @ ${machineLabel(agentHostBinding.owner, aliases)}` : workspace ? 'Select an Agent Host chat' : 'Create or open a task repository'}</span><button type="button" onClick={taskAgentOpen ? showChat : openAgentHostSessions}><Icon name={taskAgentOpen ? 'comment-discussion' : agentHostBinding ? 'link' : 'plug'} />{taskAgentOpen ? 'Task creation chat' : agentHostBinding ? 'Agent Host linked' : 'No Agent Host linked'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    {taskCreationMode && workspace && <TaskCreationDialog workspace={workspace} workspaces={workspaces} initialMode={taskCreationMode} onCreated={taskCreated} onAgent={() => { setTaskCreationMode(null); setTaskAgentOpen(true); showChat() }} onClose={() => setTaskCreationMode(null)} />}
    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); setCompactPanel(primaryPanel) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3><div className="integration-row"><span>Native Agent Host (AHP)</span><span className="integration-state">{window.agentHost ? 'Desktop API available' : 'Desktop API unavailable'}</span></div><div className="integration-row"><span>Remote devices and automatic workspace links</span><span className="integration-state">{window.remoteVSCode ? 'Desktop API available' : 'Desktop API unavailable'}</span></div></section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>New task</span><kbd>Ctrl / ⌘ N</kbd></div><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div><div className="shortcut-row"><span>Toggle task details</span><kbd>Ctrl / ⌘ Alt D</kbd></div></section><p className="dialog-hint">{workspace ? `Workspace: ${workspace.root}. Create new tasks in the Explorer; existing task views remain read-only. Session links: immutable Agent Host metadata.` : 'No workspace is selected. Create or open a task repository to get started; nothing is published automatically.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'remote-devices' && workspace && <RemoteDevicesDialog onClose={() => setDialog(null)} />}

  </div>
}
