import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostBridge, AgentHostHistoryTransfer, AgentHostSession } from '../../shared/agentHost'
import type { TaskCollaborationPolicyUpdate, TaskCollaborationState } from '../../shared/sessionCollaboration'
import { compareSessionNames, DEFAULT_SESSION_SORT_MODE, sessionBindingKey, sessionSortModes } from '../chat/sessionBindings'
import type { SessionBinding, SessionBindings, SessionSortMode } from '../chat/sessionBindings'
import { buildSessionTree } from '../chat/sessionGroups'
import type { SessionGroupLayout } from '../chat/sessionGroups'
import { Icon, IconButton } from './Primitives'
import { AgentHostCreationControls } from './AgentHostCreationControls'
import { LinkedSessionTree } from './LinkedSessionTree'
import type { SessionExpandRequest, SessionRowContextAnchor } from './LinkedSessionTree'
import type { SessionTimestamps, SessionTitleUpdate } from '../chat/useSessionTitles'
import { machineLabel, useMachineAliases } from '../machineAliases'

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
interface Props {
  taskId?: string
  taskTitle?: string
  taskReady?: boolean
  bindings?: SessionBindings
  orderedKeys?: readonly string[]
  sessionLayout?: SessionGroupLayout
  sortMode?: SessionSortMode
  activeKey?: string
  popoutKeys?: ReadonlySet<string>
  provisional?: boolean
  awaitingSyncCount?: number
  expandSession?: SessionExpandRequest
  renameSession?: SessionExpandRequest
  localOwnerId?: string
  busy?: boolean
  initialView?: SessionView
  cachedTitles?: Readonly<Record<string, string>>
  sessionTimestamps?: Readonly<Record<string, SessionTimestamps>>
  historyTransfers?: Readonly<Record<string, AgentHostHistoryTransfer>>
  titleCacheError?: string
  onTitles?(sessions: readonly SessionTitleUpdate[]): void
  onSelect?(binding: SessionBinding): void
  onSplit?(binding: SessionBinding, direction?: 'right' | 'down'): void
  onPopOut?(binding: SessionBinding): void
  onSessionContextMenu?(binding: SessionBinding, anchor: SessionRowContextAnchor & { readonly unlink?: () => void }): void
  onRenameSession?(binding: SessionBinding, nextName: string | null): void
  onLayoutChange?(layout: SessionGroupLayout, makeManual: boolean): void
  onSortMode?(mode: SessionSortMode): void
  onSyncNow?(): Promise<void>
  onDetach?(binding: SessionBinding): Promise<void>
  onLink(session: AgentHostSession): Promise<void>
  onCreated?(taskId: string, session: AgentHostSession): Promise<void>
  onDevices(): void
  onClose(): void
}

