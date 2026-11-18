import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostHistoryTransfer, AgentHostSession } from '../../shared/agentHost'
import { moveSessionKey, sessionBindingKey, sessionSortModes, sortSessionBindings } from '../chat/sessionBindings'
import type { SessionBinding, SessionBindings, SessionSortMode } from '../chat/sessionBindings'
import { Icon, IconButton } from './Primitives'
import { AgentHostCreationControls } from './AgentHostCreationControls'
import type { SessionTimestamps, SessionTitleUpdate } from '../chat/useSessionTitles'
import { machineLabel, useMachineAliases } from '../machineAliases'

const SESSION_DRAG_MIME = 'application/x-taskcontinuum-session-key'
const SORT_LABELS: Readonly<Record<SessionSortMode, string>> = {
  'manual': 'Manual',
  'updated-desc': 'Last response',
  'created-desc': 'Created (newest)',
  'created-asc': 'Created (oldest)',
  'title-asc': 'Name (A–Z)',
  'title-desc': 'Name (Z–A)',
  'machine-asc': 'Machine',
}

type SessionView = 'current' | 'link' | 'create'
export interface SessionExpandRequest {
  readonly key: string
  readonly id: number
}
interface Props {
  taskId?: string
  taskTitle?: string
  taskReady?: boolean
  bindings?: SessionBindings
  orderedKeys?: readonly string[]
  sortMode?: SessionSortMode
  activeKey?: string
  expandSession?: SessionExpandRequest
  localOwnerId?: string
  busy?: boolean
  initialView?: SessionView
  cachedTitles?: Readonly<Record<string, string>>
  sessionTimestamps?: Readonly<Record<string, SessionTimestamps>>
  historyTransfers?: Readonly<Record<string, AgentHostHistoryTransfer>>
  titleCacheError?: string
  onTitles?(sessions: readonly SessionTitleUpdate[]): void
  onSelect?(binding: SessionBinding): void
  onReorder?(orderedKeys: string[]): void
  onSortMode?(mode: SessionSortMode): void
  onDetach?(binding: SessionBinding): Promise<void>
  onLink(session: AgentHostSession): Promise<void>
  onCreated?(taskId: string, session: AgentHostSession): Promise<void>
  onDevices(): void
  onClose(): void
}

function transferProgress(progress: AgentHostHistoryTransfer) {
  const value = progress.totalBytes > 0 ? Math.max(0, Math.min(100, progress.receivedBytes / progress.totalBytes * 100)) : 0
  const percent = value > 0 && value < 0.1 ? '<0.1' : `${Math.floor(value * 10) / 10}`
  const divisor = progress.totalBytes >= 1024 * 1024 ? 1024 * 1024 : 1024
  const size = `${(progress.receivedBytes / divisor).toFixed(1)} / ${(progress.totalBytes / divisor).toFixed(1)} ${divisor === 1024 ? 'KiB' : 'MiB'}`
  const label = progress.kind === 'earlier' ? 'Earlier history' : progress.kind === 'recent' ? 'Recent history' : progress.resumed ? 'Resuming history' : 'Syncing history'
  const description = `${label}: ${percent}% (${size})${progress.resumed ? ' - Resumed from saved progress' : ''}`
  return { value, percent, label, description }
}

