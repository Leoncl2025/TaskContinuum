import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ChatAdapter } from '../shared/chat'
import type { DesktopInfo } from '../shared/desktop'
import type { ImportPreview, LocalSessionSummary, SessionOptions, SessionSnapshot } from '../shared/sessions'
import { filterTasks } from '../shared/tasks'
import type { TaskRecord, TaskStatus } from '../shared/tasks'
import { demoChatAdapter } from './chat/demoAdapter'
import { useTaskChats } from './chat/useTaskChats'
import { useCopilotConnection } from './chat/useCopilotConnection'
import { useSessionLinks } from './chat/useSessionLinks'
import { sessionBindingKey } from './chat/sessionBindings'
import { sessionLinksPath } from '../shared/sessionBindings'
import { identityFromVSCodeHistory } from '../shared/vscodeChat'
import { ChatPanel } from './components/ChatPanel'
import { CopilotInteractionDialog, CopilotSessionDialog } from './components/CopilotDialogs'
import { LocalSessions } from './components/LocalSessions'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { demoTasks } from './data/tasks'
import { defaultLayout, isCompact, panelSizes, readLayout, resizePanel, saveLayout, subscribeCompact, subscribeViewport, viewportWidth } from './layout'
import type { LayoutPanel } from './layout'
import { PanelSash } from './components/PanelSash'
import { useWorkspaces } from './useWorkspaces'
import { WorkspacePicker } from './components/WorkspacePicker'
import { SharedSessionPanel } from './components/SharedSessionPanel'
import { VSCodeChatPanel } from './components/VSCodeChatPanel'
import type { SharedPanelStatus } from './components/SharedSessionPanel'
import { RemoteVSCodeAccessDialog, RemoteVSCodeDialog } from './components/RemoteVSCodeDialogs'
import type { RemoteVSCodeConnection } from '../shared/remoteVSCode'
import { AgentHostPanel } from './components/AgentHostPanel'
import { AgentHostSessionsDialog } from './components/AgentHostSessionsDialog'
import type { AgentHostSession } from '../shared/agentHost'
import { agentHostKey } from '../shared/agentHost'

type DialogName = 'quick-open' | 'settings' | 'new-task' | 'clear-chat' | 'migrate-links' | 'remote-sessions' | 'remote-access' | 'agent-host-sessions' | null

interface CreatedChatCompletion {
  taskId: string
  session: AgentHostSession
  picker: { active: boolean }
  resolve(): void
  reject(error: Error): void
}

export default function App({ adapter: suppliedAdapter }: { adapter?: ChatAdapter }) {
  const workspaces = useWorkspaces()
  return <Workbench key={workspaces.state.current?.id ?? 'demo'} suppliedAdapter={suppliedAdapter} workspaces={workspaces} />
}