const LINK_SORT_MODES = sessionSortModes.filter((mode): mode is Exclude<SessionSortMode, 'manual'> => mode !== 'manual')
const naturalMachineCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function SessionSortMenu({ count, groupCount = 0, modes = sessionSortModes, value, onChange }: {
  count: number
  groupCount?: number
  modes?: readonly SessionSortMode[]
  value: SessionSortMode
  onChange(mode: SessionSortMode): void
}) {
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
    const currentIndex = modes.indexOf(active)
    const index = currentIndex >= 0 ? currentIndex : 0
    const next = modes[(index + offset + modes.length) % modes.length]
    options.current.get(next)?.focus()
  }

  return <div className="session-list-header">
    <span className="session-list-count">{count} {count === 1 ? 'session' : 'sessions'}{groupCount > 0 && <span className="session-list-group-count"> · {groupCount} {groupCount === 1 ? 'group' : 'groups'}</span>}</span>
    <div className="session-sort" ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={(event) => {
      if (!open) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); return }
      if (event.key === 'Home') { event.preventDefault(); options.current.get(modes[0])?.focus(); return }
      if (event.key === 'End') { event.preventDefault(); options.current.get(modes.at(-1)!)?.focus() }
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
        {modes.map((mode) => <Fragment key={mode}>
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

function TaskCollaborationControls({ taskId, bridge, revision, disabled }: {
  taskId: string
  bridge: AgentHostBridge
  revision: number
  disabled: boolean
}) {
  const policyKey = `${taskId}:${revision}`
  const [policyState, setPolicyState] = useState<{ taskId: string; value: TaskCollaborationState }>()
  const [updating, setUpdating] = useState(false)
  const [policyError, setPolicyError] = useState<{ key: string; message: string }>()
  const policy = policyState?.taskId === taskId ? policyState.value : undefined
  const errorMessage = policyError?.key === policyKey ? policyError.message : undefined

  useEffect(() => {
    if (!bridge.collaborationPolicy) return
    let active = true
    void bridge.collaborationPolicy(taskId).then((value) => {
      if (active) {
        setPolicyState({ taskId, value })
        setPolicyError(undefined)
      }
    }).catch((failure: unknown) => {
      if (active) setPolicyError({ key: policyKey, message: failure instanceof Error ? failure.message : 'Could not read task collaboration policy.' })
    })
    return () => { active = false }
  }, [bridge, taskId, policyKey])

  if (!bridge.collaborationPolicy || !bridge.setCollaborationPolicy) return null

  async function applyUpdate(update: TaskCollaborationPolicyUpdate): Promise<void> {
    if (!bridge.setCollaborationPolicy || updating || disabled) return
    setUpdating(true)
    setPolicyError(undefined)
    try {
      const value = await bridge.setCollaborationPolicy(taskId, update)
      setPolicyState({ taskId, value })
    } catch (failure) {
      setPolicyError({ key: policyKey, message: failure instanceof Error ? failure.message : 'Could not update task collaboration policy.' })
    } finally {
      setUpdating(false)
    }
  }

  const statusText = !policy ? 'Loading...'
    : !policy.enabled ? 'Off'
      : policy.paused ? `Paused${policy.queuedCount ? ` · ${policy.queuedCount} queued` : ''}`
        : `Enabled · ${policy.sentCount}/${policy.maxSentMessages} sent${policy.queuedCount ? ` · ${policy.queuedCount} queued` : ''}`

  return <section className="session-collab-controls" aria-label="Task session collaboration">
    <div className="session-collab-header">
      <strong>Agent collaboration</strong>
      <span className="muted" role="status">{statusText}</span>
    </div>
    {errorMessage && <p className="copilot-error" role="alert">{errorMessage}</p>}
    {policy && <div className="session-collab-actions">
      <button type="button" className="secondary-button" disabled={disabled || updating}
        onClick={() => { void applyUpdate({ enabled: !policy.enabled }) }}>
        {policy.enabled ? 'Disable collaboration' : 'Enable collaboration'}
      </button>
      {policy.enabled && <button type="button" className="secondary-button" disabled={disabled || updating}
        onClick={() => { void applyUpdate({ paused: !policy.paused }) }}>
        {policy.paused ? 'Resume collaboration' : 'Pause collaboration'}
      </button>}
      {policy.sentCount > 0 && <button type="button" className="text-button" disabled={disabled || updating}
        onClick={() => { void applyUpdate({ resetBudget: true }) }}>
        Reset quota
      </button>}
    </div>}
  </section>
}

export function AgentHostSessionsSidebar({ taskId, taskTitle, taskReady = false, bindings = {}, orderedKeys, sessionLayout, sortMode, activeKey, popoutKeys, provisional = false, awaitingSyncCount = 0, expandSession, renameSession, localOwnerId, busy = false, initialView = 'current', cachedTitles, sessionTimestamps, historyTransfers, titleCacheError, onTitles, onSelect, onSplit, onPopOut, onSessionContextMenu, onRenameSession, onLayoutChange, onSortMode, onSyncNow, onDetach, onLink, onCreated, onDevices, onClose }: Props) {
  const bridge = window.agentHost
  const aliases = useMachineAliases()
  const [view, setView] = useState<SessionView>(() => expandSession || renameSession ? 'current' : initialView)
  const [seenExpandId, setSeenExpandId] = useState(expandSession?.id)
  if (expandSession && expandSession.id !== seenExpandId) {
    setSeenExpandId(expandSession.id)
    if (view !== 'current') setView('current')
  }
  const [seenRenameId, setSeenRenameId] = useState(renameSession?.id)
  if (renameSession && renameSession.id !== seenRenameId) {
    setSeenRenameId(renameSession.id)
    if (view !== 'current') setView('current')
  }
  const [localSortMode, setLocalSortMode] = useState<SessionSortMode>(DEFAULT_SESSION_SORT_MODE)
  const [linkSortMode, setLinkSortMode] = useState<Exclude<SessionSortMode, 'manual'>>('updated-desc')
  const [sessions, setSessions] = useState<AgentHostSession[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [catalogueError, setCatalogueError] = useState<string>()
  const [scopedError, setScopedError] = useState<{ taskId?: string; message: string }>()
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState<'local' | 'all'>('local')
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState(false)
  const [revision, setRevision] = useState(0)
  const [scopedDetach, setScopedDetach] = useState<{ taskId?: string; binding: SessionBinding }>()
  const detach = scopedDetach && scopedDetach.taskId === taskId ? scopedDetach.binding : undefined
  const error = scopedError && scopedError.taskId === taskId ? scopedError.message : undefined
  const setDetach = (binding: SessionBinding | undefined) => setScopedDetach(binding ? { taskId, binding } : undefined)
  const setError = (message: string | undefined) => setScopedError(message ? { taskId, message } : undefined)
  const running = useRef(false)
  const localOwnerIdRef = useRef(localOwnerId)
  useEffect(() => { localOwnerIdRef.current = localOwnerId }, [localOwnerId])
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
  const linked = useMemo(() => (taskId ? bindings[taskId] ?? [] : []), [bindings, taskId])
  const { entries, manual } = useMemo(() => buildSessionTree(linked, {
      mode: activeSortMode,
      orderedKeys,
      titles: mergedTitles,
      timestamps: mergedTimestamps,
      aliases,
  }, sessionLayout), [linked, activeSortMode, orderedKeys, mergedTitles, mergedTimestamps, aliases, sessionLayout])
  const detachmentChanged = Boolean(detach && !linked.some((item) => sessionBindingKey(item) === sessionBindingKey(detach)))
  useEffect(() => {
    let active = true
    void (bridge?.list(location) ?? Promise.reject(new Error('The Agent Host desktop API is unavailable.'))).then((result) => {
      if (active) {
        onTitles?.(result.sessions)
        setSessions((prior) => {
          if (location !== 'local' || !localOwnerIdRef.current) return result.sessions
          const retainedRemote = prior.filter((item) => item.owner.clientId !== localOwnerIdRef.current)
          return retainedRemote.length ? [...result.sessions, ...retainedRemote] : result.sessions
        })
        setWarnings(result.warnings)
        setCatalogueError(undefined)
      }
    }).catch((failure: unknown) => { if (active) setCatalogueError(failure instanceof Error ? failure.message : 'Agent Host sessions could not be read.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, location, revision, onTitles])
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
  const filtered = useMemo(() => {
    if (view !== 'link') return []
    const needle = query.trim().toLowerCase()
    const decorated = sessions
      .filter((session) => (location === 'all' || !localOwnerId || session.owner.clientId === localOwnerId)
        && (!needle || `${cachedTitles?.[agentHostKey(session)] ?? session.title} ${session.sessionId} ${machineLabel(session.owner, aliases)} ${session.owner.machineName}`.toLowerCase().includes(needle)))
      .map((session, index) => {
        const key = agentHostKey(session)
        const label = cachedTitles?.[key] ?? session.title
        const machine = machineLabel(session.owner, aliases)
        const times = mergedTimestamps[key]
        return { session, index, label, machine, updatedAt: times?.updatedAt, createdAt: times?.createdAt }
      })

    const compareUpdatedDesc = (left: typeof decorated[number], right: typeof decorated[number]): number => {
      const leftMissing = left.updatedAt === undefined ? 1 : 0
      const rightMissing = right.updatedAt === undefined ? 1 : 0
      if (leftMissing !== rightMissing) return leftMissing - rightMissing
      if (left.updatedAt !== undefined && right.updatedAt !== undefined && left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt
      }
      if (left.createdAt !== undefined && right.createdAt !== undefined && left.createdAt !== right.createdAt) {
        return right.createdAt - left.createdAt
      }
      return left.index - right.index
    }

    decorated.sort((left, right) => {
      switch (linkSortMode) {
        case 'updated-desc':
          return compareUpdatedDesc(left, right)
        case 'created-desc': {
          const leftTime = left.createdAt ?? left.updatedAt
          const rightTime = right.createdAt ?? right.updatedAt
          const leftMissing = leftTime === undefined ? 1 : 0
          const rightMissing = rightTime === undefined ? 1 : 0
          if (leftMissing !== rightMissing) return leftMissing - rightMissing
          if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return rightTime - leftTime
          return left.index - right.index
        }
        case 'created-asc': {
          const leftTime = left.createdAt ?? left.updatedAt
          const rightTime = right.createdAt ?? right.updatedAt
          const leftMissing = leftTime === undefined ? 1 : 0
          const rightMissing = rightTime === undefined ? 1 : 0
          if (leftMissing !== rightMissing) return leftMissing - rightMissing
          if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime
          return left.index - right.index
        }
        case 'title-asc': {
          const diff = compareSessionNames(left.label, right.label)
          return diff !== 0 ? diff : compareUpdatedDesc(left, right)
        }
        case 'title-desc': {
          const diff = compareSessionNames(right.label, left.label)
          return diff !== 0 ? diff : compareUpdatedDesc(left, right)
        }
        case 'machine-asc': {
          const diff = naturalMachineCollator.compare(left.machine, right.machine)
          return diff !== 0 ? diff : compareUpdatedDesc(left, right)
        }
      }
    })
    return decorated.map((item) => item.session)
  }, [view, sessions, location, localOwnerId, query, cachedTitles, aliases, mergedTimestamps, linkSortMode])
  return <aside className="sidebar session-sidebar" aria-label="Agent Host sessions">
    <header className="panel-header"><div className="header-actions"><IconButton icon="refresh" label="Refresh Agent Host sessions" disabled={loading || operating} onClick={() => { setLoading(true); setSessions([]); setRevision((value) => value + 1) }} /><IconButton icon="layout-sidebar-left-off" label="Hide session sidebar" onClick={onClose} /></div></header>
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
      {taskId && awaitingSyncCount > 0 && <section className="session-sync-notice" role="status" aria-label="Pending binding synchronization">
        <p><Icon name="sync" /><span>{awaitingSyncCount === 1 ? '1 remote binding change is' : `${awaitingSyncCount} remote binding changes are`} waiting for the publishing device to finish Git synchronization.</span></p>
        <div className="session-sidebar-actions">
          {onSyncNow && <button type="button" className="secondary-button" disabled={busy || operating} onClick={() => { void run(onSyncNow) }}><Icon name="sync" /><span>Sync now</span></button>}
          <button type="button" className="secondary-button" disabled={operating} onClick={onDevices}><Icon name="remote" /><span>Remote devices</span></button>
        </div>
      </section>}
      {view === 'current' && <>
        {taskId && !awaitingSyncCount && provisional && <p className="muted session-provisional-note" role="status"><Icon name="sync" /><span>Provisional session link — waiting for Git confirmation.</span></p>}
        {taskId && (linked.length > 1 || manual.groups.length > 0) && <SessionSortMenu count={linked.length} groupCount={manual.groups.length} value={activeSortMode} onChange={(next) => {
          if (sortMode === undefined) setLocalSortMode(next)
          onSortMode?.(next)
        }} />}
        {taskId && <LinkedSessionTree taskId={taskId} entries={entries} manualLayout={manual} activeKey={activeKey} popoutKeys={popoutKeys} expandSession={expandSession} renameSession={renameSession}
          sessions={sessions} cachedTitles={cachedTitles} historyTransfers={historyTransfers} unlinkDisabled={!taskReady || awaitingSyncCount > 0 || busy || operating} onSelect={onSelect} onSplit={onSplit} onPopOut={onPopOut}
          onSessionContextMenu={onSessionContextMenu ? (binding, anchor) => onSessionContextMenu(binding, {
            ...anchor,
            unlink: onDetach && taskReady && awaitingSyncCount === 0 && !busy && !operating
              ? () => { setDetach(binding); setError(undefined) }
              : undefined,
          }) : undefined}
          onRenameSession={onRenameSession}
          onLayoutChange={onLayoutChange ? (next, makeManual) => {
            if (sortMode === undefined && makeManual) setLocalSortMode('manual')
            onLayoutChange(next, makeManual)
          } : undefined}
          onUnlink={onDetach ? (binding) => { setDetach(binding); setError(undefined) } : undefined} />}
        {!linked.length && !awaitingSyncCount && <p className="muted">{busy ? 'Loading task sessions...' : 'No sessions linked to this task.'}</p>}
        {taskId && bridge?.collaborationPolicy && bridge.setCollaborationPolicy && <TaskCollaborationControls taskId={taskId} bridge={bridge} revision={revision} disabled={!taskReady || awaitingSyncCount > 0 || busy || operating} />}
        {detach && <section className="session-inline-confirm" aria-label="Detach conversation"><p>Detach {detach.id} from {taskId}? Conversation history stays on its Host.</p>{detachmentChanged && <p role="alert">The task binding changed. Cancel and review the current sessions.</p>}<div className="session-sidebar-actions"><button type="button" className="secondary-button" disabled={operating} onClick={() => setDetach(undefined)}>Keep conversation</button><button type="button" className="primary-button" disabled={!taskReady || awaitingSyncCount > 0 || busy || operating || detachmentChanged} onClick={() => { void run(async () => { if (onDetach) await onDetach(detach); setDetach(undefined) }) }}>Detach session</button></div></section>}
      </>}
      {view === 'link' && <>
        <div className="ahp-catalog-toolbar"><input aria-label="Find Agent Host session" placeholder="Find session" value={query} onChange={(event) => setQuery(event.target.value)} /><IconButton icon="remote" label="Manage devices" disabled={operating} onClick={onDevices} /></div>
        <label className="session-filter">Show<select aria-label="Session location" value={location} onChange={(event) => {
          const next = event.target.value === 'all' ? 'all' : 'local'
          if (next !== location) {
            setLoading(true)
            setWarnings([])
            setLocation(next)
          }
        }}><option value="local">Local sessions</option><option value="all">All available sessions</option></select></label>
        {filtered.length > 1 && <SessionSortMenu count={filtered.length} modes={LINK_SORT_MODES} value={linkSortMode} onChange={(mode) => { if (mode !== 'manual') setLinkSortMode(mode) }} />}
        {loading && <p className="muted" role="status">Loading sessions...</p>}
        {catalogueError && <p className="copilot-error" role="alert">{catalogueError}</p>}
        {warnings.map((warning, index) => <p key={index} className="muted" role="status">{warning}</p>)}
        {!loading && !catalogueError && !filtered.length && <p className="muted">No available Agent Host sessions.</p>}
        {filtered.map((session) => {
          const label = cachedTitles?.[agentHostKey(session)] ?? session.title
          const assigned = Object.entries(bindings).find(([, members]) => members.some((member) => member.owner.clientId === session.owner.clientId && member.id === session.sessionId))?.[0]
          return <section key={agentHostKey(session)} className="ahp-catalog-item" aria-label={`Host session ${label}`}><div><strong><Icon name="copilot" />{label}</strong><p className="muted" title={session.owner.machineName}>{machineLabel(session.owner, aliases)} / {session.canSend ? 'Read and send' : 'Read only'}</p><span className="muted ahp-session-id">{session.sessionId}</span>{assigned && <p className="muted">Linked to {assigned}</p>}</div><IconButton icon="link" label={`Link ${label} to ${taskId ?? 'task'}`} disabled={loading || operating || busy || !taskReady || awaitingSyncCount > 0 || !taskId || Boolean(assigned && assigned !== taskId)} onClick={() => { void run(async () => { await onLink(session); setView('current') }) }} /></section>
        })}
      </>}
      {view === 'create' && <AgentHostCreationControls taskId={taskId} taskReady={taskReady && awaitingSyncCount === 0} disabled={operating || busy} onCreated={created} />}
    </div>
  </aside>
}