function SessionSortMenu({ count, value, onChange }: { count: number; value: SessionSortMode; onChange(mode: SessionSortMode): void }) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef(new Map<SessionSortMode, HTMLButtonElement>())

  useEffect(() => {
    if (!open) return
    options.current.get(value)?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, value])

  function close(): void {
    setOpen(false)
    trigger.current?.focus()
  }

  function moveFocus(offset: number): void {
    const active = [...options.current.entries()].find(([, element]) => element === document.activeElement)?.[0] ?? value
    const index = sessionSortModes.indexOf(active)
    const next = sessionSortModes[(index + offset + sessionSortModes.length) % sessionSortModes.length]
    options.current.get(next)?.focus()
  }

  return <div className="session-list-header">
    <span className="session-list-count">{count} sessions</span>
    <div className="session-sort" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={(event) => {
      if (!open) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); return }
      if (event.key === 'Home') { event.preventDefault(); options.current.get(sessionSortModes[0])?.focus(); return }
      if (event.key === 'End') { event.preventDefault(); options.current.get(sessionSortModes.at(-1)!)?.focus() }
    }}>
      <button ref={trigger} type="button" className="session-sort-trigger" aria-label="Sort sessions"
        title={`Sort: ${SORT_LABELS[value]}`} data-sorted={value !== 'manual' || undefined}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((current) => !current)}>
        <Icon name="list-filter" />
        <span>{SORT_LABELS[value]}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open && <div id={listboxId} className="session-sort-menu" role="listbox" aria-label="Sort sessions by">
        {sessionSortModes.map((mode) => <Fragment key={mode}>
          <button type="button" role="option" aria-selected={mode === value} className="session-sort-option"
            ref={(element) => { if (element) options.current.set(mode, element); else options.current.delete(mode) }}
            onClick={() => { onChange(mode); close() }}>
            <Icon name="check" className="session-sort-check" />
            <span>{SORT_LABELS[mode]}</span>
            {mode === 'manual' && <small>Drag</small>}
          </button>
          {mode === 'manual' && <div className="session-sort-divider" role="separator" />}
        </Fragment>)}
      </div>}
    </div>
  </div>
}

