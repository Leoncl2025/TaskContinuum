import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import type { ChatAdapter } from '../shared/chat'
import type { DesktopInfo } from '../shared/desktop'
import type { ImportPreview, LocalSessionSummary, SessionOptions, SessionSnapshot } from '../shared/sessions'
import { filterTasks } from '../shared/tasks'
import type { TaskRecord, TaskStatus } from '../shared/tasks'
import { demoChatAdapter } from './chat/demoAdapter'
import { useTaskChats } from './chat/useTaskChats'
import { useCopilotConnection } from './chat/useCopilotConnection'
import { readSessionBindings, saveSessionBindings } from './chat/sessionBindings'
import { ChatPanel } from './components/ChatPanel'
import { CopilotInteractionDialog, CopilotSessionDialog } from './components/CopilotDialogs'
import { LocalSessions } from './components/LocalSessions'
import { Dialog, Icon, IconButton } from './components/Primitives'
import { TaskSidebar } from './components/TaskSidebar'
import { TaskViewer } from './components/TaskViewer'
import { demoTasks } from './data/tasks'
import { defaultLayout, isCompact, readLayout, saveLayout, subscribeCompact } from './layout'

type DialogName = 'quick-open' | 'settings' | 'new-task' | 'clear-chat' | null

export default function App({ adapter: suppliedAdapter }: { adapter?: ChatAdapter }) {
  const copilot = useCopilotConnection()
  const adapter = suppliedAdapter ?? (copilot.enabled && copilot.adapter ? copilot.adapter : demoChatAdapter)
  const [bindings, setBindings] = useState(readSessionBindings)
  const [sessionDialog, setSessionDialog] = useState<{ kind: 'new' } | { kind: 'import'; preview: ImportPreview } | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[]>(() => structuredClone(demoTasks))
  const [selectedId, setSelectedId] = useState<string | null>('T-0002')
  const [openTasks, setOpenTasks] = useState(['T-0001', 'T-0002'])
  const [view, setView] = useState<'tasks' | 'sessions'>('tasks')
  const [query, setQuery] = useState('')
  const [quickQuery, setQuickQuery] = useState('')
  const [layout, setLayout] = useState(readLayout)
  const [dialog, setDialog] = useState<DialogName>(null)
  const [compactPanel, setCompactPanel] = useState<'tasks' | 'chat' | null>(null)
  const [desktop, setDesktop] = useState<DesktopInfo>()
  const [desktopError, setDesktopError] = useState(false)
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const chats = useTaskChats(adapter)
  const task = tasks.find((item) => item.id === selectedId)
  const sidebarVisible = compact ? compactPanel === 'tasks' : layout.sidebar
  const chatVisible = compact ? compactPanel === 'chat' : layout.chat
  const activeResponses = Object.values(chats.threads).filter((thread) => thread.messages.some((message) => message.status === 'streaming')).length
  const interaction = copilot.interactions[0]

  useEffect(() => { saveLayout(layout) }, [layout])
  useEffect(() => { saveSessionBindings(bindings) }, [bindings])
  const currentSession = useEffectEvent((taskId: string) => chats.getThread(taskId).sessionId)
  const restoreSession = useEffectEvent((taskId: string, snapshot: SessionSnapshot) => chats.restore(taskId, snapshot.session.id, snapshot.messages))
  const restoreError = useEffectEvent((error: unknown) => copilot.setError(error instanceof Error ? error.message : 'The attached session could not be restored.'))
  useEffect(() => {
    if (!copilot.bridge || !copilot.enabled || copilot.status.state !== 'ready' || !selectedId) return
    const binding = bindings[selectedId]
    if (!binding || currentSession(selectedId) === binding.id) return
    let cancelled = false
    void copilot.bridge.resumeSession(binding.id).then((snapshot) => {
      if (!cancelled) restoreSession(selectedId, snapshot)
    }).catch((error: unknown) => { if (!cancelled) restoreError(error) })
    return () => { cancelled = true }
  }, [copilot.bridge, copilot.enabled, copilot.status.state, selectedId, bindings])
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
      if (dialog || sessionDialog || interaction || event.isComposing) return
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
  }, [compact, dialog, sessionDialog, interaction, toggleChat, toggleSidebar])

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

  function changeTask(update: (current: TaskRecord) => TaskRecord): void {
    setTasks((current) => current.map((item) => item.id === selectedId ? update(item) : item))
  }

  function openSidebar(nextView: 'tasks' | 'sessions'): void {
    setView(nextView)
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

  function attachSession(taskId: string, snapshot: SessionSnapshot): void {
    for (const [id, binding] of Object.entries(bindings)) if (id !== taskId && binding.id === snapshot.session.id) chats.clear(id)
    setBindings((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([id, binding]) => id === taskId || binding.id !== snapshot.session.id)), [taskId]: { id: snapshot.session.id, title: snapshot.session.title } }))
    chats.restore(taskId, snapshot.session.id, snapshot.messages)
    selectTask(taskId)
    setSessionDialog(null)
    showChat()
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
    const target = selectedId ?? tasks[0].id
    if (session.source === 'vscode') {
      const preview = await copilot.run('Loading conversation preview', () => bridge.previewImport(session.id))
      if (preview) setSessionDialog({ kind: 'import', preview })
    } else {
      const snapshot = await copilot.run('Resuming conversation', () => bridge.resumeSession(session.id))
      if (snapshot) attachSession(target, snapshot)
    }
  }

  async function createSession(options: SessionOptions): Promise<void> {
    const bridge = copilot.bridge
    if (!bridge || !sessionDialog) return
    const target = selectedId ?? tasks[0].id
    const snapshot = await copilot.run('Opening Copilot conversation', () => sessionDialog.kind === 'import'
      ? bridge.importSession(sessionDialog.preview.token, options) : bridge.createSession(options))
    if (snapshot) { attachSession(target, snapshot); void copilot.refresh() }
  }

  return <div className="workbench" data-theme={layout.theme} data-compact={compact}>
    <header className="titlebar">
      <div className="app-brand"><span className="brand-mark"><Icon name="layers" /></span><span>Task Continuum</span></div>
      <button type="button" className="command-center" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}><Icon name="search" /><span>Search tasks and jump back in</span><kbd>Ctrl P</kbd></button>
      <div className="titlebar-actions"><IconButton icon="layout-sidebar-left" label="Toggle task sidebar" title="Toggle task sidebar (Ctrl+B)" aria-pressed={sidebarVisible} onClick={toggleSidebar} /><IconButton icon="layout-sidebar-right" label="Toggle chat panel" title="Toggle chat panel (Ctrl+Alt+B)" aria-pressed={chatVisible} onClick={toggleChat} /></div>
      {window.desktop && <div className="window-controls"><IconButton icon="chrome-minimize" label="Minimize window" onClick={() => windowAction('minimize')} /><IconButton icon="chrome-maximize" label="Maximize or restore window" onClick={() => windowAction('toggleMaximize')} /><IconButton icon="chrome-close" label="Close window" onClick={() => windowAction('close')} /></div>}
    </header>

    {copilot.error && !sessionDialog && !interaction && <div className="copilot-banner copilot-error" role="alert"><Icon name="error" /><span>{copilot.error}</span><IconButton icon="close" label="Dismiss Copilot error" onClick={() => copilot.setError(null)} /></div>}
    <div className="workbench-body">
      <nav className="activity-bar" aria-label="Workbench navigation">
        <button type="button" className={sidebarVisible && view === 'tasks' ? 'activity active' : 'activity'} aria-label="Tasks" title="Tasks" aria-pressed={sidebarVisible && view === 'tasks'} onClick={() => openSidebar('tasks')}><Icon name="checklist" /></button>
        <button type="button" className={sidebarVisible && view === 'sessions' ? 'activity active' : 'activity'} aria-label="Sessions" title="Local Copilot and VS Code sessions" aria-pressed={sidebarVisible && view === 'sessions'} onClick={() => openSidebar('sessions')}><Icon name="comment-discussion" />{activeResponses > 0 && <span className="activity-badge">{activeResponses}</span>}</button>
        <button type="button" className="activity" aria-label="Search tasks" title="Search tasks" onClick={() => { openSidebar('tasks'); requestAnimationFrame(() => document.getElementById('task-filter')?.focus()) }}><Icon name="search" /></button>
        <div className="activity-spacer" />
        <span className="avatar profile-avatar" title="Local demo profile">Y</span>
        <button type="button" className="activity" aria-label="Preferences" title="Preferences and integration status" onClick={() => setDialog('settings')}><Icon name="settings-gear" /></button>
      </nav>

      {sidebarVisible && (view === 'sessions' && copilot.bridge ? <LocalSessions status={copilot.status} listing={copilot.listing} busy={copilot.busy} selectedId={task ? chats.getThread(task.id).sessionId : undefined} onConnect={connectCopilot} onDisconnect={() => { for (const id of Object.keys(chats.threads)) chats.stop(id); void copilot.disconnect() }} onRefresh={() => { void copilot.refresh() }} onNew={() => { copilot.setError(null); setSessionDialog({ kind: 'new' }) }} onOpen={(session) => { void openSession(session) }} onClose={toggleSidebar} /> : <TaskSidebar tasks={tasks} selectedId={selectedId} view={view} query={query} onQuery={setQuery} onSelect={(id) => { selectTask(id); if (view === 'sessions') showChat() }} onCreate={() => setDialog('new-task')} onClose={toggleSidebar} threads={chats.threads} />)}

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
          {task ? <TaskViewer task={task} onCheck={(id) => changeTask((current) => ({ ...current, checklist: current.checklist.map((item) => item.id === id ? { ...item, done: !item.done } : item) }))} onStatus={(status: TaskStatus) => changeTask((current) => ({ ...current, status }))} onChat={showChat} /> : <div className="empty-workbench"><Icon name="layers" /><h1>Make room for meaningful work.</h1><p>Open a task to pick up where you left off.</p><button type="button" className="primary-button" onClick={() => { setQuickQuery(''); setDialog('quick-open') }}>Open a task <kbd>Ctrl P</kbd></button></div>}
        </div>
      </main>}

      {chatVisible && (task ? <ChatPanel task={task} thread={chats.getThread(task.id)} adapter={adapter} connected={copilot.status.state === 'ready'} sessionName={bindings[task.id]?.title} onSessions={copilot.bridge ? () => openSidebar('sessions') : undefined} onConnect={connectCopilot} onDraft={(value) => chats.setDraft(task.id, value)} onSend={(value) => { void chats.send(task, value) }} onStop={() => chats.stop(task.id)} onClear={() => setDialog('clear-chat')} onClose={toggleChat} /> : <aside className="chat-panel empty-chat" aria-label="Task chat"><IconButton icon="close" label="Hide chat panel" onClick={toggleChat} /><p>Select a task to start a conversation.</p></aside>)}
    </div>

    <footer className="statusbar" aria-label="Workbench status"><span className="local-status"><Icon name={copilot.enabled ? 'terminal' : 'beaker'} />{copilot.enabled ? 'LOCAL COPILOT' : 'LOCAL DEMO'}</span><span><Icon name="checklist" />{tasks.length} {copilot.enabled ? 'sample tasks' : 'tasks'}</span><span>{selectedId ?? 'No task selected'}</span><span className="statusbar-spacer" /><span className="response-status" role="status">{copilot.busy ?? (activeResponses ? `${activeResponses} responding` : 'Ready')}</span><button type="button" onClick={() => copilot.bridge ? openSidebar('sessions') : setDialog('settings')}><Icon name="plug" />{copilot.status.state === 'ready' ? 'Copilot connected' : copilot.enabled ? 'Copilot disconnected' : 'No services connected'}</button><span className="platform-status">{desktopError ? 'Desktop bridge error' : desktop ? `Desktop · ${desktop.version}` : 'Browser preview'}</span></footer>

    {dialog === 'quick-open' && <Dialog title="Quick open" className="quick-open" onClose={() => setDialog(null)}><input className="quick-input" aria-label="Find a task" placeholder="Type a task name or ID…" value={quickQuery} onChange={(event) => setQuickQuery(event.target.value)} autoFocus /><div className="quick-results">{filterTasks(tasks, quickQuery, 'all').map((item) => <button type="button" key={item.id} onClick={() => { selectTask(item.id); setDialog(null) }}><Icon name="file-text" /><strong>{item.title}</strong><span>{item.id}</span></button>)}{!filterTasks(tasks, quickQuery, 'all').length && <p>No matching tasks.</p>}</div><p className="dialog-hint">Tab to a result · Enter to open · Esc to close</p></Dialog>}

    {dialog === 'settings' && <Dialog title="Preferences" onClose={() => setDialog(null)}><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{(['dark', 'light'] as const).map((theme) => <label key={theme}><input type="radio" name="theme" checked={layout.theme === theme} onChange={() => setLayout((value) => ({ ...value, theme }))} /><span>{theme === 'dark' ? 'Dark' : 'Light'}</span></label>)}</div><button type="button" className="secondary-button" onClick={() => { setLayout((value) => ({ ...defaultLayout, theme: value.theme })); setCompactPanel(null) }}>Reset panel layout</button></section><section className="settings-section"><h3>Integrations</h3>{[copilot.bridge ? 'GitHub Copilot CLI' : 'Agent Harness / model provider', 'SSH session sharing', 'OneDrive artifacts', 'GitHub EMU repository'].map((name) => <div className="integration-row" key={name}><span>{name}</span><span className="integration-state">{name === 'GitHub Copilot CLI' && copilot.status.state === 'ready' ? 'Connected' : 'Not connected'}</span></div>)}</section><section className="settings-section"><h3>Keyboard shortcuts</h3><div className="shortcut-row"><span>Quick open</span><kbd>Ctrl / ⌘ P</kbd></div><div className="shortcut-row"><span>Toggle task sidebar</span><kbd>Ctrl / ⌘ B</kbd></div><div className="shortcut-row"><span>Toggle chat</span><kbd>Ctrl / ⌘ Alt B</kbd></div></section><p className="dialog-hint">{copilot.enabled ? 'Copilot history: local disk. Task data: sample workspace.' : 'Only display preferences are saved. Demo tasks and conversations reset when the window reloads.'} Icons: Microsoft Codicons · CC BY 4.0.</p></Dialog>}

    {dialog === 'clear-chat' && task && <Dialog title={copilot.enabled ? 'Detach conversation' : 'Clear conversation'} onClose={() => setDialog(null)}><p>{copilot.enabled ? `Detach this session from ${task.id}? Copilot history stays on disk.` : `Clear the local messages and draft for ${task.id}? Other task conversations will not change.`}</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>Keep conversation</button><button type="button" className="primary-button" onClick={() => { chats.clear(task.id); setBindings((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== task.id))); setDialog(null) }}>{copilot.enabled ? 'Detach session' : 'Clear messages'}</button></div></Dialog>}

    {sessionDialog && copilot.bridge && <CopilotSessionDialog key={sessionDialog.kind === 'import' ? sessionDialog.preview.token : 'new'} preview={sessionDialog.kind === 'import' ? sessionDialog.preview : undefined} directory={copilot.status.workingDirectory} models={copilot.models} ready={copilot.status.state === 'ready'} busy={Boolean(copilot.busy)} error={copilot.error} onBrowse={() => copilot.run('Choosing directory', () => copilot.bridge!.chooseDirectory())} onConnect={connectCopilot} onSubmit={(options) => { void createSession(options) }} onClose={() => setSessionDialog(null)} />}
    {interaction && <CopilotInteractionDialog key={interaction.id} interaction={interaction} busy={Boolean(copilot.busy)} error={copilot.error} onRespond={(value) => { void copilot.respond(interaction.id, value) }} />}

    {dialog === 'new-task' && <Dialog title="New demo task" onClose={() => setDialog(null)}><form onSubmit={(event) => {
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