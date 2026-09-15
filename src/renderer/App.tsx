import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { DesktopInfo } from '../shared/desktop'
import { filterTasks } from '../shared/tasks'
import type { TaskRecord, TaskStatus } from '../shared/tasks'
import { useSessionLinks } from './chat/useSessionLinks'
import { sessionBindingKey } from './chat/sessionBindings'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { demoTasks } from './data/tasks'
import { defaultLayout, isCompact, panelSizes, readLayout, resizePanel, saveLayout, subscribeCompact, subscribeViewport, viewportWidth } from './layout'
import type { LayoutPanel } from './layout'
import { PanelSash } from './components/PanelSash'
import { useWorkspaces } from './useWorkspaces'
import { WorkspacePicker } from './components/WorkspacePicker'
import { RemoteDevicesDialog } from './components/RemoteDevicesDialog'
import { AgentHostPanel } from './components/AgentHostPanel'
import { AgentHostSessionsDialog } from './components/AgentHostSessionsDialog'
import type { AgentHostSession } from '../shared/agentHost'
import { agentHostKey } from '../shared/agentHost'

type DialogName = 'quick-open' | 'settings' | 'new-task' | 'clear-chat' | 'remote-devices' | 'agent-host-sessions' | null

interface CreatedChatCompletion {
  taskId: string
  session: AgentHostSession
  picker: { active: boolean }
  resolve(): void
  reject(error: Error): void
}

export default function App() {
  const workspaces = useWorkspaces()
  return <Workbench key={workspaces.state.current?.id ?? 'demo'} workspaces={workspaces} />
}

