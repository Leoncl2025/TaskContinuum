import { useEffect, useId, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostHistoryTransfer, AgentHostSession } from '../../shared/agentHost'
import { sessionBindingTitle } from '../chat/sessionBindings'
import type { SessionBinding } from '../chat/sessionBindings'
import { MAX_SESSION_GROUP_NAME, moveSessionNode, ungroupSessions, visibleSessionLayout } from '../chat/sessionGroups'
import type { SessionDropTarget, SessionGroup, SessionGroupLayout, SessionGroupNode, SessionListEntry, SessionTreeNode } from '../chat/sessionGroups'
import { machineLabel, useMachineAliases } from '../machineAliases'
import { Icon, IconButton } from './Primitives'

const SESSION_DRAG_MIME = 'application/x-taskcontinuum-session-key'

export interface SessionExpandRequest {
  readonly key: string
  readonly id: number
}

interface Props {
  taskId: string
  entries: readonly SessionListEntry[]
  manualLayout: SessionGroupLayout
  activeKey?: string
  expandSession?: SessionExpandRequest
  sessions: readonly AgentHostSession[]
  cachedTitles?: Readonly<Record<string, string>>
  historyTransfers?: Readonly<Record<string, AgentHostHistoryTransfer>>
  unlinkDisabled: boolean
  onSelect?(binding: SessionBinding): void
  onLayoutChange?(layout: SessionGroupLayout, makeManual: boolean): void
  onUnlink?(binding: SessionBinding): void
}

interface VisibleRow {
  entry: SessionListEntry
  parent?: SessionGroupNode
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

function GroupNameEditor({ title, onFinish }: { title: string; onFinish(value: string | undefined, restoreFocus: boolean): void }) {
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  function finish(value: string | undefined, restoreFocus: boolean): void {
    if (finished.current) return
    finished.current = true
    onFinish(value, restoreFocus)
  }
  return <input ref={input} className="session-group-name-input" aria-label="Group name" maxLength={MAX_SESSION_GROUP_NAME} defaultValue={title}
    onBlur={(event) => finish(event.currentTarget.value, false)} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
      event.preventDefault()
      event.stopPropagation()
      finish(event.key === 'Enter' ? event.currentTarget.value : undefined, true)
    }} />
}