function SessionTree({ taskId, bindings, activeKey, expandSession, sessions, cachedTitles, historyTransfers, disabled, onSelect, onReorder, onUnlink }: {
  taskId: string; bindings: SessionBinding[]; activeKey?: string; expandSession?: SessionExpandRequest; sessions: AgentHostSession[]; cachedTitles?: Readonly<Record<string, string>>; historyTransfers?: Readonly<Record<string, AgentHostHistoryTransfer>>; disabled: boolean; onSelect?(binding: SessionBinding): void; onReorder?(orderedKeys: string[]): void; onUnlink?(binding: SessionBinding): void
}) {
  const aliases = useMachineAliases()
  const [expanded, setExpanded] = useState<string[]>(() => expandSession ? [expandSession.key] : [])
  const [seenExpandId, setSeenExpandId] = useState(expandSession?.id)
  if (expandSession && expandSession.id !== seenExpandId) {
    setSeenExpandId(expandSession.id)
    if (!expanded.includes(expandSession.key)) setExpanded([...expanded, expandSession.key])
  }
  const [focused, setFocused] = useState<string>()
  const [draggedKey, setDraggedKey] = useState<string>()
  const [dropIndicator, setDropIndicator] = useState<{ key: string; position: 'before' | 'after' }>()
  const detailsPrefix = useId()
  const elements = useRef(new Map<string, HTMLLIElement>())
  const dragState = useRef<{ key: string; insertIndex?: number } | undefined>(undefined)
  const suppressClick = useRef(false)
  const keys = bindings.map(sessionBindingKey)
  const canReorder = Boolean(onReorder && bindings.length > 1)
  const tabStop = focused && keys.includes(focused) ? focused : activeKey && keys.includes(activeKey) ? activeKey : keys[0]
  function clearDrag(): void {
    dragState.current = undefined
    setDraggedKey(undefined)
    setDropIndicator(undefined)
    if (suppressClick.current) setTimeout(() => { suppressClick.current = false }, 0)
  }
  function focus(key: string): void { setFocused(key); elements.current.get(key)?.focus() }
  function showDetails(key: string, open: boolean): void {
    setExpanded((current) => open ? current.includes(key) ? current : [...current, key] : current.filter((item) => item !== key))
  }
  function resolveInsertIndex(clientY: number, targetElement: Element | null, sourceIndex: number): number {
    const rows = keys.map((key) => elements.current.get(key)?.querySelector<HTMLElement>('.session-tree-row') ?? elements.current.get(key))
    if (rows.every((row) => row && row.getBoundingClientRect().height > 0)) {
      for (let index = 0; index < rows.length; index++) {
        const rect = rows[index]!.getBoundingClientRect()
        const midpoint = rect.top + rect.height / 2
        if (index < sourceIndex ? clientY <= midpoint : clientY < midpoint) return index
      }
      return keys.length
    }
    const targetKey = targetElement?.closest('li[role="treeitem"]')?.getAttribute('data-session-key')
    const targetIndex = targetKey ? keys.indexOf(targetKey) : -1
    if (targetIndex < 0) return keys.length
    return targetIndex <= sourceIndex ? targetIndex : targetIndex + 1
  }
  function startDrag(event: DragEvent<HTMLDivElement>, key: string): void {
    if (!canReorder || (event.target as Element | null)?.closest?.('.icon-button')) {
      event.preventDefault()
      return
    }
    dragState.current = { key }
    suppressClick.current = true
    setDraggedKey(key)
    setDropIndicator(undefined)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      try { event.dataTransfer.setData(SESSION_DRAG_MIME, key) } catch { /* synthetic DataTransfer may be read-only */ }
      if (typeof event.dataTransfer.setDragImage === 'function') {
        const rect = event.currentTarget.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          event.dataTransfer.setDragImage(
            event.currentTarget,
            Math.min(Math.max(0, event.clientX - rect.left), rect.width),
            Math.min(Math.max(0, event.clientY - rect.top), rect.height),
          )
        }
      }
    }
  }
  function dragOver(event: DragEvent<HTMLUListElement>): void {
    const current = dragState.current
    if (!canReorder || !current) return
    const sourceIndex = keys.indexOf(current.key)
    if (sourceIndex < 0) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const insertIndex = resolveInsertIndex(event.clientY, event.target as Element | null, sourceIndex)
    current.insertIndex = insertIndex
    const noop = insertIndex === sourceIndex || insertIndex === sourceIndex + 1
    const next = noop ? undefined : insertIndex >= keys.length
      ? { key: keys[keys.length - 1], position: 'after' as const }
      : { key: keys[insertIndex], position: 'before' as const }
    setDropIndicator((prior) => prior?.key === next?.key && prior?.position === next?.position ? prior : next)
  }
  function dragLeave(event: DragEvent<HTMLUListElement>): void {
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    if (dragState.current) dragState.current.insertIndex = undefined
    setDropIndicator(undefined)
  }
  function drop(event: DragEvent<HTMLUListElement>): void {
    const current = dragState.current
    if (!canReorder || !current) return
    const sourceIndex = keys.indexOf(current.key)
    if (sourceIndex < 0) { clearDrag(); return }
    event.preventDefault()
    const insertIndex = current.insertIndex ?? resolveInsertIndex(event.clientY, event.target as Element | null, sourceIndex)
    const movedKey = current.key
    clearDrag()
    const nextKeys = moveSessionKey(keys, movedKey, insertIndex)
    if (nextKeys) onReorder?.(nextKeys)
  }
  function navigate(event: KeyboardEvent<HTMLLIElement>, key: string): void {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return
    const index = keys.indexOf(key)
    if (event.altKey) {
      if (!canReorder || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      event.stopPropagation()
      const nextKeys = moveSessionKey(keys, key, event.key === 'ArrowUp' ? index - 1 : index + 2)
      if (nextKeys) {
        setFocused(key)
        onReorder?.(nextKeys)
        requestAnimationFrame(() => elements.current.get(key)?.focus())
      }
      return
    }
    let destination: string | undefined
    switch (event.key) {
      case 'ArrowDown': destination = keys[index + 1]; break
      case 'ArrowUp': destination = keys[index - 1]; break
      case 'Home': destination = keys[0]; break
      case 'End': destination = keys.at(-1); break
      case 'ArrowRight': showDetails(key, true); break
      case 'ArrowLeft': showDetails(key, false); break
      case 'Enter':
      case ' ': { const binding = bindings.find((item) => sessionBindingKey(item) === key); if (binding) onSelect?.(binding) }; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (destination) focus(destination)
  }
  return <ul role="tree" aria-label={`Sessions for ${taskId}`} aria-keyshortcuts={canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
    className="task-list task-tree session-tree" onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
    {bindings.map((binding, index) => {
      const key = sessionBindingKey(binding)
      const discovered = sessions.find((session) => agentHostKey(session) === agentHostKey(binding.agentHost))
      const cached = cachedTitles?.[agentHostKey(binding.agentHost)]
      const label = cached || discovered?.title || (binding.title !== 'Agent Host' ? binding.title : binding.id)
      const progress = historyTransfers?.[agentHostKey(binding.agentHost)]
      const transfer = progress && transferProgress(progress)
      const open = expanded.includes(key)
      const detailsId = `${detailsPrefix}-${index}`
      const dropPosition = draggedKey && keys.includes(draggedKey) && dropIndicator?.key === key ? dropIndicator.position : undefined
      return <li key={key} role="treeitem" data-session-key={key} data-drop={dropPosition} aria-label={label} aria-description={binding.id} aria-selected={key === activeKey} aria-expanded={open} aria-level={1}
        tabIndex={tabStop === key ? 0 : -1} ref={(element) => { if (element) elements.current.set(key, element); else elements.current.delete(key) }}
        onFocus={(event) => { if (event.target === event.currentTarget) setFocused(key) }} onKeyDown={(event) => navigate(event, key)}>
        <div className={`session-tree-row ${key === activeKey ? 'is-selected' : ''}`} data-transferring={Boolean(transfer)}
          data-dragging={draggedKey === key && keys.includes(draggedKey) ? true : undefined}
          draggable={canReorder || undefined} onDragStart={(event) => startDrag(event, key)} onDragEnd={clearDrag}>
          {transfer && <progress className="session-transfer-mask" aria-label={`History transfer for ${label}`} max={100} value={transfer.value} aria-valuetext={transfer.description} />}
          {canReorder && <span className="session-drag-grip" aria-hidden="true"><Icon name="gripper" /></span>}
          <button type="button" tabIndex={-1} className="session-row" draggable={canReorder || undefined} aria-label={`Open ${label}`} title={label}
            onClick={() => { if (suppressClick.current) return; focus(key); onSelect?.(binding) }}>
            <strong title={cached && !discovered ? 'Last known title saved on this device' : undefined}>{label}</strong>
            {transfer ? <span className="session-transfer-status" title={transfer.description}>
              <Icon name="loading" className="codicon-modifier-spin" /><span>{transfer.label}</span><strong>{transfer.percent}%</strong>
            </span> : <span className="session-machine" title={binding.owner.machineName}>{machineLabel(binding.owner, aliases)}</span>}
          </button>
          <IconButton icon={open ? 'chevron-up' : 'chevron-down'} label={`${open ? 'Hide' : 'Show'} details for ${label}`} tabIndex={-1} aria-expanded={open} aria-controls={detailsId}
            onClick={() => { focus(key); showDetails(key, !open) }} />
        </div>
        {open && <div id={detailsId} className="session-details" role="group" aria-label={`Details for ${label}`}>
          <dl>
            <dt>Title</dt><dd>{label}</dd>
            <dt>Session</dt><dd>{binding.id}</dd>
            <dt>Chat</dt><dd>{binding.agentHost.chatId}</dd>
            <dt>Machine</dt><dd>{binding.owner.machineName}</dd>
            <dt>Location</dt><dd>{binding.ownerIsRemote ? 'Remote' : 'Local'}</dd>
            <dt>Access</dt><dd>{discovered ? discovered.canSend ? 'Read and send' : 'Read only' : 'Not in discovery list'}</dd>
            {key === activeKey && <><dt>Selection</dt><dd>Current session</dd></>}
          </dl>
          {onUnlink && <div className="session-details-actions">
            <button type="button" className="secondary-button session-unlink-button" aria-label={`Unlink ${label}`} disabled={disabled} onClick={() => onUnlink(binding)}>
              <Icon name="debug-disconnect" /><span>Unlink</span>
            </button>
          </div>}
        </div>}
      </li>
    })}
  </ul>
}

export function AgentHostSessionsSidebar({ taskId, taskTitle, taskReady = false, bindings = {}, orderedKeys, sortMode, activeKey, expandSession, localOwnerId, busy = false, initialView = 'current', cachedTitles, sessionTimestamps, historyTransfers, titleCacheError, onTitles, onSelect, onReorder, onSortMode, onDetach, onLink, onCreated, onDevices, onClose }: Props) {
  const bridge = window.agentHost
  const aliases = useMachineAliases()
  const [view, setView] = useState<SessionView>(() => expandSession ? 'current' : initialView)
  const [seenExpandId, setSeenExpandId] = useState(expandSession?.id)
  if (expandSession && expandSession.id !== seenExpandId) {
    setSeenExpandId(expandSession.id)
    if (view !== 'current') setView('current')
  }
  const [localSortMode, setLocalSortMode] = useState<SessionSortMode>('manual')
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
  const activeSortMode = sortMode ?? localSortMode
  const mergedTitles = useMemo(() => {
    const result: Record<string, string> = {}
    for (const session of sessions) if (session.title) result[agentHostKey(session)] = session.title
    if (cachedTitles) Object.assign(result, cachedTitles)
    return result
  }, [sessions, cachedTitles])
  const mergedTimestamps = useMemo(() => {
    const result: Record<string, SessionTimestamps> = { ...sessionTimestamps }
    for (const session of sessions) {
      const key = agentHostKey(session)
      const updated = Date.parse(session.updatedAt)
      const created = session.createdAt ? Date.parse(session.createdAt) : Number.NaN
      const prior = result[key]
      const updatedAt = Number.isFinite(updated) && updated >= 0
        ? prior?.updatedAt !== undefined ? Math.max(prior.updatedAt, updated) : updated
        : prior?.updatedAt
      const createdAt = Number.isFinite(created) && created >= 0
        ? prior?.createdAt !== undefined ? Math.min(prior.createdAt, created) : created
        : prior?.createdAt
      if (updatedAt !== undefined || createdAt !== undefined) {
        result[key] = {
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
        }
      }
    }
    return result
  }, [sessions, sessionTimestamps])
  const linked = useMemo(() => {
    if (!taskId) return []
    return sortSessionBindings(bindings[taskId] ?? [], {
      mode: activeSortMode,
      orderedKeys,
      titles: mergedTitles,
      timestamps: mergedTimestamps,
      aliases,
    })
  }, [taskId, bindings, activeSortMode, orderedKeys, mergedTitles, mergedTimestamps, aliases])
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
    && `${cachedTitles?.[agentHostKey(session)] ?? session.title} ${session.sessionId} ${machineLabel(session.owner, aliases)}`.toLowerCase().includes(query.toLowerCase()))
  return <aside className="sidebar session-sidebar" aria-label="Agent Host sessions">
    <header className="panel-header"><div className="header-actions"><IconButton icon="refresh" label="Refresh Agent Host sessions" disabled={loading || operating} onClick={() => { setLoading(true); setRevision((value) => value + 1) }} /><IconButton icon="layout-sidebar-left-off" label="Hide session sidebar" onClick={onClose} /></div></header>
    <div className="session-task-context"><strong>{taskId ? `${taskId} - ${taskTitle ?? taskId}` : 'No task selected'}</strong></div>
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
        {taskId && linked.length > 1 && <SessionSortMenu count={linked.length} value={activeSortMode} onChange={(next) => {
          if (sortMode === undefined) setLocalSortMode(next)
          onSortMode?.(next)
        }} />}
        {taskId && <SessionTree taskId={taskId} bindings={linked} activeKey={activeKey} expandSession={expandSession} sessions={sessions} cachedTitles={cachedTitles} historyTransfers={historyTransfers} disabled={!taskReady || busy || operating} onSelect={onSelect} onReorder={onReorder ? (nextKeys) => { if (sortMode === undefined) setLocalSortMode('manual'); onReorder(nextKeys) } : undefined} onUnlink={onDetach ? (binding) => { setDetach(binding); setError(undefined) } : undefined} />}
        {!linked.length && <p className="muted">{busy ? 'Loading task sessions...' : 'No sessions linked to this task.'}</p>}
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
          return <section key={agentHostKey(session)} className="ahp-catalog-item" aria-label={`Host session ${label}`}><div><strong><Icon name="copilot" />{label}</strong><p className="muted" title={session.owner.machineName}>{machineLabel(session.owner, aliases)} / {session.canSend ? 'Read and send' : 'Read only'}</p><span className="muted ahp-session-id">{session.sessionId}</span>{assigned && <p className="muted">Linked to {assigned}</p>}</div><IconButton icon="link" label={`Link ${label} to ${taskId ?? 'task'}`} disabled={loading || operating || busy || !taskReady || !taskId || Boolean(assigned && assigned !== taskId)} onClick={() => { void run(async () => { await onLink(session); setView('current') }) }} /></section>
        })}
      </>}
      {view === 'create' && <AgentHostCreationControls taskId={taskId} taskReady={taskReady} disabled={operating || busy} onCreated={created} />}
    </div>
  </aside>
}