function Workbench({ workspaces }: { workspaces: ReturnType<typeof useWorkspaces> }) {
  const workspace = workspaces.state.current
  const links = useSessionLinks(workspace)
  const bindings = links.bindings
  const [demoRecords, setTasks] = useState<TaskRecord[]>(() => structuredClone(demoTasks))
  const tasks = workspace?.tasks ?? demoRecords
  const [requestedId, setSelectedId] = useState<string | null>(() => workspace ? workspace.tasks[0]?.id ?? null : 'T-0002')
  const selectedId = requestedId !== null && !tasks.some((item) => item.id === requestedId) ? tasks[0]?.id ?? null : requestedId
  const [tabIds, setOpenTasks] = useState(() => workspace ? workspace.tasks.slice(0, 1).map((item) => item.id) : ['T-0001', 'T-0002'])
  const openTasks = [...new Set([...tabIds.filter((id) => tasks.some((item) => item.id === id)), ...(selectedId ? [selectedId] : [])])]
  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | null>(null)
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [desktopError, setDesktopError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [detachTarget, setDetachTarget] = useState<{ taskId: string; key: string } | null>(null)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const desktopWidth = useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
  const sizes = panelSizes(layout, desktopWidth)
  const task = tasks.find((item) => item.id === selectedId)
  const agentHostBinding = task ? bindings[task.id]?.agentHost : undefined
  const [agentHostBusy, setAgentHostBusy] = useState(false)
  const [createdChat, setCreatedChat] = useState<CreatedChatCompletion | null>(null)
  const creationCompletion = useRef<CreatedChatCompletion | null>(null)
  const creationLifetime = useRef({ active: false })
  const creationPicker = useRef<{ active: boolean } | null>(null)
  const sidebarVisible = compact ? compactPanel === 'tasks' : layout.sidebar
  const chatVisible = compact ? compactPanel === 'chat' : layout.chat
  const sessionBusy = Boolean(agentHostBinding) && agentHostBusy
  const workspaceLocked = links.busy || sessionBusy || dialog === 'remote-devices' || dialog === 'agent-host-sessions' || dialog === 'clear-chat'
  const connectionError = links.error ?? actionError
  const detachBinding = detachTarget ? bindings[detachTarget.taskId]?.agentHost : undefined
  const detachmentChanged = Boolean(detachTarget && (!detachBinding || agentHostKey(detachBinding) !== detachTarget.key))

  useEffect(() => {
    const scope = { active: true }
    creationLifetime.current = scope
    return () => {
      scope.active = false
      creationCompletion.current?.reject(new Error('The original workspace was closed. Reopen it to recover the saved chat.'))
      creationCompletion.current = null
    }
  }, [])
  useEffect(() => {
    if (dialog !== 'agent-host-sessions') return
    const picker = { active: true }
    creationPicker.current = picker
    return () => {
      picker.active = false
      if (creationPicker.current === picker) creationPicker.current = null
      if (creationCompletion.current?.picker === picker) {
        creationCompletion.current.reject(new Error('The picker was closed. Reopen it to recover the saved chat.'))
        creationCompletion.current = null
      }
    }
  }, [dialog])
  const finishCreatedChat = useEffectEvent((completion: CreatedChatCompletion) => {
    if (creationCompletion.current !== completion) return
    creationCompletion.current = null
    if (!completion.picker.active || dialog !== 'agent-host-sessions') { completion.reject(new Error('The picker was closed. Reopen it to recover the saved chat.')); return }
    if (!tasks.some((item) => item.id === completion.taskId)) { completion.reject(new Error(`The original task ${completion.taskId} is no longer in this workspace.`)); return }
    const linked = bindings[completion.taskId]?.agentHost
    if (!links.ready || !linked) { completion.reject(new Error(links.error ?? `Reload the saved Agent Host binding for ${completion.taskId} before opening its chat.`)); return }
    if (agentHostKey(linked) !== agentHostKey(completion.session)) { completion.reject(new Error('The task binding no longer matches the created chat. No replacement chat was selected.')); return }
    selectTask(completion.taskId)
    showChat()
    setDialog(null)
    completion.resolve()
  })
  useEffect(() => {
    if (!createdChat || links.busy) return
    let active = true
    void Promise.resolve().then(() => { if (active) finishCreatedChat(createdChat) })
    return () => { active = false }
  }, [createdChat, links.busy])

  useEffect(() => { saveLayout(layout) }, [layout])
  useEffect(() => {
    let mounted = true
    void window.desktop?.getInfo().then((info) => { if (mounted) setDesktop(info) }).catch(() => { if (mounted) setDesktopError(true) })
    return () => { mounted = false }
  }, [])

  const toggleSidebar = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'tasks' ? null : 'tasks')
    else setLayout((value) => ({ ...value, sidebar: !value.sidebar }))
  }, [compact])
  const toggleChat = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'chat' ? null : 'chat')
    else setLayout((value) => ({ ...value, chat: !value.chat }))
  }, [compact])

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (dialog || event.isComposing) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'b' && !event.shiftKey) {
        event.preventDefault()
        if (event.altKey) toggleChat()
        else toggleSidebar()
      } else if ((event.ctrlKey || event.metaKey) && key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault(); setQuickQuery(''); setDialog('quick-open')
      } else if (event.key === 'Escape' && compact) setCompactPanel(null)
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [compact, dialog, toggleChat, toggleSidebar])

  function selectTask(id: string): void {
    setSelectedId(id)
    setOpenTasks((current) => current.includes(id) ? current : [...current, id])
    if (compact) setCompactPanel(null)
  }

  function closeTask(id: string): void {
    const remaining = openTasks.filter((item) => item !== id)
    setOpenTasks(remaining)
    if (selectedId === id) setSelectedId(remaining.at(-1) ?? null)
  }

  function showChat(): void {
    if (compact) setCompactPanel('chat')
    else setLayout((value) => ({ ...value, chat: true }))
    requestAnimationFrame(() => document.getElementById('chat-composer')?.focus())
  }

  function changePanelWidth(panel: LayoutPanel, width: number): void {
    setLayout((current) => resizePanel(current, panel, width, desktopWidth))
  }

  function changeTask(update: (current: TaskRecord) => TaskRecord): void {
    if (workspace) return
    setTasks((current) => current.map((item) => item.id === selectedId ? update(item) : item))
  }

  function openSidebar(): void {
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
    setDialog('agent-host-sessions')
  }

  async function linkAgentHost(session: AgentHostSession): Promise<void> {
    if (!workspace || !selectedId || !links.ready) throw new Error('Select a task and reload its workspace links before linking an Agent Host chat.')
    const binding = { id: session.sessionId, title: session.title, owner: session.owner, agentHost: { hostId: session.hostId, sessionId: session.sessionId, chatId: session.chatId, owner: session.owner } }
    const existing = Object.entries(bindings).find(([, current]) => sessionBindingKey(current) === sessionBindingKey(binding))?.[0]
    if (existing) {
      if (!tasks.some((item) => item.id === existing)) throw new Error(`The Agent Host conversation belongs to unavailable task ${existing}.`)
      selectTask(existing)
    } else {
      if (bindings[selectedId]) throw new Error('Detach the current conversation before linking a different Host chat.')
      await links.attach(selectedId, binding)
    }
    setActionError(null)
    setDialog(null)
    showChat()
  }

  async function agentHostCreated(taskId: string, session: AgentHostSession): Promise<void> {
    const scope = creationLifetime.current
    const picker = creationPicker.current
    if (!scope.active || !picker?.active || !workspace || !tasks.some((item) => item.id === taskId)) throw new Error(`The original task ${taskId} is unavailable in this workspace.`)
    await links.reload()
    if (!scope.active) throw new Error('The original workspace was closed. Reopen it to recover the saved chat.')
    if (!picker.active) throw new Error('The picker was closed. Reopen it to recover the saved chat.')
    await new Promise<void>((resolve, reject) => {
      if (creationCompletion.current) { reject(new Error('Another created chat is still opening.')); return }
      const completion = { taskId, session, picker, resolve, reject }
      creationCompletion.current = completion
      setCreatedChat(completion)
    })
  }

  async function detachSession(taskId: string): Promise<void> {
    setActionError(null)
    const current = bindings[taskId]?.agentHost
    if (!detachTarget || detachTarget.taskId !== taskId || !current || agentHostKey(current) !== detachTarget.key) {
      setActionError('The task binding changed. Review the current Agent Host chat before detaching.')
      return
    }
    try {
      await links.detach(taskId)
      setDialog(null)
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'The Agent Host binding could not be removed.')
    }
  }

  function openWorkspace(): void {
    if (!workspaceLocked) { setActionError(null); void workspaces.openFolder() }
  }

  function selectWorkspace(id: string): void {
    if (workspaceLocked) return
    if (id === 'demo') void workspaces.useDemo()
    else void workspaces.openRecent(id)
  }

  const workspaceControls = workspaces.available ? <WorkspacePicker state={workspaces.state} busy={workspaces.busy} locked={workspaceLocked} onOpen={openWorkspace} onSelect={selectWorkspace} onRefresh={() => { if (!workspaceLocked) void workspaces.refresh() }} /> : undefined

  return <div className="workbench" data-theme={layout.theme} data-compact={compact} aria-busy={workspaces.busy} inert={workspaces.busy} onFocusCapture={(event) => {
    if (!compact) setCompactPanel(event.target.closest('.chat-panel') ? 'chat' : event.target.closest('.sidebar') ? 'tasks' : null)
  }}>
    <header className="titlebar">
      <div className="app-brand"><span className="brand-mark"><Icon name="layers" /></span><span>Task Continuum</span></div>
      <button type="button" className="command-center" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}><Icon name="search" /><span>Search tasks and jump back in</span><kbd>Ctrl P</kbd></button>
      <div className="titlebar-actions">{workspaces.available && <IconButton icon="folder-opened" label="Switch workspace folder" disabled={workspaceLocked || workspaces.busy} onClick={openWorkspace} />}<IconButton icon="layout-sidebar-left" label="Toggle task sidebar" title="Toggle task sidebar (Ctrl+B)" aria-pressed={sidebarVisible} onClick={toggleSidebar} /><IconButton icon="layout-sidebar-right" label="Toggle chat panel" title="Toggle chat panel (Ctrl+Alt+B)" aria-pressed={chatVisible} onClick={toggleChat} /></div>
      {window.desktop && <div className="window-controls"><IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} /><IconButton icon="chrome-maximize" label="Maximize or restore window" onClick={() => windowAction('toggleMaximize')} /><IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} /></div>}
    </header>

    {workspaces.error && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{workspaces.error}</span><IconButton icon="close" label="Dismiss workspace error" onClick={() => workspaces.setError(null)} /></div>}
    {connectionError && dialog !== 'clear-chat' && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{connectionError}</span>{links.error ? <IconButton icon="refresh" label="Reload session links" disabled={links.busy || sessionBusy} onClick={() => { setActionError(null); void links.reload() }} /> : <IconButton icon="close" label="Dismiss Agent Host error" onClick={() => setActionError(null)} />}</div>}
    <div className="workbench-body" style={{ '--sidebar-width': `${sizes.sidebar.width}px`, '--chat-width': `${sizes.chat.width}px` } as CSSProperties}>
      <nav className="activity-bar" aria-label="Workbench navigation">
        <button type="button" className={sidebarVisible ? 'activity active' : 'activity'} aria-label="Tasks" title="Tasks" aria-pressed={sidebarVisible} onClick={openSidebar}><Icon name="checklist" /></button>
        <button type="button" className="activity" aria-label="Agent Host sessions" title="Native Agent Host sessions" onClick={openAgentHostSessions}><Icon name="server-environment" /></button>
        {workspace && window.remoteVSCode && <button type="button" className="activity" aria-label="Remote devices" title="Remote devices" onClick={() => setDialog('remote-devices')}><Icon name="remote" /></button>}
        <button type="button" className="activity" aria-label="Search tasks" title="Search tasks" onClick={() => { openSidebar(); requestAnimationFrame(() => document.getElementById('task-filter')?.focus()) }}><Icon name="search" /></button>
        <div className="activity-spacer" />
        <span className="avatar profile-avatar" title={workspace ? 'Local profile' : 'Local demo profile'}>Y</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && <TaskSidebar tasks={tasks} selectedId={selectedId} query={query} onQuery={setQuery} onSelect={selectTask} onCreate={() => setDialog('new-task')} onClose={toggleSidebar} workspace={workspace ?? undefined} workspaceControls={workspaceControls} />}
      {!compact && sidebarVisible && <PanelSash panel="sidebar" {...sizes.sidebar} onResize={(width) => changePanelWidth('sidebar', width)} onReset={() => changePanelWidth('sidebar', defaultLayout.sidebarWidth)} />}

      {(!compact || compactPanel === null) && <main className="main-panel" aria-label="Task workspace">
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
        <div id="active-task" className="active-task">
          {task ? <TaskViewer task={task} readOnly={Boolean(workspace)} workspaceName={workspace?.name} onCheck={(id) => changeTask((current) => ({ ...current, checklist: current.checklist.map((item) => item.id === id ? { ...item, done: !item.done } : item) }))} onStatus={(status: TaskStatus) => changeTask((current) => ({ ...current, status }))} onChat={showChat} /> : <div className="empty-workbench workspace-empty"><Icon name="layers" /><h1>{workspace && !tasks.length ? 'No tasks in this workspace' : 'Make room for meaningful work.'}</h1><p>{workspace ? workspace.name : 'Open a task to pick up where you left off.'}</p>{tasks.length > 0 && <button type="button" className="primary-button" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}>Open a task <kbd>Ctrl P</kbd></button>}{workspace && !tasks.length && <button type="button" className="secondary-button" onClick={openWorkspace}><Icon name="folder-opened" />Open workspace folder</button>}</div>}
        </div>
      </main>}

      {!compact && chatVisible && <PanelSash panel="chat" {...sizes.chat} onResize={(width) => changePanelWidth('chat', width)} onReset={() => changePanelWidth('chat', defaultLayout.chatWidth)} />}
      {chatVisible && (task && agentHostBinding ? <AgentHostPanel key={`${task.id}:${sessionBindingKey(bindings[task.id])}`} task={task} target={agentHostBinding} onDetach={() => { setActionError(null); setDetachTarget({ taskId: task.id, key: agentHostKey(agentHostBinding) }); setDialog('clear-chat') }} onClose={toggleChat} onDevices={window.remoteVSCode ? () => setDialog('remote-devices') : undefined} onBusy={setAgentHostBusy} /> : <aside className="chat-panel empty-chat" aria-label="Task chat">
        <header className="panel-header"><span>AGENT HOST</span><IconButton icon="layout-sidebar-right-off" label="Hide chat panel" onClick={toggleChat} /></header>
        <div className="chat-context"><Icon name="server-environment" /><div><strong>Native Agent Host chats</strong><span>{task?.id ?? 'No task selected'}</span></div></div>
        <div className="empty-workbench">
          <p>{!task ? 'Select a task to open its Agent Host chat.' : !workspace ? 'Demo tasks do not start conversations. Open a task workspace to use native Agent Host sessions.' : `No Agent Host chat is linked to ${task.id}. Select an existing chat or explicitly create one from the session picker.`}</p>
          <p className="muted">Local SDK and Companion sessions are not supported. Existing session data is left untouched.</p>
          {task && workspace && <button type="button" className="primary-button" disabled={links.busy} onClick={openAgentHostSessions}>Browse Agent Host sessions</button>}
          {task && !workspace && workspaces.available && <button type="button" className="primary-button" onClick={openWorkspace}>Open a task workspace</button>}
        </div>
      </aside>)}
    </div>

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={agentHostBinding ? 'server-environment' : workspace ? 'folder' : 'beaker'} />{agentHostBinding ? 'AGENT HOST' : workspace ? 'LOCAL WORKSPACE' : 'LOCAL DEMO'}</span><span><Icon name="checklist" />{tasks.length} tasks</span><span>{selectedId ?? 'No task selected'}</span><span className="statusbar-spacer" /><span className="response-status" role="status">{workspaces.busy ? 'Loading workspace...' : links.busy ? 'Saving or loading session links...' : sessionBusy ? 'Agent Host active' : agentHostBinding ? `Agent Host @ ${agentHostBinding.owner.machineName}` : workspace ? 'Select an Agent Host chat' : 'Demo tasks only'}</span><button type="button" onClick={openAgentHostSessions}><Icon name={agentHostBinding ? 'link' : 'plug'} />{agentHostBinding ? 'Agent Host linked' : 'No Agent Host linked'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); setCompactPanel(null) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3><div className="integration-row"><span>Native Agent Host (AHP)</span><span className="integration-state">{window.agentHost ? 'Desktop API available' : 'Desktop API unavailable'}</span></div><div className="integration-row"><span>Remote devices and automatic workspace links</span><span className="integration-state">{window.remoteVSCode ? 'Desktop API available' : 'Desktop API unavailable'}</span></div></section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div></section><p className="dialog-hint">{workspace ? `Workspace: ${workspace.root}. Tasks: read-only. Session links: immutable Agent Host metadata.` : 'Only display preferences are saved. Demo task changes reset when the window reloads; no session runtime is started.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'clear-chat' && detachTarget && <Dialog title="Detach conversation" onClose={() => { if (!links.busy) setDialog(null) }}><p>Detach this Agent Host chat from {detachTarget.taskId}? An immutable workspace update will remove the binding. Conversation history stays on its Host.</p>{(detachmentChanged || connectionError) && <p className="copilot-error" role="alert">{detachmentChanged ? 'The task binding changed. Close this dialog and review the current Agent Host chat before detaching.' : connectionError}</p>}<div className="dialog-actions">{links.error && <button type="button" className="secondary-button" disabled={links.busy} onClick={() => { setActionError(null); void links.reload() }}>Reload session links</button>}<button type="button" className="secondary-button" disabled={links.busy} onClick={() => setDialog(null)}>Keep conversation</button><button type="button" className="primary-button" disabled={!links.ready || sessionBusy || detachmentChanged} onClick={() => { void detachSession(detachTarget.taskId) }}>Detach session</button></div></Dialog>}
    {dialog === 'remote-devices' && workspace && <RemoteDevicesDialog onClose={() => setDialog(null)} />}
    {dialog === 'agent-host-sessions' && workspace && <AgentHostSessionsDialog taskId={selectedId ?? undefined} taskUnbound={Boolean(task && links.ready && !bindings[task.id])} onLink={linkAgentHost} onCreated={agentHostCreated} onDevices={() => setDialog('remote-devices')} onClose={() => setDialog(null)} />}

    {dialog === 'new-task' && !workspace && <Dialog title="New demo task" onClose={() => setDialog(null)}><form onSubmit={(event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      const title = String(data.get('title') ?? '').trim()
      const description = String(data.get('description') ?? '').trim()
      if (!title) return
      const id = `LOCAL-${String(tasks.filter((item) => item.id.startsWith('LOCAL-')).length + 1).padStart(3, '0')}`
      const created: TaskRecord = { id, title, kind: 'feature', status: 'backlog', priority: 'P2', owner: 'You', summary: description || 'A new task in your local demo workspace.', goal: description || 'Describe the outcome you want to achieve.', nextAction: 'Discuss the goal and define acceptance criteria.', requirements: [], plan: [], checklist: [] }
      setTasks((items) => [...items, created]); selectTask(id); setDialog(null)
    }}><label className="form-field">Title<input name="title" required maxLength={120} placeholder="What needs to happen?" autoFocus /></label><label className="form-field">Description<textarea name="description" maxLength={1000} rows={3} placeholder="A little context goes a long way." /></label><p className="dialog-hint">Created in memory only. No files or backend records will be written.</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="primary-button">Create task</button></div></form></Dialog>}
  </div>
}