export function LinkedSessionTree({ taskId, entries, manualLayout, activeKey, expandSession, sessions, cachedTitles, historyTransfers, unlinkDisabled, onSelect, onLayoutChange, onUnlink }: Props) {
  const aliases = useMachineAliases()
  const [expansion, setExpansion] = useState(() => ({ keys: new Set(expandSession ? [expandSession.key] : []), request: expandSession?.id }))
  if (expandSession && expandSession.id !== expansion.request) {
    setExpansion({ keys: new Set([...expansion.keys, expandSession.key]), request: expandSession.id })
  }
  const [focused, setFocused] = useState<string>()
  const [editing, setEditing] = useState<string>()
  const [dragged, setDragged] = useState<string>()
  const [marker, setMarker] = useState<SessionDropTarget>()
  const [peekGroup, setPeekGroup] = useState<string>()
  const detailsPrefix = useId()
  const elements = useRef(new Map<string, HTMLLIElement>())
  const drag = useRef<{ key: string; groupId?: string } | undefined>(undefined)
  const suppressClick = useRef(false)
  const layout = visibleSessionLayout(entries)
  const canArrange = Boolean(onLayoutChange && (entries.length > 1 || entries.some((entry) => entry.kind === 'group' && entry.members.length > 1)))
  const isOpen = (group: SessionGroup) => !group.collapsed || peekGroup === group.id
  const rows = entries.flatMap((entry): VisibleRow[] => [
    { entry },
    ...(entry.kind === 'group' && isOpen(entry.group) ? entry.members.map((member) => ({ entry: member, parent: entry })) : []),
  ])
  const byKey = new Map(rows.map((row) => [row.entry.key, row]))
  const rowIndices = new Map(rows.map((row, index) => [row.entry.key, index]))
  const discoveredSessions = new Map(sessions.map((session) => [agentHostKey(session), session]))
  const activeParent = entries.find((entry) => entry.kind === 'group' && entry.members.some((member) => member.key === activeKey))
  const tabStop = focused && byKey.has(focused) ? focused
    : activeKey && byKey.has(activeKey) ? activeKey : activeParent?.key ?? rows[0]?.entry.key
  const hoverNode = marker?.position === 'into' ? byKey.get(marker.key)?.entry : undefined
  const springTarget = hoverNode?.kind === 'group' && hoverNode.group.collapsed && peekGroup !== hoverNode.key ? hoverNode.key : undefined
  useEffect(() => {
    if (!springTarget) return
    const timer = setTimeout(() => setPeekGroup(springTarget), 450)
    return () => clearTimeout(timer)
  }, [springTarget])

  function focus(key: string): void { setFocused(key); elements.current.get(key)?.focus() }
  function refFor(key: string) {
    return (element: HTMLLIElement | null) => { if (element) elements.current.set(key, element); else elements.current.delete(key) }
  }
  function showDetails(key: string, open: boolean): void {
    setExpansion((current) => {
      if (current.keys.has(key) === open) return current
      const keys = new Set(current.keys)
      if (open) keys.add(key)
      else keys.delete(key)
      return { ...current, keys }
    })
  }
  function editGroup(id: string, change: Partial<Pick<SessionGroup, 'title' | 'collapsed'>>): void {
    onLayoutChange?.({ ...manualLayout, groups: manualLayout.groups.map((group) => group.id === id ? { ...group, ...change } : group) }, false)
  }
  function toggleGroup(group: SessionGroup): void { focus(group.id); editGroup(group.id, { collapsed: !group.collapsed }) }
  function ungroup(node: SessionGroupNode): void {
    setEditing(undefined)
    onLayoutChange?.(ungroupSessions(manualLayout, node.key), false)
    const first = node.members[0]?.key
    if (first) requestAnimationFrame(() => focus(first))
  }
  function clearDrag(): void {
    drag.current = undefined
    setDragged(undefined)
    setMarker(undefined)
    setPeekGroup(undefined)
    if (suppressClick.current) setTimeout(() => { if (!drag.current) suppressClick.current = false }, 0)
  }
  function startDrag(event: DragEvent<HTMLDivElement>, entry: SessionListEntry): void {
    if (!canArrange || editing || !(event.target instanceof Element) || event.target.closest('.icon-button, input')) {
      event.preventDefault()
      return
    }
    const { key } = entry
    drag.current = { key, ...(entry.kind === 'session' ? { groupId: `grp:${crypto.randomUUID()}` } : {}) }
    suppressClick.current = true
    setDragged(key)
    setMarker(undefined)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(SESSION_DRAG_MIME, key)
      const rect = event.currentTarget.getBoundingClientRect()
      if (typeof event.dataTransfer.setDragImage === 'function' && rect.width && rect.height) {
        event.dataTransfer.setDragImage(event.currentTarget,
          Math.min(Math.max(0, event.clientX - rect.left), rect.width),
          Math.min(Math.max(0, event.clientY - rect.top), rect.height))
      }
    }
  }
  function resolveTarget(event: DragEvent<HTMLUListElement>, source: VisibleRow): SessionDropTarget | undefined {
    const hit = event.target instanceof Element ? event.target.closest<HTMLLIElement>('li[data-session-key]') : null
    const row = hit?.dataset.sessionKey ? byKey.get(hit.dataset.sessionKey) : undefined
    const movingGroup = source.entry.kind === 'group'
    if (row && hit) {
      if (movingGroup && row.parent) return { key: row.parent.key, position: 'after' }
      const key = row.entry.key
      if (key === source.entry.key) return undefined
      const rect = hit.firstElementChild?.getBoundingClientRect()
      const offset = rect?.height ? (event.clientY - rect.top) / rect.height : Number.NaN
      if (!Number.isFinite(offset)) {
        return { key, position: rows.indexOf(row) > rows.indexOf(source) ? 'after' : 'before' }
      }
      if (row.entry.kind !== 'group' || offset < 1) {
        if (offset >= 0.25 && offset < 0.75 && !movingGroup) {
          if (row.entry.kind === 'group') return source.parent?.key === key ? undefined : { key, position: 'into' }
          if (!row.parent) return { key, position: 'group' }
          if (row.parent !== source.parent) return { key, position: 'into' }
        }
        return { key, position: offset < 0.5 ? 'before' : 'after' }
      }
    }
    for (const candidate of rows) {
      const rect = elements.current.get(candidate.entry.key)?.firstElementChild?.getBoundingClientRect()
      if (rect?.height && event.clientY < rect.top) {
        return { key: movingGroup && candidate.parent ? candidate.parent.key : candidate.entry.key, position: 'before' }
      }
    }
    const last = entries.at(-1)
    return last && { key: last.key, position: 'after' }
  }
  function dragOver(event: DragEvent<HTMLUListElement>): void {
    const current = drag.current
    const source = current && byKey.get(current.key)
    if (!canArrange || !current || !source) return
    const target = resolveTarget(event, source)
    const targetRow = target && byKey.get(target.key)
    if (peekGroup && peekGroup !== targetRow?.parent?.key && peekGroup !== targetRow?.entry.key) setPeekGroup(undefined)
    const next = target && moveSessionNode(layout, current.key, target, current.groupId) ? target : undefined
    if (next) event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = next ? 'move' : 'none'
    setMarker((prior) => prior?.key === next?.key && prior?.position === next?.position ? prior : next)
  }
  function dragLeave(event: DragEvent<HTMLUListElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom) return
    setMarker(undefined)
    setPeekGroup(undefined)
  }
  function drop(event: DragEvent<HTMLUListElement>): void {
    const current = drag.current
    const source = current && byKey.get(current.key)
    if (!canArrange || !current || !source) return
    const target = resolveTarget(event, source)
    clearDrag()
    if (!target) return
    event.preventDefault()
    const next = moveSessionNode(layout, current.key, target, current.groupId)
    if (!next) return
    const nextGroups = peekGroup ? next.groups.map((group) =>
      group.id === peekGroup && group.memberKeys.includes(current.key) ? { ...group, collapsed: false } : group) : next.groups
    onLayoutChange?.({ ...next, groups: nextGroups }, true)
    if (target.position === 'group') setEditing(current.groupId)
  }

  function navigate(event: KeyboardEvent<HTMLLIElement>, row: VisibleRow): void {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return
    const { entry, parent } = row
    const { key } = entry
    if (event.altKey) {
      if (!canArrange || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      event.stopPropagation()
      const siblings = parent?.members ?? entries
      const up = event.key === 'ArrowUp'
      const other = siblings[siblings.findIndex((item) => item.key === key) + (up ? -1 : 1)]
      const next = other && moveSessionNode(layout, key, { key: other.key, position: up ? 'before' : 'after' })
      if (next) {
        onLayoutChange?.(next, true)
        requestAnimationFrame(() => focus(key))
      }
      return
    }
    const index = rows.indexOf(row)
    let destination: string | undefined
    switch (event.key) {
      case 'ArrowDown': destination = rows[index + 1]?.entry.key; break
      case 'ArrowUp': destination = rows[index - 1]?.entry.key; break
      case 'Home': destination = rows[0]?.entry.key; break
      case 'End': destination = rows.at(-1)?.entry.key; break
      case 'ArrowRight':
        if (entry.kind === 'session') showDetails(key, true)
        else if (isOpen(entry.group)) destination = entry.members[0]?.key
        else toggleGroup(entry.group)
        break
      case 'ArrowLeft':
        if (entry.kind === 'group') { if (isOpen(entry.group)) toggleGroup(entry.group) }
        else if (expansion.keys.has(key)) showDetails(key, false)
        else destination = parent?.key
        break
      case 'Enter':
      case ' ': if (entry.kind === 'group') toggleGroup(entry.group); else onSelect?.(entry.binding); break
      case 'F2': if (entry.kind === 'group' && onLayoutChange) setEditing(key); else return; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (destination) focus(destination)
  }

  function dropPosition(key: string) { return dragged && byKey.has(dragged) && marker?.key === key ? marker.position : undefined }
  function renderSession(node: SessionTreeNode, parent?: SessionGroupNode) {
    const { key, binding } = node
    const hostKey = agentHostKey(binding.agentHost)
    const discovered = discoveredSessions.get(hostKey)
    const cached = cachedTitles?.[hostKey]
    const label = cached || discovered?.title || sessionBindingTitle(binding)
    const progress = historyTransfers?.[hostKey]
    const transfer = progress && transferProgress(progress)
    const open = expansion.keys.has(key)
    const detailsId = `${detailsPrefix}-${rowIndices.get(key)}`
    const position = dropPosition(key)
    const dropHint = position === 'group' ? 'Create group' : position === 'into' ? 'Add to group' : undefined
    return <li key={key} role="treeitem" className="session-tree-item" data-session-key={key} data-drop={position}
      aria-label={label} aria-description={binding.id} aria-selected={key === activeKey} aria-expanded={open} aria-level={parent ? 2 : 1}
      tabIndex={tabStop === key ? 0 : -1} ref={refFor(key)}
      onFocus={(event) => { if (event.target === event.currentTarget) setFocused(key) }} onKeyDown={(event) => navigate(event, byKey.get(key)!)}>
      <div className={`session-tree-row ${key === activeKey ? 'is-selected' : ''}`} data-transferring={Boolean(transfer)}
        data-dragging={dragged === key || undefined} draggable={canArrange || undefined}
        onDragStart={(event) => startDrag(event, node)} onDragEnd={clearDrag}>
        {transfer && <progress className="session-transfer-mask" aria-label={`History transfer for ${label}`} max={100} value={transfer.value} aria-valuetext={transfer.description} />}
        {canArrange && <span className="session-drag-grip" aria-hidden="true"><Icon name="gripper" /></span>}
        <button type="button" tabIndex={-1} className="session-row" draggable={canArrange || undefined} aria-label={`Open ${label}`} title={label}
          onClick={() => { if (suppressClick.current) return; focus(key); onSelect?.(binding) }}>
          <strong title={cached && !discovered ? 'Last known title saved on this device' : undefined}>{label}</strong>
          {dropHint ? <span className="session-drop-hint"><Icon name="add" />{dropHint}</span>
            : transfer ? <span className="session-transfer-status" title={transfer.description}>
              <Icon name="loading" className="codicon-modifier-spin" /><span>{transfer.label}</span><strong>{transfer.percent}%</strong>
            </span> : <span className="session-machine" title={binding.owner.machineName}>{machineLabel(binding.owner, aliases)}</span>}
        </button>
        <IconButton icon={open ? 'chevron-up' : 'chevron-down'} label={`${open ? 'Hide' : 'Show'} details for ${label}`} tabIndex={-1} aria-expanded={open} aria-controls={open ? detailsId : undefined}
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
          <button type="button" className="secondary-button session-unlink-button" aria-label={`Unlink ${label}`} disabled={unlinkDisabled} onClick={() => onUnlink(binding)}>
            <Icon name="debug-disconnect" /><span>Unlink</span>
          </button>
        </div>}
      </div>}
    </li>
  }
  function renderGroup(node: SessionGroupNode) {
    const { key, group, members } = node
    const open = isOpen(group)
    const selected = !open && activeParent?.key === key
    const syncing = !open && members.filter(({ binding }) => historyTransfers?.[agentHostKey(binding.agentHost)]).length
    const renaming = editing === key
    const drop = dropPosition(key)
    const showGrip = canArrange && entries.length > 1
    const description = [`${members.length} ${members.length === 1 ? 'session' : 'sessions'}`, selected && 'Contains current session', syncing && `${syncing} syncing history`].filter(Boolean).join(' · ')
    return <li key={key} role="treeitem" className="session-tree-item session-group-item" data-session-key={key} data-drop={drop}
      aria-label={group.title} aria-description={description} aria-level={1} aria-expanded={open} aria-keyshortcuts={onLayoutChange ? 'F2' : undefined}
      tabIndex={tabStop === key ? 0 : -1} ref={refFor(key)} onFocus={(event) => { if (event.target === event.currentTarget) setFocused(key) }}
      onKeyDown={(event) => navigate(event, byKey.get(key)!)}>
      <div className="session-group-row" data-current={selected || undefined} data-dragging={dragged === key || undefined}
        draggable={showGrip && !renaming || undefined} onDragStart={(event) => startDrag(event, node)} onDragEnd={clearDrag}>
        {showGrip && <span className="session-drag-grip" aria-hidden="true"><Icon name="gripper" /></span>}
        {renaming ? <div className="session-group-edit">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <GroupNameEditor title={group.title} onFinish={(value, restoreFocus) => {
            setEditing(undefined)
            const title = value?.trim()
            if (title && title !== group.title) editGroup(key, { title })
            if (restoreFocus) requestAnimationFrame(() => focus(key))
          }} />
        </div> : <button type="button" className="session-group-toggle" tabIndex={-1}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${group.title}`} aria-expanded={open} title={group.title}
          onClick={() => { if (!suppressClick.current) toggleGroup(group) }}
          onDoubleClick={onLayoutChange ? () => setEditing(key) : undefined}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} /><span>{group.title}</span>
        </button>}
        {drop === 'into' ? <span className="session-drop-hint"><Icon name="add" />Add here</span> : <>
          {onLayoutChange && !renaming && <div className="session-group-actions">
            <IconButton icon="edit" label={`Rename group ${group.title}`} tabIndex={tabStop === key ? 0 : -1} onClick={() => setEditing(key)} />
            <IconButton icon="ungroup-by-ref-type" label={`Ungroup ${group.title}`} tabIndex={tabStop === key ? 0 : -1} onClick={() => ungroup(node)} />
          </div>}
          {selected && <span className="session-group-current-dot" aria-hidden="true" title="Contains current session" />}
          {!!syncing && <span className="session-group-sync" title={`${syncing} syncing history`}><Icon name="loading" className="codicon-modifier-spin" /></span>}
          <span className="session-group-count" aria-hidden="true">{members.length}</span>
        </>}
      </div>
      {open && <ul role="group" className="session-group-members">{members.map((member) => renderSession(member, node))}</ul>}
    </li>
  }

  return <ul role="tree" aria-label={`Sessions for ${taskId}`} aria-keyshortcuts={canArrange ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
    className="task-list task-tree session-tree" onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
    {entries.map((entry) => entry.kind === 'group' ? renderGroup(entry) : renderSession(entry))}
  </ul>
}