function Workbench({ suppliedAdapter, workspaces }: { suppliedAdapter?: ChatAdapter; workspaces: ReturnType<typeof useWorkspaces> }) {
  const workspace = workspaces.state.current
  const copilot = useCopilotConnection()
  const links = useSessionLinks(workspace)
  const bindings = links.bindings
  const adapter = suppliedAdapter ?? ((copilot.enabled || Object.keys(bindings).length > 0) && copilot.adapter ? copilot.adapter : demoChatAdapter)
  const live = adapter.kind === 'live'
  const [sessionDialog, setSessionDialog] = useState<{ kind: 'new' } | { kind: 'import'; preview: ImportPreview } | null>(null)
  const [demoRecords, setTasks] = useState<TaskRecord[]>(() => structuredClone(demoTasks))
  const tasks = workspace?.tasks ?? demoRecords
  const [requestedId, setSelectedId] = useState<string | null>(() => workspace ? workspace.tasks[0]?.id ?? null : 'T-0002')
  const selectedId = requestedId !== null && !tasks.some((item) => item.id === requestedId) ? tasks[0]?.id ?? null : requestedId
  const [tabIds, setOpenTasks] = useState(() => workspace ? workspace.tasks.slice(0, 1).map((item) => item.id) : ['T-0001', 'T-0002'])
  const openTasks = [...new Set([...tabIds.filter((id) => tasks.some((item) => item.id === id)), ...(selectedId ? [selectedId] : [])])]
  const [view, setView] = useState<'tasks' | 'sessions'>('tasks')
  const [sharedChat, setSharedChat] = useState(false)
  const [sharedStatus, setSharedStatus] = useState<SharedPanelStatus>({ online: false, busy: false, pending: false, message: 'Shared sessions' })
  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | null>(null)
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [desktopError, setDesktopError] = useState(false)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const desktopWidth = useSyncExternalStore(subscribeViewport, viewportWidth, () => 1440)
  const sizes = panelSizes(layout, desktopWidth)
  const chats = useTaskChats(adapter)
  const task = tasks.find((item) => item.id === selectedId)
  const vscodeBinding = task && bindings[task.id]?.vscodeWorkspaceStorageId ? bindings[task.id] : undefined
  const agentHostBinding = task ? bindings[task.id]?.agentHost : undefined
  const [agentHostBusy, setAgentHostBusy] = useState(false)
  const [createdChat, setCreatedChat] = useState<CreatedChatCompletion | null>(null)
  const creationCompletion = useRef<CreatedChatCompletion | null>(null)
  const creationLifetime = useRef({ active: false })
  const creationPicker = useRef<{ active: boolean } | null>(null)
  const foreignCliBinding = Boolean(task && bindings[task.id]?.ownerIsRemote && !vscodeBinding && !agentHostBinding)
  const originalChat = Boolean(vscodeBinding) && !sharedChat
  const linkedChat = live || Boolean(vscodeBinding) || Boolean(agentHostBinding)
  const sidebarVisible = compact ? compactPanel === 'tasks' : layout.sidebar
  const chatVisible = compact ? compactPanel === 'chat' : layout.chat
  const activeResponses = Object.values(chats.threads).filter((thread) => thread.messages.some((message) => message.status === 'streaming')).length
  const interaction = copilot.interactions[0]
  const workspaceLocked = activeResponses > 0 || Boolean(copilot.busy) || links.busy || Boolean(sessionDialog) || Boolean(interaction) || dialog === 'migrate-links' || dialog === 'remote-sessions' || dialog === 'remote-access' || dialog === 'agent-host-sessions' || Boolean(agentHostBinding) && agentHostBusy || sharedChat && (sharedStatus.busy || sharedStatus.pending)

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
    chats.clear(completion.taskId)
    selectTask(completion.taskId)
    setSharedChat(false)
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
  const currentSession = useEffectEvent((taskId: string) => chats.getThread(taskId).sessionId)
  const clearSession = useEffectEvent((taskId: string) => chats.clear(taskId))
  const restoreSession = useEffectEvent((taskId: string, snapshot: SessionSnapshot) => chats.restore(taskId, snapshot.session.id, snapshot.messages))
  const restoreError = useEffectEvent((error: unknown) => copilot.setError(error instanceof Error ? error.message : 'The attached session could not be restored.'))
  useEffect(() => {
    if (!links.ready || !selectedId) return
    const binding = bindings[selectedId]
    const current = currentSession(selectedId)
    if (current && (current !== binding?.id || binding?.vscodeWorkspaceStorageId || binding?.agentHost)) clearSession(selectedId)
    if (!binding || binding.vscodeWorkspaceStorageId || binding.agentHost || binding.ownerIsRemote || current === binding.id || !copilot.bridge || !live || copilot.status.state !== 'ready') return
    let cancelled = false
    void copilot.bridge.resumeSession(binding.id).then((snapshot) => {
      if (!cancelled) restoreSession(selectedId, snapshot)
    }).catch((error: unknown) => {
      if (!cancelled) restoreError(new Error(`Could not resume linked session ${binding.id}. ${error instanceof Error ? error.message : 'The session may be unavailable on this machine.'}`))
    })
    return () => { cancelled = true }
  }, [copilot.bridge, copilot.status.state, live, selectedId, bindings, links.ready])
  useEffect(() => {
    let mounted = true
    void window.desktop?.getInfo().then((info) => { if (mounted) setDesktop(info) }).catch(() => { if (mounted) setDesktopError(true) })
    return () => { mounted = false }
  }, [])

  const toggleSidebar = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'tasks' ? null : 'tasks')
    else setLayout((value) => ({ ...value, sidebar: !value.sidebar }))
  }, [compact, setCompactPanel, setLayout])
  const toggleChat = useCallback(() => {
    if (compact) setCompactPanel((value) => value === 'chat' ? null : 'chat')
    else setLayout((value) => ({ ...value, chat: !value.chat }))
  }, [compact, setCompactPanel, setLayout])

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (dialog || sessionDialog || interaction || sharedChat && sharedStatus.pending || event.isComposing) return
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
  }, [compact, dialog, sessionDialog, interaction, sharedChat, sharedStatus.pending, toggleChat, toggleSidebar])

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

  function openSidebar(nextView: 'tasks' | 'sessions'): void {
    setView(nextView)
    if (nextView === 'sessions') setSharedChat(false)
    if (nextView === 'sessions' && copilot.bridge) void copilot.refresh()
    if (compact) setCompactPanel('tasks')
    else setLayout((value) => ({ ...value, sidebar: true }))
  }

  function windowAction(action: 'minimize' | 'toggleMaximize' | 'close'): void {
    void window.desktop?.[action]().catch(() => setDesktopError(true))
  }

  function connectCopilot(): void {
    if (copilot.status.state !== 'ready') for (const id of Object.keys(chats.threads)) chats.clear(id)
    void copilot.connect()
  }

  async function attachSession(taskId: string, snapshot: SessionSnapshot): Promise<void> {
    await links.attach(taskId, { id: snapshot.session.id, title: snapshot.session.title })
    for (const [id, binding] of Object.entries(bindings)) if (id !== taskId && !binding.vscodeWorkspaceStorageId && binding.id === snapshot.session.id) chats.clear(id)
    chats.restore(taskId, snapshot.session.id, snapshot.messages)
    selectTask(taskId)
    setSessionDialog(null)
    showChat()
  }

  async function linkOriginalVSCode(): Promise<void> {
    if (sessionDialog?.kind !== 'import' || !selectedId || !window.vscodeChat || !links.ready) return
    const taskId = selectedId
    const source = sessionDialog.preview.session
    await copilot.run('Linking original VS Code conversation', async () => {
      const identity = identityFromVSCodeHistory(source.id)
      if (bindings[taskId] && sessionBindingKey(bindings[taskId]) !== sessionBindingKey({ id: identity.nativeSessionId, vscodeWorkspaceStorageId: identity.workspaceStorageId })) {
        throw new Error('Detach the current conversation before linking this original VS Code session.')
      }
      await window.vscodeChat!.read(identity)
      await links.attach(taskId, { id: identity.nativeSessionId, title: source.title, vscodeWorkspaceStorageId: identity.workspaceStorageId })
      chats.clear(taskId)
      setSessionDialog(null)
      setSharedChat(false)
      showChat()
    })
  }

  async function linkRemoteVSCode(connection: RemoteVSCodeConnection): Promise<void> {
    if (!workspace || !selectedId || !links.ready) throw new Error('Select a task in a real workspace before linking remote VS Code.')
    const binding = { id: connection.target.nativeSessionId, title: connection.title, vscodeWorkspaceStorageId: connection.target.workspaceStorageId, remoteMachineName: connection.target.remoteMachineName }
    const existingTask = Object.entries(bindings).find(([, current]) => sessionBindingKey(current) === sessionBindingKey(binding))?.[0]
    if (existingTask) {
      if (!tasks.some((item) => item.id === existingTask)) throw new Error(`The remote conversation belongs to unavailable task ${existingTask}.`)
      selectTask(existingTask)
    } else {
      if (bindings[selectedId]) throw new Error('Detach the current conversation before linking a different remote session.')
      await links.attach(selectedId, binding)
      chats.clear(selectedId)
    }
    setDialog(null)
    setSharedChat(false)
    showChat()
  }

  async function linkAgentHost(session: AgentHostSession): Promise<void> {
    if (!workspace || !selectedId || !links.ready) throw new Error('Select a task in a real workspace before linking an Agent Host chat.')
    const binding = { id: session.sessionId, title: session.title, owner: session.owner, agentHost: { hostId: session.hostId, sessionId: session.sessionId, chatId: session.chatId, owner: session.owner } }
    const existing = Object.entries(bindings).find(([, current]) => sessionBindingKey(current) === sessionBindingKey(binding))?.[0]
    if (existing) selectTask(existing)
    else {
      if (bindings[selectedId]) throw new Error('Detach the current conversation before linking a different Host chat.')
      await links.attach(selectedId, binding)
      chats.clear(selectedId)
    }
    setDialog(null)
    setSharedChat(false)
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

  async function openSession(session: LocalSessionSummary): Promise<void> {
    const bridge = copilot.bridge
    if (!bridge) return
    const activeTaskId = session.source === 'copilot' ? Object.entries(chats.threads).find(([, thread]) =>
      thread.sessionId === session.id && thread.messages.some((message) => message.status === 'streaming'))?.[0] : undefined
    if (activeTaskId) {
      selectTask(activeTaskId)
      showChat()
      return
    }
    if (!links.ready) { copilot.setError('Reload the workspace session links before opening a conversation.'); return }
    let selectedKey = `copilot:${session.id}`
    if (session.source === 'vscode') {
      try {
        const identity = identityFromVSCodeHistory(session.id)
        selectedKey = sessionBindingKey({ id: identity.nativeSessionId, vscodeWorkspaceStorageId: identity.workspaceStorageId })
      } catch { selectedKey = session.id }
    }
    const linkedTask = Object.entries(bindings).find(([, binding]) => sessionBindingKey(binding) === selectedKey)?.[0]
    if (linkedTask) {
      if (!tasks.some((item) => item.id === linkedTask)) { copilot.setError(`This session is linked to ${linkedTask}, which is not present in this workspace.`); return }
      if (session.source === 'copilot' && selectedId === linkedTask && chats.getThread(linkedTask).sessionId !== session.id) {
        await copilot.run('Resuming linked conversation', async () => {
          const snapshot = await bridge.resumeSession(session.id)
          chats.restore(linkedTask, snapshot.session.id, snapshot.messages)
        })
      }
      setSharedChat(false)
      selectTask(linkedTask)
      showChat()
      return
    }
    const target = selectedId ?? tasks[0]?.id
    if (!target) { copilot.setError('This workspace has no tasks to attach a conversation to.'); return }
    if (session.source === 'vscode') {
      const preview = await copilot.run('Loading conversation preview', () => bridge.previewImport(session.id))
      if (preview) setSessionDialog({ kind: 'import', preview })
    } else {
      await copilot.run('Linking conversation', async () => {
        const snapshot = await bridge.resumeSession(session.id)
        await attachSession(target, snapshot)
      })
    }
  }

  async function createSession(options: SessionOptions): Promise<void> {
    const bridge = copilot.bridge
    if (!bridge || !sessionDialog) return
    if (!links.ready) { copilot.setError('Reload the workspace session links before creating a conversation.'); return }
    const target = selectedId ?? tasks[0]?.id
    if (!target) { copilot.setError('This workspace has no tasks to attach a conversation to.'); return }
    const linked = await copilot.run('Opening Copilot conversation', async () => {
      const snapshot = sessionDialog.kind === 'import' ? await bridge.importSession(sessionDialog.preview.token, options) : await bridge.createSession(options)
      try { await attachSession(target, snapshot) } catch (error) {
        throw new Error(`Session ${snapshot.session.id} was created, but its task link was not saved. It remains in Local sessions. ${error instanceof Error ? error.message : 'Retry after reloading the links.'}`)
      }
      return true
    })
    if (linked) void copilot.refresh()
  }

  async function detachSession(taskId: string): Promise<void> {
    await copilot.run('Removing session link', async () => {
      await links.detach(taskId)
      chats.clear(taskId)
      setDialog(null)
    })
  }

  async function migrateLinks(): Promise<void> {
    await copilot.run('Saving local session links', async () => {
      await links.migrate()
      setDialog(null)
    })
  }

  function openWorkspace(): void {
    if (!workspaceLocked) void workspaces.openFolder()
  }

  function selectWorkspace(id: string): void {
    if (workspaceLocked) return
    if (id === 'demo') void workspaces.useDemo()
    else void workspaces.openRecent(id)
  }

  const workspaceControls = workspaces.available ? <WorkspacePicker state={workspaces.state} busy={workspaces.busy} locked={workspaceLocked} onOpen={openWorkspace} onSelect={selectWorkspace} onRefresh={() => { if (!workspaceLocked) void workspaces.refresh() }} /> : undefined
  const listedBindings = Object.fromEntries((copilot.listing?.sessions ?? []).flatMap((session) => {
    let key = `copilot:${session.id}`
    if (session.source === 'vscode') {
      try {
        const identity = identityFromVSCodeHistory(session.id)
        key = sessionBindingKey({ id: identity.nativeSessionId, vscodeWorkspaceStorageId: identity.workspaceStorageId })
      } catch { return [] }
    }
    const taskId = Object.entries(bindings).find(([, binding]) => sessionBindingKey(binding) === key)?.[0]
    return taskId ? [[session.id, taskId]] : []
  }))

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
    {links.error && dialog !== 'migrate-links' && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{links.error}</span><IconButton icon="refresh" label="Reload session links" disabled={links.busy || activeResponses > 0} onClick={() => { copilot.setError(null); void links.reload() }} /></div>}
    {links.needsMigration && !links.error && <div className="copilot-banner link-migration-status"><Icon name="link" /><span>{Object.keys(links.legacy).length} local task/session links are not saved in this workspace.</span><button type="button" className="text-button" disabled={workspaceLocked} onClick={() => setDialog('migrate-links')}>Review links</button></div>}
    {copilot.error && !links.error && !sessionDialog && !interaction && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{copilot.error}</span><IconButton icon="close" label="Dismiss Copilot error" onClick={() => copilot.setError(null)} /></div>}
    <div className="workbench-body" style={{ '--sidebar-width': `${sizes.sidebar.width}px`, '--chat-width': `${sizes.chat.width}px` } as CSSProperties}>
      <nav className="activity-bar" aria-label="Workbench navigation">
        <button type="button" className={sidebarVisible && view === 'tasks' ? 'activity active' : 'activity'} aria-label="Tasks" title="Tasks" aria-pressed={sidebarVisible && view === 'tasks'} onClick={() => openSidebar('tasks')}><Icon name="checklist" /></button>
        <button type="button" className={sidebarVisible && view === 'sessions' ? 'activity active' : 'activity'} aria-label="Sessions" title="Local Copilot and VS Code sessions" aria-pressed={sidebarVisible && view === 'sessions'} onClick={() => openSidebar('sessions')}><Icon name="comment-discussion" />{activeResponses > 0 && <span className="activity-badge">{activeResponses}</span>}</button>
        {workspace && window.sharedSessions && <button type="button" className={sharedChat && chatVisible ? 'activity active' : 'activity'} aria-label="Shared sessions" title="Shared sessions" aria-pressed={sharedChat && chatVisible} onClick={() => { setSharedChat((value) => !value); showChat() }}><Icon name="organization" /></button>}
        {workspace && window.remoteVSCode && <button type="button" className="activity" aria-label="Remote VS Code sessions" title="Remote VS Code sessions" onClick={() => setDialog('remote-sessions')}><Icon name="remote" /></button>}
        {workspace && window.agentHost && <button type="button" className="activity" aria-label="Agent Host sessions" title="Agent Host sessions" onClick={() => setDialog('agent-host-sessions')}><Icon name="server-environment" /></button>}
        <button type="button" className="activity" aria-label="Search tasks" title="Search tasks" onClick={() => { openSidebar('tasks'); requestAnimationFrame(() => document.getElementById('task-filter')?.focus()) }}><Icon name="search" /></button>
        <div className="activity-spacer" />
        <span className="avatar profile-avatar" title={workspace ? 'Local profile' : 'Local demo profile'}>Y</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && (view === 'sessions' && copilot.bridge ? <LocalSessions status={copilot.status} listing={copilot.listing} busy={links.busy ? 'Loading session links' : copilot.busy} selectedId={Object.entries(listedBindings).find(([, taskId]) => taskId === selectedId)?.[0]} sessionTasks={listedBindings} onConnect={connectCopilot} onDisconnect={() => { for (const id of Object.keys(chats.threads)) chats.stop(id); void copilot.disconnect() }} onRefresh={() => { void copilot.refresh() }} onNew={() => { if (!links.ready) { copilot.setError('Reload the workspace session links before creating a conversation.'); return } if (!tasks.length) { copilot.setError('This workspace has no tasks to attach a conversation to.'); return } copilot.setError(null); setSessionDialog({ kind: 'new' }) }} onOpen={(session) => { void openSession(session) }} onClose={toggleSidebar} workspaceControls={workspaceControls} /> : <TaskSidebar tasks={tasks} selectedId={selectedId} view={view} query={query} onQuery={setQuery} onSelect={(id) => { selectTask(id); if (view === 'sessions') showChat() }} onCreate={() => setDialog('new-task')} onClose={toggleSidebar} threads={chats.threads} workspace={workspace ?? undefined} workspaceControls={workspaceControls} />)}

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

      {agentHostBinding && !sharedChat ? chatVisible && task && <AgentHostPanel key={`${task.id}:${sessionBindingKey(bindings[task.id])}`} task={task} target={agentHostBinding} onDetach={() => setDialog('clear-chat')} onClose={toggleChat} onDevices={workspace && window.remoteVSCode ? () => setDialog('remote-sessions') : undefined} onBusy={setAgentHostBusy} /> : <>
      {chatVisible && sharedChat && workspace ? <SharedSessionPanel task={task} root={workspace.root} onStatus={setSharedStatus} onClose={() => setSharedChat(false)} /> : chatVisible && task && vscodeBinding ? <VSCodeChatPanel key={`${task.id}:${sessionBindingKey(vscodeBinding)}`} task={task} identity={{ nativeSessionId: vscodeBinding.id, workspaceStorageId: vscodeBinding.vscodeWorkspaceStorageId!, ...(vscodeBinding.remoteMachineName ? { remoteMachineName: vscodeBinding.remoteMachineName } : {}) }} onDetach={() => setDialog('clear-chat')} onClose={toggleChat} onRemoteAccess={workspace && window.remoteVSCode ? () => setDialog('remote-access') : undefined} onRemoteConnections={workspace && window.remoteVSCode ? () => setDialog('remote-sessions') : undefined} /> : chatVisible && (task ? foreignCliBinding ? <aside className="chat-panel empty-chat" aria-label="Remote CLI session"><IconButton icon="close" label="Hide chat panel" onClick={toggleChat} /><p>CLI session owned by {bindings[task.id]?.owner?.machineName}. Remote native CLI routing is unavailable; no local session was started.</p></aside> : <ChatPanel task={task} thread={chats.getThread(task.id)} adapter={adapter} connected={copilot.status.state === 'ready'} boundSessionId={bindings[task.id]?.id} disabled={!links.ready || Boolean(copilot.busy)} sessionName={copilot.listing?.sessions.find((session) => session.id === bindings[task.id]?.id)?.title ?? bindings[task.id]?.title} onSessions={copilot.bridge ? () => openSidebar('sessions') : undefined} onConnect={connectCopilot} onDraft={(value) => chats.setDraft(task.id, value)} onImages={(value) => chats.setImages(task.id, value)} onSend={(value) => { if (links.ready && (!live || chats.getThread(task.id).sessionId === bindings[task.id]?.id)) void chats.send(task, value) }} onStop={() => chats.stop(task.id)} onClear={() => setDialog('clear-chat')} onClose={toggleChat} /> : <aside className="chat-panel empty-chat" aria-label="Task chat"><IconButton icon="close" label="Hide chat panel" onClick={toggleChat} /><p>Select a task to start a conversation.</p></aside>)}
      </>}
    </div>

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={sharedChat ? 'organization' : agentHostBinding ? 'server-environment' : originalChat ? 'vscode' : live ? 'terminal' : workspace ? 'folder' : 'beaker'} />{sharedChat ? 'SHARED SESSION' : agentHostBinding ? 'AGENT HOST' : originalChat ? 'VS CODE CHAT' : live ? 'LOCAL COPILOT' : workspace ? 'LOCAL WORKSPACE' : 'LOCAL DEMO'}</span><span><Icon name="checklist" />{tasks.length} {!workspace && live ? 'sample tasks' : 'tasks'}</span><span>{selectedId ?? 'No task selected'}</span><span className="statusbar-spacer" /><span className="response-status" role="status">{workspaces.busy ? 'Loading workspace...' : sharedChat ? sharedStatus.message : links.busy ? 'Saving or loading session links...' : copilot.busy ?? (agentHostBinding ? `Agent Host @ ${agentHostBinding.owner.machineName}` : originalChat ? 'Execution in VS Code' : activeResponses ? `${activeResponses} responding` : 'Ready')}</span><button type="button" onClick={() => { if (sharedChat) showChat(); else if (agentHostBinding) setDialog('agent-host-sessions'); else if (copilot.bridge) openSidebar('sessions'); else setDialog('settings') }}><Icon name={originalChat || agentHostBinding ? 'link' : 'plug'} />{sharedChat ? sharedStatus.online ? 'Shared Host connected' : 'Shared Host offline' : originalChat || agentHostBinding ? 'Original session linked' : copilot.status.state === 'ready' ? 'Copilot connected' : live ? 'Copilot disconnected' : 'No services connected'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); setCompactPanel(null) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3>{[copilot.bridge ? 'GitHub Copilot CLI' : 'Agent Harness / model provider', 'SSH session sharing', 'OneDrive artifacts', 'GitHub EMU repository'].map((name) => <div className="integration-row" key={name}><span>{name}</span><span className="integration-state">{name === 'GitHub Copilot CLI' && copilot.status.state === 'ready' ? 'Connected' : 'Not connected'}</span></div>)}</section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div></section><p className="dialog-hint">{workspace ? `Workspace: ${workspace.root}. Tasks: read-only. Session links: repository metadata.` : copilot.enabled ? 'Copilot history: local disk. Task data: sample workspace.' : 'Only display preferences are saved. Demo tasks and conversations reset when the window reloads.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'clear-chat' && task && <Dialog title={linkedChat ? 'Detach conversation' : 'Clear conversation'} onClose={() => { if (!links.busy) setDialog(null) }}><p>{linkedChat ? `Detach this session from ${task.id}? ${workspace ? `The entry in ${sessionLinksPath} will be removed. ` : ''}Copilot history stays on disk.` : `Clear the local messages and draft for ${task.id}? Other task conversations will not change.`}</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={links.busy} onClick={() => setDialog(null)}>Keep conversation</button><button type="button" className="primary-button" disabled={!links.ready || Boolean(copilot.busy)} onClick={() => { void detachSession(task.id) }}>{linkedChat ? 'Detach session' : 'Clear messages'}</button></div></Dialog>}

    {dialog === 'migrate-links' && workspace && <Dialog title="Save session links to workspace" onClose={() => { if (!links.busy) setDialog(null) }}><p>Write these task and session IDs to <code>{sessionLinksPath}</code>? The file can be committed to Git. Titles, conversation content, credentials, and local paths are excluded.</p><dl className="session-link-list">{Object.entries(links.legacy).map(([taskId, binding]) => <div key={taskId}><dt>{taskId}</dt><dd>{binding.id}</dd></div>)}</dl>{links.error && <p className="copilot-error" role="alert">{links.error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={links.busy} onClick={() => setDialog(null)}>Cancel</button><button type="button" className="primary-button" disabled={!links.ready || Boolean(copilot.busy)} onClick={() => { void migrateLinks() }}><Icon name="save" />Save links to workspace</button></div></Dialog>}

    {sessionDialog && copilot.bridge && <CopilotSessionDialog key={sessionDialog.kind === 'import' ? sessionDialog.preview.token : 'new'} preview={sessionDialog.kind === 'import' ? sessionDialog.preview : undefined} directory={workspace?.root ?? copilot.status.workingDirectory} models={copilot.models} ready={copilot.status.state === 'ready'} busy={Boolean(copilot.busy)} error={copilot.error} onBrowse={() => copilot.run('Choosing directory', () => copilot.bridge!.chooseDirectory())} onConnect={connectCopilot} onSubmit={(options) => { void createSession(options) }} onLink={sessionDialog.kind === 'import' && window.vscodeChat ? () => { void linkOriginalVSCode() } : undefined} onClose={() => setSessionDialog(null)} />}
    {interaction && <CopilotInteractionDialog key={interaction.id} interaction={interaction} busy={Boolean(copilot.busy)} error={copilot.error} onRespond={(value) => { void copilot.respond(interaction.id, value) }} />}
    {dialog === 'remote-sessions' && workspace && <RemoteVSCodeDialog taskId={selectedId ?? undefined} onLink={linkRemoteVSCode} onClose={() => setDialog(null)} />}
    {dialog === 'agent-host-sessions' && workspace && <AgentHostSessionsDialog taskId={selectedId ?? undefined} taskUnbound={Boolean(task && links.ready && !bindings[task.id])} onLink={linkAgentHost} onCreated={agentHostCreated} onDevices={() => setDialog('remote-sessions')} onClose={() => setDialog(null)} />}
    {dialog === 'remote-access' && workspace && vscodeBinding && !vscodeBinding.remoteMachineName && <RemoteVSCodeAccessDialog identity={{ nativeSessionId: vscodeBinding.id, workspaceStorageId: vscodeBinding.vscodeWorkspaceStorageId! }} onClose={() => setDialog(null)} />}

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