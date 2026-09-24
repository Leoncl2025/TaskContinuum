import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostSession } from '../../shared/agentHost'
import { sessionBindingKey } from '../chat/sessionBindings'
import type { SessionBinding, SessionBindings } from '../chat/sessionBindings'
import { Icon, IconButton } from './Primitives'
import { AgentHostCreationControls } from './AgentHostCreationControls'
import type { SessionTitleUpdate } from '../chat/useSessionTitles'

type SessionView = 'current' | 'link' | 'create'
interface Props {
  taskId?: string
  taskTitle?: string
  taskReady?: boolean
  bindings?: SessionBindings
  activeKey?: string
  localOwnerId?: string
  busy?: boolean
  initialView?: SessionView
  cachedTitles?: Readonly<Record<string, string>>
  titleCacheError?: string
  onTitles?(sessions: readonly SessionTitleUpdate[]): void
  onSelect?(binding: SessionBinding): void
  onDetach?(binding: SessionBinding): Promise<void>
  onLink(session: AgentHostSession): Promise<void>
  onCreated?(taskId: string, session: AgentHostSession): Promise<void>
  onDevices(): void
  onClose(): void
  onTasks?(): void
}

function SessionTree({ taskId, title, bindings, activeKey, sessions, cachedTitles, disabled, onSelect, onUnlink }: {
  taskId: string; title: string; bindings: SessionBinding[]; activeKey?: string; sessions: AgentHostSession[]; cachedTitles?: Readonly<Record<string, string>>; disabled: boolean; onSelect?(binding: SessionBinding): void; onUnlink?(binding: SessionBinding): void
}) {
  const [expanded, setExpanded] = useState(true)
  const [focused, setFocused] = useState<string>()
  const elements = useRef(new Map<string, HTMLLIElement>())
  const keys = [taskId, ...expanded ? bindings.map(sessionBindingKey) : []]
  const tabStop = focused && keys.includes(focused) ? focused : activeKey && expanded ? activeKey : taskId
  function focus(key: string): void { setFocused(key); elements.current.get(key)?.focus() }
  function navigate(event: KeyboardEvent<HTMLLIElement>, key: string): void {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return
    const index = keys.indexOf(key)
    let destination: string | undefined
    switch (event.key) {
      case 'ArrowDown': destination = keys[index + 1]; break
      case 'ArrowUp': destination = keys[index - 1]; break
      case 'Home': destination = taskId; break
      case 'End': destination = keys.at(-1); break
      case 'ArrowRight': if (key === taskId) { if (!expanded) setExpanded(true); else destination = keys[1] }; break
      case 'ArrowLeft': if (key === taskId) setExpanded(false); else destination = taskId; break
      case 'Enter':
      case ' ': if (key === taskId) setExpanded((value) => !value); else { const binding = bindings.find((item) => sessionBindingKey(item) === key); if (binding) onSelect?.(binding) }; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (destination) focus(destination)
  }
  return <ul role="tree" aria-label={`Sessions for ${taskId}`} className="task-list task-tree session-tree">
    <li role="treeitem" aria-label={`${taskId} ${title}`} aria-expanded={expanded} aria-level={1}
      tabIndex={tabStop === taskId ? 0 : -1} ref={(element) => { if (element) elements.current.set(taskId, element); else elements.current.delete(taskId) }}
      onFocus={(event) => { if (event.target === event.currentTarget) setFocused(taskId) }} onKeyDown={(event) => navigate(event, taskId)}>
      <button type="button" className="session-tree-task" tabIndex={-1} title={`${title} (${taskId})`} aria-label={`${expanded ? 'Collapse' : 'Expand'} sessions for ${title}`}
        onClick={() => { focus(taskId); setExpanded((value) => !value) }}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} /><span className="session-tree-task-name">{title}</span><span>{bindings.length}</span></button>
      {expanded && <ul role="group" className="task-tree-group">
        {bindings.map((binding) => {
          const key = sessionBindingKey(binding)
          const discovered = sessions.find((session) => agentHostKey(session) === agentHostKey(binding.agentHost))
          const cached = cachedTitles?.[agentHostKey(binding.agentHost)]
          const label = cached || discovered?.title || (binding.title !== 'Agent Host' ? binding.title : binding.id)
          return <li key={key} role="treeitem" aria-label={label} aria-description={binding.id} aria-selected={key === activeKey} aria-level={2}
            tabIndex={tabStop === key ? 0 : -1} ref={(element) => { if (element) elements.current.set(key, element); else elements.current.delete(key) }}
            onFocus={(event) => { if (event.target === event.currentTarget) setFocused(key) }} onKeyDown={(event) => navigate(event, key)}>
            <div className={`session-tree-row ${key === activeKey ? 'is-selected' : ''}`}><button type="button" tabIndex={-1} className="session-row" aria-label={`Open ${label}`} onClick={() => { focus(key); onSelect?.(binding) }}>
              <Icon name={key === activeKey ? 'comment-discussion' : 'comment'} /><span className="session-copy"><strong title={cached && !discovered ? 'Last known title saved on this device' : undefined}>{label}</strong><span className="session-directory" title={binding.id}>{binding.id}</span><span className="session-source">{binding.ownerIsRemote ? 'Remote' : 'Local'} / {binding.owner.machineName}</span><span className="session-source">{discovered ? discovered.canSend ? 'Read and send' : 'Read only' : 'Not in discovery list'}</span>{key === activeKey && <span className="session-task-link">Current session</span>}</span>
            </button>{onUnlink && <IconButton icon="debug-disconnect" label={`Unlink ${label}`} disabled={disabled} onClick={() => onUnlink(binding)} />}</div>
          </li>
        })}
      </ul>}
    </li>
  </ul>
}

export function AgentHostSessionsSidebar({ taskId, taskTitle, taskReady = false, bindings = {}, activeKey, localOwnerId, busy = false, initialView = 'current', cachedTitles, titleCacheError, onTitles, onSelect, onDetach, onLink, onCreated, onDevices, onClose, onTasks }: Props) {
  const bridge = window.agentHost
  const [view, setView] = useState<SessionView>(initialView)
  const [sessions, setSessions] = useState<AgentHostSession[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [catalogueError, setCatalogueError] = useState<string>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState<'local' | 'all'>('local')
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState(false)
  const [revision, setRevision] = useState(0)
  const [detach, setDetach] = useState<SessionBinding>()
  const running = useRef(false)
  const linked = taskId ? bindings[taskId] ?? [] : []
  const detachmentChanged = Boolean(detach && !linked.some((item) => sessionBindingKey(item) === sessionBindingKey(detach)))
  useEffect(() => {
    let active = true
    void (bridge?.list() ?? Promise.reject(new Error('The Agent Host desktop API is unavailable.'))).then((result) => {
      if (active) { onTitles?.(result.sessions); setSessions(result.sessions); setWarnings(result.warnings); setCatalogueError(undefined) }
    }).catch((failure: unknown) => { if (active) setCatalogueError(failure instanceof Error ? failure.message : 'Agent Host sessions could not be read.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, revision, onTitles])
  async function run(action: () => Promise<void>): Promise<void> {
    if (running.current || busy) return
    running.current = true
    setOperating(true)
    setError(undefined)
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'The session operation failed.') }
    finally { running.current = false; setOperating(false) }
  }
  async function created(id: string, session: AgentHostSession): Promise<void> {
    onTitles?.([session])
    await onCreated?.(id, session)
    setSessions((current) => [...current.filter((item) => agentHostKey(item) !== agentHostKey(session)), session])
    setView('current')
  }
  const filtered = sessions.filter((session) => (location === 'all' || !localOwnerId || session.owner.clientId === localOwnerId)
    && `${cachedTitles?.[agentHostKey(session)] ?? session.title} ${session.sessionId} ${session.owner.machineName}`.toLowerCase().includes(query.toLowerCase()))
  return <aside className="sidebar session-sidebar" aria-label="Agent Host sessions">
    <header className="panel-header"><span>AGENT HOST SESSIONS</span><div className="header-actions"><IconButton icon="refresh" label="Refresh Agent Host sessions" disabled={loading || operating} onClick={() => { setLoading(true); setRevision((value) => value + 1) }} /><IconButton icon="layout-sidebar-left-off" label="Hide session sidebar" onClick={onClose} /></div></header>
    <div className="session-task-context"><span className="muted">Current task</span><strong>{taskId ? `${taskId} - ${taskTitle ?? taskId}` : 'No task selected'}</strong>{onTasks && <button type="button" className="text-button" onClick={onTasks}>Back to tasks</button>}</div>
    <div className="session-view-tabs" role="tablist" aria-label="Session management">
      {(['current', 'link', 'create'] as const).map((name, index) => <button type="button" key={name} role="tab" aria-selected={view === name} aria-controls="session-management-content" tabIndex={view === name ? 0 : -1} onClick={() => { setView(name); setError(undefined) }} onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
        setView((['current', 'link', 'create'] as const)[next])
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>{name === 'current' ? 'Current' : name === 'link' ? 'Link' : 'Create'}</button>)}
    </div>
    <div className="sidebar-scroll session-sidebar-content" id="session-management-content" role="tabpanel" aria-label={`${view} sessions`}>
      {error && <p className="copilot-error" role="alert">{error}</p>}
      {titleCacheError && <p className="muted" role="status">{titleCacheError}</p>}
      {!taskId && <p className="muted">Select a task to link or create a session.</p>}
      {view === 'current' && <>
        {taskId && <SessionTree taskId={taskId} title={taskTitle ?? taskId} bindings={linked} activeKey={activeKey} sessions={sessions} cachedTitles={cachedTitles} disabled={!taskReady || busy || operating} onSelect={onSelect} onUnlink={onDetach ? (binding) => { setDetach(binding); setError(undefined) } : undefined} />}
        {!linked.length && <p className="muted">{busy ? 'Loading task sessions...' : 'No sessions linked to this task.'}</p>}
        <div className="session-sidebar-actions"><button type="button" className="secondary-button" disabled={!taskId} onClick={() => setView('link')}>Link existing</button><button type="button" className="secondary-button" disabled={!taskId} onClick={() => setView('create')}>Create new</button></div>
        {detach && <section className="session-inline-confirm" aria-label="Detach conversation"><p>Detach {detach.id} from {taskId}? Conversation history stays on its Host.</p>{detachmentChanged && <p role="alert">The task binding changed. Cancel and review the current sessions.</p>}<div className="session-sidebar-actions"><button type="button" className="secondary-button" disabled={operating} onClick={() => setDetach(undefined)}>Keep conversation</button><button type="button" className="primary-button" disabled={!taskReady || busy || operating || detachmentChanged} onClick={() => { void run(async () => { if (onDetach) await onDetach(detach); setDetach(undefined) }) }}>Detach session</button></div></section>}
      </>}
      {view === 'link' && <>
        <div className="ahp-catalog-toolbar"><input aria-label="Find Agent Host session" placeholder="Find session" value={query} onChange={(event) => setQuery(event.target.value)} /><IconButton icon="remote" label="Manage devices" disabled={operating} onClick={onDevices} /></div>
        <label className="session-filter">Show<select aria-label="Session location" value={location} onChange={(event) => setLocation(event.target.value === 'all' ? 'all' : 'local')}><option value="local">Local sessions</option><option value="all">All available sessions</option></select></label>
        {loading && <p className="muted" role="status">Loading sessions...</p>}
        {catalogueError && <p className="copilot-error" role="alert">{catalogueError}</p>}
        {warnings.map((warning, index) => <p key={index} className="muted" role="status">{warning}</p>)}
        {!loading && !catalogueError && !filtered.length && <p className="muted">No available Agent Host sessions.</p>}
        {filtered.map((session) => {
          const label = cachedTitles?.[agentHostKey(session)] ?? session.title
          const assigned = Object.entries(bindings).find(([, members]) => members.some((member) => member.owner.clientId === session.owner.clientId && member.id === session.sessionId))?.[0]
          return <section key={agentHostKey(session)} className="ahp-catalog-item" aria-label={`Host session ${label}`}><div><strong><Icon name="copilot" />{label}</strong><p className="muted">{session.owner.machineName} / {session.canSend ? 'Read and send' : 'Read only'}</p><span className="muted ahp-session-id">{session.sessionId}</span>{assigned && <p className="muted">Linked to {assigned}</p>}</div><IconButton icon="link" label={`Link ${label} to ${taskId ?? 'task'}`} disabled={loading || operating || busy || !taskReady || !taskId || Boolean(assigned && assigned !== taskId)} onClick={() => { void run(async () => { await onLink(session); setView('current') }) }} /></section>
        })}
      </>}
      {view === 'create' && <AgentHostCreationControls taskId={taskId} taskReady={taskReady} disabled={operating || busy} onCreated={created} />}
    </div>
  </aside>
}
