import { Activity, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { agentHostKey } from '../../shared/agentHost'
import type { SessionWindowMode } from '../../shared/desktop'
import type { TaskRecord } from '../../shared/tasks'
import { sessionBindingKey, sessionBindingTitle } from '../chat/sessionBindings'
import type { SessionBinding, SessionBindings } from '../chat/sessionBindings'
import { SESSION_BINDING_DRAG_MIME } from './LinkedSessionTree'
import type { SessionTitleUpdate } from '../chat/useSessionTitles'
import type { SessionDraftStore } from '../chat/sessionDraftStore'
import { defaultLayout } from '../layout'
import type { SplitDirection } from '../layout'
import { machineLabel, useMachineAliases } from '../machineAliases'
import {
  closeTaskPageInGroup,
  findPaneGroup,
  findParentSplit,
  focusPaneGroup,
  listPaneGroups,
  MAX_PANE_GROUPS,
  moveOrDropTaskPage,
  openTaskPageInGroup,
  removePaneGroup,
  resizePaneSplit,
  resolveGroupActiveBinding,
  selectSessionInGroup,
  splitPaneGroup,
  swapParentSplitChildren,
  TASK_PAGE_DRAG_MIME,
  toggleParentSplitOrientation,
} from '../paneTree'
import type { PaneGroup, PaneTreeNode, PaneTreeState, TaskPageDragPayload } from '../paneTree'
import { AgentHostPanel } from './AgentHostPanel'
import { ChatSplitSash } from './PanelSash'
import { Icon, IconButton } from './Primitives'
import { SessionContextMenu } from './SessionContextMenu'
import type { SessionContextMenuTarget } from './SessionContextMenu'

let activeTaskPageDrag: TaskPageDragPayload | null = null

function hasDragMime(event: DragEvent<HTMLElement>, mime: string): boolean {
  return Array.from(event.dataTransfer.types).some((type) => type.toLowerCase() === mime.toLowerCase())
}

function isTaskPageDrag(event: DragEvent<HTMLElement>): boolean {
  return activeTaskPageDrag !== null || hasDragMime(event, TASK_PAGE_DRAG_MIME)
}

function isSessionBindingDrag(event: DragEvent<HTMLElement>): boolean {
  return hasDragMime(event, SESSION_BINDING_DRAG_MIME)
}

function readTaskPageDragPayload(event: DragEvent<HTMLElement>): TaskPageDragPayload | null {
  if (hasDragMime(event, TASK_PAGE_DRAG_MIME)) {
    try {
      const parsed = JSON.parse(event.dataTransfer.getData(TASK_PAGE_DRAG_MIME)) as Partial<TaskPageDragPayload>
      if (typeof parsed.sourceGroupId === 'string' && typeof parsed.taskId === 'string') {
        return {
          sourceGroupId: parsed.sourceGroupId,
          taskId: parsed.taskId,
          ...(parsed.sessionKey !== undefined ? { sessionKey: parsed.sessionKey } : {}),
          copy: Boolean(event.altKey || parsed.copy),
        }
      }
    } catch {
      // Fall back to in-window drag state.
    }
  }
  if (activeTaskPageDrag) {
    return { ...activeTaskPageDrag, copy: Boolean(event.altKey || activeTaskPageDrag.copy) }
  }
  return null
}

function computeDropZone(event: DragEvent<HTMLElement>, allowSplit: boolean): SplitDirection | 'center' {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (!allowSplit || !bounds.width || !bounds.height) return 'center'
  const nx = (event.clientX - bounds.left) / bounds.width
  const ny = (event.clientY - bounds.top) / bounds.height
  if (ny < 0.22) return 'up'
  if (ny > 0.78) return 'down'
  if (nx < 0.24) return 'left'
  if (nx > 0.76) return 'right'
  return 'center'
}

const paneGroupDomHosts = new Map<string, HTMLDivElement>()

function getOrCreateGroupDomHost(gridId: string, groupId: string): HTMLDivElement {
  const poolKey = `${gridId}::${groupId}`
  let host = paneGroupDomHosts.get(poolKey)
  if (!host) {
    if (paneGroupDomHosts.size >= 64) {
      for (const [oldestKey, oldestEl] of paneGroupDomHosts) {
        if (!oldestKey.startsWith(`${gridId}::`) && !oldestEl.isConnected) {
          paneGroupDomHosts.delete(oldestKey)
          break
        }
      }
    }
    host = document.createElement('div')
    host.className = 'pane-group-host'
    paneGroupDomHosts.set(poolKey, host)
  }
  return host
}

export interface PaneWorkspaceGridProps {
  readonly tree: PaneTreeState
  readonly onTreeChange: (updater: (current: PaneTreeState) => PaneTreeState) => void
  readonly tasks: readonly TaskRecord[]
  readonly bindings: SessionBindings
  readonly rememberedSessions?: Readonly<Record<string, string | null>>
  readonly orderedBindingsForTask: (taskId: string) => readonly SessionBinding[]
  readonly awaitingSyncCountForTask?: (taskId: string) => number
  readonly gitSyncError?: string
  readonly syncingLinks?: boolean
  readonly linksBusy?: boolean
  readonly linksReady?: boolean
  readonly workspaceAvailable?: boolean
  readonly theme: 'dark' | 'light'
  readonly compact?: boolean
  readonly isPopupWindow?: boolean
  readonly unifiedHeaderTarget?: HTMLElement | null
  readonly popupTabsTarget?: HTMLElement | null
  readonly connectionRevision?: number
  readonly cachedTitles: Readonly<Record<string, string>>
  readonly customTitles?: Readonly<Record<string, string>>
  readonly draftStore?: SessionDraftStore
  readonly restoredDrafts?: Readonly<Record<string, { readonly nonce: number; readonly text: string }>>
  readonly onTitles?: (sessions: readonly SessionTitleUpdate[]) => void
  readonly onRenameSession?: (target: SessionBinding['agentHost'], nextName: string | null) => void
  readonly onDraftSnapshot?: (groupId: string, taskId: string, sessionKey: string, draft: string) => void
  readonly onBusyChange?: (busy: boolean, panelKey?: string) => void
  readonly onPopOutTaskPage?: (request: {
    groupId: string
    taskId: string
    binding?: SessionBinding
    draft?: string
    mode: SessionWindowMode
  }) => Promise<boolean> | boolean
  readonly onBrowseSessions?: (groupId: string, taskId: string) => void
  readonly onOpenSessionDetach?: (taskId: string, binding: SessionBinding) => void
  readonly onSyncNow?: () => void
  readonly onOpenDevices?: () => void
  readonly onCloseSingleChat?: () => void
  readonly onTaskChatActivated?: () => void
}

export function PaneWorkspaceGrid({
  tree,
  onTreeChange,
  tasks,
  bindings,
  rememberedSessions,
  orderedBindingsForTask,
  awaitingSyncCountForTask,
  gitSyncError,
  syncingLinks = false,
  linksBusy = false,
  linksReady = true,
  workspaceAvailable = true,
  theme,
  compact = false,
  isPopupWindow = false,
  unifiedHeaderTarget,
  popupTabsTarget,
  connectionRevision = 0,
  cachedTitles,
  customTitles,
  draftStore,
  restoredDrafts,
  onTitles,
  onRenameSession,
  onDraftSnapshot,
  onBusyChange,
  onPopOutTaskPage,
  onBrowseSessions,
  onOpenSessionDetach,
  onSyncNow,
  onOpenDevices,
  onCloseSingleChat,
  onTaskChatActivated,
}: PaneWorkspaceGridProps) {
  const gridId = useId()
  const aliases = useMachineAliases()
  const groups = useMemo(() => listPaneGroups(tree.root), [tree.root])
  const isMultiGroup = groups.length > 1
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.id, item])), [tasks])
  const [contextMenu, setContextMenu] = useState<SessionContextMenuTarget | null>(null)

  const getGroupHost = useCallback((groupId: string): HTMLDivElement => {
    return getOrCreateGroupDomHost(gridId, groupId)
  }, [gridId])

  useEffect(() => {
    const prefix = `${gridId}::`
    const liveKeys = new Set(groups.map((group) => `${prefix}${group.id}`))
    for (const [poolKey, element] of paneGroupDomHosts) {
      if (poolKey.startsWith(prefix) && !liveKeys.has(poolKey)) {
        element.remove()
        paneGroupDomHosts.delete(poolKey)
      }
    }
  }, [gridId, groups])

  const activateGroup = useCallback((groupId: string) => {
    onTreeChange((current) => focusPaneGroup(current, groupId))
  }, [onTreeChange])

  const selectTaskInGroup = useCallback((groupId: string, taskId: string) => {
    onTreeChange((current) => openTaskPageInGroup(current, groupId, taskId))
    onTaskChatActivated?.()
  }, [onTreeChange, onTaskChatActivated])

  const closeTaskInGroup = useCallback((groupId: string, taskId: string) => {
    onTreeChange((current) => closeTaskPageInGroup(current, groupId, taskId))
  }, [onTreeChange])

  const handleSplit = useCallback((groupId: string, direction: SplitDirection, moveSource: boolean, explicitTaskId?: string, explicitSessionKey?: string | null) => {
    onTreeChange((current) => splitPaneGroup(current, groupId, direction, {
      ...(explicitTaskId !== undefined ? { taskId: explicitTaskId } : {}),
      ...(explicitSessionKey !== undefined ? { sessionKey: explicitSessionKey } : {}),
      moveTaskPage: moveSource,
    }))
    onTaskChatActivated?.()
  }, [onTreeChange, onTaskChatActivated])

  const handleDropTaskPage = useCallback((payload: TaskPageDragPayload, targetGroupId: string, zone: 'tab' | 'center' | SplitDirection, insertIndex?: number) => {
    onTreeChange((current) => moveOrDropTaskPage(current, payload, { targetGroupId, zone, insertIndex }))
    onTaskChatActivated?.()
  }, [onTreeChange, onTaskChatActivated])

  const handleDropSessionBinding = useCallback((taskId: string, sessionKey: string, targetGroupId: string, zone: 'center' | SplitDirection) => {
    if (!taskById.has(taskId)) return
    onTreeChange((current) => {
      if (zone === 'center') {
        return openTaskPageInGroup(current, targetGroupId, taskId, sessionKey)
      }
      return splitPaneGroup(current, targetGroupId, zone, { taskId, sessionKey })
    })
    onTaskChatActivated?.()
  }, [taskById, onTreeChange, onTaskChatActivated])

  const contextParentSplit = useMemo(
    () => contextMenu ? findParentSplit(tree.root, contextMenu.groupId) : undefined,
    [contextMenu, tree.root],
  )

  return <div className="pane-workspace-grid" data-multi-pane={isMultiGroup || undefined} data-popup-grid={isPopupWindow || undefined}>
    {compact && isMultiGroup && <div className="compact-split-switcher" role="tablist" aria-label="Screen panes">
      {groups.map((group, index) => {
        const activeTask = group.activeTaskId ? taskById.get(group.activeTaskId) : undefined
        return <button key={group.id} type="button" role="tab" aria-selected={group.id === tree.activeGroupId} onClick={() => activateGroup(group.id)}>
          <Icon name="layout-panel-left" />
          <span>{activeTask ? `${activeTask.title}` : `Pane ${index + 1}`}</span>
        </button>
      })}
      <IconButton icon="close" label="Close active split pane" onClick={() => onTreeChange((current) => removePaneGroup(current, current.activeGroupId))} />
    </div>}

    <div className="pane-tree-viewport">
      {compact && isMultiGroup ? (
        <PaneGroupFrame
          group={findPaneGroup(tree.root, tree.activeGroupId) ?? groups[0]}
          groupIndex={Math.max(0, groups.findIndex((item) => item.id === tree.activeGroupId))}
          totalGroups={groups.length}
          focused={true}
          taskById={taskById}
          bindings={bindings}
          rememberedSessions={rememberedSessions}
          orderedBindingsForTask={orderedBindingsForTask}
          isPopupWindow={isPopupWindow}
          popupTabsTarget={null}
          getGroupHost={getGroupHost}
          onActivateGroup={activateGroup}
          onSelectTask={selectTaskInGroup}
          onCloseTask={closeTaskInGroup}
          onCloseGroup={(groupId) => onTreeChange((current) => removePaneGroup(current, groupId))}
          onDropTaskPage={handleDropTaskPage}
          onDropSessionBinding={handleDropSessionBinding}
          onOpenContextMenu={setContextMenu}
        />
      ) : (
        <PaneTreeBranch
          node={tree.root}
          groups={groups}
          activeGroupId={tree.activeGroupId}
          taskById={taskById}
          bindings={bindings}
          rememberedSessions={rememberedSessions}
          orderedBindingsForTask={orderedBindingsForTask}
          isPopupWindow={isPopupWindow}
          popupTabsTarget={!isMultiGroup ? popupTabsTarget : null}
          getGroupHost={getGroupHost}
          onResizeSplit={(splitId, ratio) => onTreeChange((current) => resizePaneSplit(current, splitId, ratio))}
          onActivateGroup={activateGroup}
          onSelectTask={selectTaskInGroup}
          onCloseTask={closeTaskInGroup}
          onCloseGroup={(groupId) => onTreeChange((current) => removePaneGroup(current, groupId))}
          onDropTaskPage={handleDropTaskPage}
          onDropSessionBinding={handleDropSessionBinding}
          onOpenContextMenu={setContextMenu}
        />
      )}
    </div>

    {groups.map((group, groupIndex) => createPortal(
      <PaneGroupBody
        key={group.id}
        group={group}
        groupIndex={groupIndex}
        totalGroups={groups.length}
        groupFocused={group.id === tree.activeGroupId}
        parentSplit={findParentSplit(tree.root, group.id)}
        taskById={taskById}
        rememberedSessions={rememberedSessions}
        orderedBindingsForTask={orderedBindingsForTask}
        awaitingSyncCountForTask={awaitingSyncCountForTask}
        gitSyncError={gitSyncError}
        syncingLinks={syncingLinks}
        linksBusy={linksBusy}
        linksReady={linksReady}
        workspaceAvailable={workspaceAvailable}
        isPopupWindow={isPopupWindow}
        unifiedHeaderTarget={!isMultiGroup ? unifiedHeaderTarget : null}
        connectionRevision={connectionRevision}
        cachedTitles={cachedTitles}
        customTitles={customTitles}
        aliases={aliases}
        draftStore={draftStore}
        restoredDrafts={restoredDrafts}
        onTitles={onTitles}
        onRenameSession={onRenameSession}
        onDraftSnapshot={onDraftSnapshot}
        onBusyChange={onBusyChange}
        onActivateGroup={() => activateGroup(group.id)}
        onSelectSession={(taskId, sessionKey) => onTreeChange((current) => selectSessionInGroup(current, group.id, taskId, sessionKey))}
        onSplit={(direction, moveSource, taskId, sessionKey) => handleSplit(group.id, direction, moveSource, taskId, sessionKey)}
        onCloseGroup={() => {
          if (isMultiGroup) onTreeChange((current) => removePaneGroup(current, group.id))
          else onCloseSingleChat?.()
        }}
        onPopOut={onPopOutTaskPage ? (taskId, binding, draft, mode) => onPopOutTaskPage({ groupId: group.id, taskId, binding, draft, mode }) : undefined}
        onOpenContextMenu={setContextMenu}
        onBrowseSessions={onBrowseSessions ? (taskId) => { activateGroup(group.id); onBrowseSessions(group.id, taskId) } : undefined}
        onOpenSessionDetach={onOpenSessionDetach}
        onSyncNow={onSyncNow}
        onOpenDevices={onOpenDevices}
      />,
      getGroupHost(group.id),
      group.id,
    ))}

    {contextMenu && <SessionContextMenu
      target={contextMenu}
      theme={theme}
      splitActive={Boolean(contextParentSplit)}
      splitOrientation={contextParentSplit?.orientation ?? 'horizontal'}
      canSwap={Boolean(contextParentSplit)}
      allowOpenWindow={Boolean(onPopOutTaskPage)}
      onRename={contextMenu.beginRename}
      onResetName={contextMenu.binding && onRenameSession && customTitles?.[agentHostKey(contextMenu.binding.agentHost)]
        ? () => onRenameSession(contextMenu.binding!.agentHost, null)
        : undefined}
      onSplit={(direction, moveSource) => {
        const sessionKey = contextMenu.binding ? sessionBindingKey(contextMenu.binding) : undefined
        handleSplit(contextMenu.groupId, direction, moveSource, contextMenu.taskId, sessionKey)
      }}
      onToggleOrientation={() => onTreeChange((current) => toggleParentSplitOrientation(current, contextMenu.groupId))}
      onSwap={() => onTreeChange((current) => swapParentSplitChildren(current, contextMenu.groupId))}
      onCloseSplit={() => onTreeChange((current) => removePaneGroup(current, contextMenu.groupId))}
      onOpenWindow={onPopOutTaskPage ? (mode) => {
        const draftSnapshot = mode === 'move' ? contextMenu.getDraft?.() : undefined
        void Promise.resolve(onPopOutTaskPage({
          groupId: contextMenu.groupId,
          taskId: contextMenu.taskId,
          binding: contextMenu.binding,
          draft: draftSnapshot,
          mode,
        })).then((moved) => {
          if (moved && draftSnapshot !== undefined) contextMenu.clearDraft?.(draftSnapshot)
        })
      } : undefined}
      onClose={() => setContextMenu(null)}
    />}
  </div>
}

function PaneTreeBranch({
  node,
  groups,
  activeGroupId,
  taskById,
  bindings,
  rememberedSessions,
  orderedBindingsForTask,
  isPopupWindow,
  popupTabsTarget,
  getGroupHost,
  onResizeSplit,
  onActivateGroup,
  onSelectTask,
  onCloseTask,
  onCloseGroup,
  onDropTaskPage,
  onDropSessionBinding,
  onOpenContextMenu,
}: {
  readonly node: PaneTreeNode
  readonly groups: readonly PaneGroup[]
  readonly activeGroupId: string
  readonly taskById: ReadonlyMap<string, TaskRecord>
  readonly bindings: SessionBindings
  readonly rememberedSessions?: Readonly<Record<string, string | null>>
  readonly orderedBindingsForTask: (taskId: string) => readonly SessionBinding[]
  readonly isPopupWindow: boolean
  readonly popupTabsTarget?: HTMLElement | null
  readonly getGroupHost: (groupId: string) => HTMLDivElement
  readonly onResizeSplit: (splitId: string, ratio: number) => void
  readonly onActivateGroup: (groupId: string) => void
  readonly onSelectTask: (groupId: string, taskId: string) => void
  readonly onCloseTask: (groupId: string, taskId: string) => void
  readonly onCloseGroup: (groupId: string) => void
  readonly onDropTaskPage: (payload: TaskPageDragPayload, targetGroupId: string, zone: 'tab' | 'center' | SplitDirection, insertIndex?: number) => void
  readonly onDropSessionBinding: (taskId: string, sessionKey: string, targetGroupId: string, zone: 'center' | SplitDirection) => void
  readonly onOpenContextMenu: (target: SessionContextMenuTarget) => void
}) {
  if (node.kind === 'group') {
    const groupIndex = Math.max(0, groups.findIndex((item) => item.id === node.id))
    return <PaneGroupFrame
      group={node}
      groupIndex={groupIndex}
      totalGroups={groups.length}
      focused={node.id === activeGroupId}
      taskById={taskById}
      bindings={bindings}
      rememberedSessions={rememberedSessions}
      orderedBindingsForTask={orderedBindingsForTask}
      isPopupWindow={isPopupWindow}
      popupTabsTarget={popupTabsTarget}
      getGroupHost={getGroupHost}
      onActivateGroup={onActivateGroup}
      onSelectTask={onSelectTask}
      onCloseTask={onCloseTask}
      onCloseGroup={onCloseGroup}
      onDropTaskPage={onDropTaskPage}
      onDropSessionBinding={onDropSessionBinding}
      onOpenContextMenu={onOpenContextMenu}
    />
  }

  return <div
    className="pane-split-node"
    data-split-id={node.id}
    data-orientation={node.orientation}
    style={{ '--split-first-grow': node.ratio, '--split-second-grow': 1 - node.ratio } as CSSProperties}
  >
    <div className="pane-split-child pane-split-first">
      <PaneTreeBranch
        node={node.first}
        groups={groups}
        activeGroupId={activeGroupId}
        taskById={taskById}
        bindings={bindings}
        rememberedSessions={rememberedSessions}
        orderedBindingsForTask={orderedBindingsForTask}
        isPopupWindow={isPopupWindow}
        popupTabsTarget={null}
        getGroupHost={getGroupHost}
        onResizeSplit={onResizeSplit}
        onActivateGroup={onActivateGroup}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onCloseGroup={onCloseGroup}
        onDropTaskPage={onDropTaskPage}
        onDropSessionBinding={onDropSessionBinding}
        onOpenContextMenu={onOpenContextMenu}
      />
    </div>
    <ChatSplitSash
      ratio={node.ratio}
      orientation={node.orientation}
      onResize={(ratio) => onResizeSplit(node.id, ratio)}
      onReset={() => onResizeSplit(node.id, defaultLayout.splitRatio)}
    />
    <div className="pane-split-child pane-split-second">
      <PaneTreeBranch
        node={node.second}
        groups={groups}
        activeGroupId={activeGroupId}
        taskById={taskById}
        bindings={bindings}
        rememberedSessions={rememberedSessions}
        orderedBindingsForTask={orderedBindingsForTask}
        isPopupWindow={isPopupWindow}
        popupTabsTarget={null}
        getGroupHost={getGroupHost}
        onResizeSplit={onResizeSplit}
        onActivateGroup={onActivateGroup}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onCloseGroup={onCloseGroup}
        onDropTaskPage={onDropTaskPage}
        onDropSessionBinding={onDropSessionBinding}
        onOpenContextMenu={onOpenContextMenu}
      />
    </div>
  </div>
}

function PaneGroupFrame({
  group,
  groupIndex,
  totalGroups,
  focused,
  taskById,
  bindings,
  rememberedSessions,
  orderedBindingsForTask,
  isPopupWindow,
  popupTabsTarget,
  getGroupHost,
  onActivateGroup,
  onSelectTask,
  onCloseTask,
  onCloseGroup,
  onDropTaskPage,
  onDropSessionBinding,
  onOpenContextMenu,
}: {
  readonly group: PaneGroup
  readonly groupIndex: number
  readonly totalGroups: number
  readonly focused: boolean
  readonly taskById: ReadonlyMap<string, TaskRecord>
  readonly bindings: SessionBindings
  readonly rememberedSessions?: Readonly<Record<string, string | null>>
  readonly orderedBindingsForTask: (taskId: string) => readonly SessionBinding[]
  readonly isPopupWindow: boolean
  readonly popupTabsTarget?: HTMLElement | null
  readonly getGroupHost: (groupId: string) => HTMLDivElement
  readonly onActivateGroup: (groupId: string) => void
  readonly onSelectTask: (groupId: string, taskId: string) => void
  readonly onCloseTask: (groupId: string, taskId: string) => void
  readonly onCloseGroup: (groupId: string) => void
  readonly onDropTaskPage: (payload: TaskPageDragPayload, targetGroupId: string, zone: 'tab' | 'center' | SplitDirection, insertIndex?: number) => void
  readonly onDropSessionBinding: (taskId: string, sessionKey: string, targetGroupId: string, zone: 'center' | SplitDirection) => void
  readonly onOpenContextMenu: (target: SessionContextMenuTarget) => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const [dropZone, setDropZone] = useState<SplitDirection | 'center'>()
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null)
  const isMultiGroup = totalGroups > 1

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    const host = getGroupHost(group.id)
    if (host.parentNode !== slot) slot.appendChild(host)
  }, [group.id, getGroupHost])

  const openItems = useMemo(
    () => group.openTaskIds.map((id) => taskById.get(id)).filter((item): item is TaskRecord => Boolean(item)),
    [group.openTaskIds, taskById],
  )
  const canSplitMore = totalGroups < MAX_PANE_GROUPS

  function calculateTabInsertIndex(clientX: number): number {
    const container = tabsRef.current
    if (!container) return openItems.length
    const tabNodes = Array.from(container.querySelectorAll<HTMLElement>(':scope > .editor-tab'))
    for (let i = 0; i < tabNodes.length; i++) {
      const rect = tabNodes[i].getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return i
    }
    return tabNodes.length
  }

  function onTabBarDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!isTaskPageDrag(event) && !isSessionBindingDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move'
    const idx = calculateTabInsertIndex(event.clientX)
    setTabDropIndex((current) => current === idx ? current : idx)
  }

  function onTabBarDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setTabDropIndex(null)
  }

  function onTabBarDrop(event: DragEvent<HTMLDivElement>): void {
    const insertAt = tabDropIndex ?? calculateTabInsertIndex(event.clientX)
    setTabDropIndex(null)
    if (isTaskPageDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      const payload = readTaskPageDragPayload(event)
      activeTaskPageDrag = null
      if (payload) onDropTaskPage(payload, group.id, 'tab', insertAt)
      return
    }
    if (isSessionBindingDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      try {
        const parsed = JSON.parse(event.dataTransfer.getData(SESSION_BINDING_DRAG_MIME)) as { taskId?: string; key?: string }
        if (parsed.taskId && parsed.key) onDropSessionBinding(parsed.taskId, parsed.key, group.id, 'center')
      } catch {
        // Ignore malformed drag data.
      }
    }
  }

  function onBodyDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!isTaskPageDrag(event) && !isSessionBindingDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move'
    const allowSplit = Boolean(group.activeTaskId) && (canSplitMore || (activeTaskPageDrag !== null && activeTaskPageDrag.sourceGroupId !== group.id))
    const zone = computeDropZone(event, allowSplit)
    setDropZone((current) => current === zone ? current : zone)
  }

  function onBodyDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom) return
    setDropZone(undefined)
  }

  function onBodyDrop(event: DragEvent<HTMLDivElement>): void {
    const zone = dropZone ?? 'center'
    setDropZone(undefined)
    if (isTaskPageDrag(event)) {
      event.preventDefault()
      const payload = readTaskPageDragPayload(event)
      activeTaskPageDrag = null
      if (payload) onDropTaskPage(payload, group.id, zone)
      return
    }
    if (isSessionBindingDrag(event)) {
      event.preventDefault()
      try {
        const parsed = JSON.parse(event.dataTransfer.getData(SESSION_BINDING_DRAG_MIME)) as { taskId?: string; key?: string }
        if (!parsed.taskId || !parsed.key) return
        const exists = (bindings[parsed.taskId] ?? []).some((item) => sessionBindingKey(item) === parsed.key)
        if (!exists) return
        onDropSessionBinding(parsed.taskId, parsed.key, group.id, zone)
      } catch {
        // Ignore malformed drag data.
      }
    }
  }

  function openTabContextMenu(event: ReactMouseEvent<HTMLElement>, taskId: string): void {
    event.preventDefault()
    event.stopPropagation()
    onActivateGroup(group.id)
    const ordered = orderedBindingsForTask(taskId)
    const { binding } = resolveGroupActiveBinding(group, taskId, ordered, rememberedSessions)
    onOpenContextMenu({
      x: event.clientX,
      y: event.clientY,
      groupId: group.id,
      taskId,
      binding,
    })
  }

  const tablistLabel = isMultiGroup ? `Pane ${groupIndex + 1} task pages` : 'Open tasks'

  const canCloseTab = !isPopupWindow || isMultiGroup || openItems.length > 1
  const tabsBar = (
    <div
      ref={tabsRef}
      className="editor-tabs"
      role="tablist"
      aria-label={tablistLabel}
      aria-keyshortcuts={!isMultiGroup || focused ? 'Control+PageUp Control+PageDown' : undefined}
      data-tab-drop={tabDropIndex !== null || undefined}
      onDragOver={onTabBarDragOver}
      onDragLeave={onTabBarDragLeave}
      onDrop={onTabBarDrop}
    >
      {openItems.map((item, index) => {
        const selected = item.id === group.activeTaskId
        const dropBefore = tabDropIndex === index
        const dropAfter = index === openItems.length - 1 && tabDropIndex !== null && tabDropIndex >= openItems.length
        return <div
          key={item.id}
          className={`editor-tab ${selected ? 'selected' : ''}`}
          data-task-id={item.id}
          data-drop-before={dropBefore || undefined}
          data-drop-after={dropAfter || undefined}
          draggable={true}
          onDragStart={(event) => {
            const ordered = orderedBindingsForTask(item.id)
            const { sessionKey } = resolveGroupActiveBinding(group, item.id, ordered, rememberedSessions)
            const payload: TaskPageDragPayload = {
              sourceGroupId: group.id,
              taskId: item.id,
              ...(sessionKey !== undefined ? { sessionKey } : {}),
            }
            activeTaskPageDrag = payload
            event.dataTransfer.effectAllowed = 'copyMove'
            event.dataTransfer.setData(TASK_PAGE_DRAG_MIME, JSON.stringify(payload))
            event.dataTransfer.setData('text/plain', `${item.id} ${item.title}`)
          }}
          onDragEnd={() => {
            activeTaskPageDrag = null
            setTabDropIndex(null)
            setDropZone(undefined)
          }}
          onAuxClick={canCloseTab ? (event) => {
            if (event.button === 1) {
              event.preventDefault()
              onCloseTask(group.id, item.id)
            }
          } : undefined}
          onContextMenu={(event) => openTabContextMenu(event, item.id)}
        >
          <button
            type="button"
            role="tab"
            title={item.title}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelectTask(group.id, item.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault()
                const next = (index + (event.key === 'ArrowRight' ? 1 : openItems.length - 1)) % openItems.length
                onSelectTask(group.id, openItems[next].id)
                const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                buttons?.[next]?.focus()
              }
            }}
          >
            <Icon name={item.kind === 'epic' ? 'layers' : 'file-text'} />
            <span>{item.title}</span>
          </button>
          {canCloseTab && <IconButton icon="close" label={`Close ${item.title}`} onClick={() => onCloseTask(group.id, item.id)} />}
        </div>
      })}

      {isMultiGroup && !openItems.length && (
        <div className="editor-tabs-actions">
          <IconButton icon="close" label="Close empty split pane" onClick={() => onCloseGroup(group.id)} />
        </div>
      )}
    </div>
  )

  return <section
    className="pane-group-unit"
    data-group-id={group.id}
    data-pane-index={groupIndex}
    data-pane-focused={isMultiGroup ? focused || undefined : undefined}
    aria-label={isMultiGroup ? `Screen pane ${groupIndex + 1}` : undefined}
    onPointerDownCapture={isMultiGroup && !focused ? () => onActivateGroup(group.id) : undefined}
    onFocusCapture={isMultiGroup && !focused ? () => onActivateGroup(group.id) : undefined}
  >
    {popupTabsTarget ? createPortal(tabsBar, popupTabsTarget) : tabsBar}

    <div
      ref={slotRef}
      className="pane-group-slot"
      onDragOver={onBodyDragOver}
      onDragLeave={onBodyDragLeave}
      onDrop={onBodyDrop}
    >
      {dropZone && <div className="chat-drop-overlay" data-zone={dropZone} aria-hidden="true">
        <div className="chat-drop-badge">
          <Icon name={dropZone === 'up' || dropZone === 'down' ? 'split-vertical' : dropZone === 'left' || dropZone === 'right' ? 'split-horizontal' : 'files'} />
          <span>{dropZone === 'up' ? 'Split Up' : dropZone === 'down' ? 'Split Down' : dropZone === 'left' ? 'Split Left' : dropZone === 'right' ? 'Split Right' : 'Move Task Page Here'}</span>
        </div>
      </div>}
    </div>
  </section>
}

const MountedChatPanel = memo(function MountedChatPanel({
  groupId,
  panelKey,
  task,
  binding,
  sessionKey,
  slot,
  splitOrientation,
  closeLabel,
  hideClose,
  minimalHeader,
  initialDraft,
  restoredDraft,
  headerTarget,
  cachedTitle,
  customTitle,
  visible,
  active,
  connectionRevision,
  isMultiGroup,
  canSplitMore,
  onTitles,
  onRenameSession,
  onDraftSnapshot,
  onActivateGroup,
  onSplit,
  onPopOut,
  onOpenContextMenu,
  onOpenSessionDetach,
  onCloseGroup,
  onOpenDevices,
  onBrowseSessions,
  onBusyChange,
}: {
  readonly groupId: string
  readonly panelKey: string
  readonly task: TaskRecord
  readonly binding: SessionBinding
  readonly sessionKey: string
  readonly slot: 'single' | 'primary' | 'secondary'
  readonly splitOrientation: 'horizontal' | 'vertical'
  readonly closeLabel: string
  readonly hideClose: boolean
  readonly minimalHeader: boolean
  readonly initialDraft?: string
  readonly restoredDraft?: { readonly nonce: number; readonly text: string }
  readonly headerTarget?: HTMLElement | null
  readonly cachedTitle?: string
  readonly customTitle?: string
  readonly visible: boolean
  readonly active: boolean
  readonly connectionRevision: number
  readonly isMultiGroup: boolean
  readonly canSplitMore: boolean
  readonly onTitles?: (sessions: readonly SessionTitleUpdate[]) => void
  readonly onRenameSession?: (target: SessionBinding['agentHost'], nextName: string | null) => void
  readonly onDraftSnapshot?: (groupId: string, taskId: string, sessionKey: string, draft: string) => void
  readonly onActivateGroup: () => void
  readonly onSplit: (direction: SplitDirection, moveSource: boolean, taskId?: string, sessionKey?: string | null) => void
  readonly onPopOut?: (taskId: string, binding: SessionBinding | undefined, draft: string | undefined, mode: SessionWindowMode) => Promise<boolean> | boolean
  readonly onOpenContextMenu: (target: SessionContextMenuTarget) => void
  readonly onOpenSessionDetach?: (taskId: string, binding: SessionBinding) => void
  readonly onCloseGroup: () => void
  readonly onOpenDevices?: () => void
  readonly onBrowseSessions?: (taskId: string) => void
  readonly onBusyChange?: (busy: boolean, panelKey?: string) => void
}) {
  const handleRenameTitle = useCallback(
    (nextName: string | null) => onRenameSession?.(binding.agentHost, nextName),
    [onRenameSession, binding.agentHost],
  )
  const handleDraftChange = useCallback(
    (value: string) => onDraftSnapshot?.(groupId, task.id, sessionKey, value),
    [onDraftSnapshot, groupId, task.id, sessionKey],
  )
  const handleSplitRight = useCallback(
    () => onSplit('right', false, task.id, sessionKey),
    [onSplit, task.id, sessionKey],
  )
  const handleSplitDown = useCallback(
    () => onSplit('down', false, task.id, sessionKey),
    [onSplit, task.id, sessionKey],
  )
  const handlePopOut = useCallback(
    (draft: string) => onPopOut?.(task.id, binding, draft, 'move'),
    [onPopOut, task.id, binding],
  )
  const handleHeaderContextMenu = useCallback(
    (anchor: { x: number; y: number }, getDraft: () => string, clearDraft: (snapshot: string) => void, beginRename?: () => void) => {
      onOpenContextMenu({
        x: anchor.x,
        y: anchor.y,
        groupId,
        taskId: task.id,
        binding,
        getDraft,
        clearDraft,
        beginRename,
      })
    },
    [onOpenContextMenu, groupId, task.id, binding],
  )
  const handleDetach = useCallback(() => {
    if (onOpenSessionDetach) onOpenSessionDetach(task.id, binding)
    else onCloseGroup()
  }, [onOpenSessionDetach, onCloseGroup, task.id, binding])
  const handleSessions = useCallback(
    () => onBrowseSessions?.(task.id),
    [onBrowseSessions, task.id],
  )

  return <AgentHostPanel
    task={task}
    target={binding.agentHost}
    paneSlot={slot}
    splitOrientation={splitOrientation}
    showTaskBadge={false}
    minimalHeader={minimalHeader}
    closeLabel={closeLabel}
    hideClose={hideClose}
    initialDraft={initialDraft}
    restoredDraft={restoredDraft}
    headerTarget={headerTarget}
    cachedTitle={cachedTitle}
    customTitle={customTitle}
    onTitles={onTitles}
    onRenameTitle={onRenameSession ? handleRenameTitle : undefined}
    onDraftChange={onDraftSnapshot ? handleDraftChange : undefined}
    visible={visible}
    active={active}
    connectionRevision={connectionRevision}
    onActivatePane={isMultiGroup ? onActivateGroup : undefined}
    onSplitRight={!isMultiGroup && canSplitMore ? handleSplitRight : undefined}
    onSplitDown={!isMultiGroup && canSplitMore ? handleSplitDown : undefined}
    onPopOut={onPopOut ? handlePopOut : undefined}
    onHeaderContextMenu={handleHeaderContextMenu}
    onDetach={handleDetach}
    onClose={onCloseGroup}
    onDevices={onOpenDevices}
    onSessions={onBrowseSessions ? handleSessions : undefined}
    panelKey={panelKey}
    onBusy={onBusyChange}
  />
})

function PaneGroupBody({
  group,
  groupIndex,
  totalGroups,
  groupFocused,
  parentSplit,
  taskById,
  rememberedSessions,
  orderedBindingsForTask,
  awaitingSyncCountForTask,
  gitSyncError,
  syncingLinks,
  linksBusy,
  linksReady,
  workspaceAvailable,
  isPopupWindow,
  unifiedHeaderTarget,
  connectionRevision,
  cachedTitles,
  customTitles,
  aliases,
  draftStore,
  restoredDrafts,
  onTitles,
  onRenameSession,
  onDraftSnapshot,
  onBusyChange,
  onActivateGroup,
  onSelectSession,
  onSplit,
  onCloseGroup,
  onPopOut,
  onOpenContextMenu,
  onBrowseSessions,
  onOpenSessionDetach,
  onSyncNow,
  onOpenDevices,
}: {
  readonly group: PaneGroup
  readonly groupIndex: number
  readonly totalGroups: number
  readonly groupFocused: boolean
  readonly parentSplit: ReturnType<typeof findParentSplit>
  readonly taskById: ReadonlyMap<string, TaskRecord>
  readonly rememberedSessions?: Readonly<Record<string, string | null>>
  readonly orderedBindingsForTask: (taskId: string) => readonly SessionBinding[]
  readonly awaitingSyncCountForTask?: (taskId: string) => number
  readonly gitSyncError?: string
  readonly syncingLinks: boolean
  readonly linksBusy: boolean
  readonly linksReady: boolean
  readonly workspaceAvailable: boolean
  readonly isPopupWindow: boolean
  readonly unifiedHeaderTarget?: HTMLElement | null
  readonly connectionRevision: number
  readonly cachedTitles: Readonly<Record<string, string>>
  readonly customTitles?: Readonly<Record<string, string>>
  readonly aliases: Readonly<Record<string, string>>
  readonly draftStore?: SessionDraftStore
  readonly restoredDrafts?: Readonly<Record<string, { readonly nonce: number; readonly text: string }>>
  readonly onTitles?: (sessions: readonly SessionTitleUpdate[]) => void
  readonly onRenameSession?: (target: SessionBinding['agentHost'], nextName: string | null) => void
  readonly onDraftSnapshot?: (groupId: string, taskId: string, sessionKey: string, draft: string) => void
  readonly onBusyChange?: (busy: boolean, panelKey?: string) => void
  readonly onActivateGroup: () => void
  readonly onSelectSession: (taskId: string, sessionKey: string) => void
  readonly onSplit: (direction: SplitDirection, moveSource: boolean, taskId?: string, sessionKey?: string | null) => void
  readonly onCloseGroup: () => void
  readonly onPopOut?: (taskId: string, binding: SessionBinding | undefined, draft: string | undefined, mode: SessionWindowMode) => Promise<boolean> | boolean
  readonly onOpenContextMenu: (target: SessionContextMenuTarget) => void
  readonly onBrowseSessions?: (taskId: string) => void
  readonly onOpenSessionDetach?: (taskId: string, binding: SessionBinding) => void
  readonly onSyncNow?: () => void
  readonly onOpenDevices?: () => void
}) {
  const isMultiGroup = totalGroups > 1
  const canSplitMore = totalGroups < MAX_PANE_GROUPS
  const activeTask = group.activeTaskId && group.openTaskIds.includes(group.activeTaskId)
    ? taskById.get(group.activeTaskId)
    : undefined
  const activeTaskBindings = useMemo(
    () => activeTask ? orderedBindingsForTask(activeTask.id) : [],
    [activeTask, orderedBindingsForTask],
  )
  const { binding: activeBinding, missingSelectedSession } = useMemo(
    () => resolveGroupActiveBinding(group, activeTask?.id ?? null, activeTaskBindings, rememberedSessions, linksReady),
    [group, activeTask, activeTaskBindings, rememberedSessions, linksReady],
  )
  const activeLocalKey = activeTask && activeBinding ? `${activeTask.id}:${sessionBindingKey(activeBinding)}` : undefined

  const [visitedKeys, setVisitedKeys] = useState<string[]>(() => activeLocalKey ? [activeLocalKey] : [])
  if (activeLocalKey && !visitedKeys.includes(activeLocalKey)) {
    setVisitedKeys((current) => current.includes(activeLocalKey) ? current : [...current, activeLocalKey])
  }

  const mountedPanels = useMemo(() => {
    const keys = activeLocalKey && !visitedKeys.includes(activeLocalKey) ? [...visitedKeys, activeLocalKey] : visitedKeys
    const resolved: { localKey: string; panelKey: string; task: TaskRecord; binding: SessionBinding; sessionKey: string }[] = []
    for (const localKey of keys) {
      const separator = localKey.indexOf(':')
      if (separator <= 0) continue
      const taskId = localKey.slice(0, separator)
      const task = taskById.get(taskId)
      if (!task) continue
      const sessionKey = localKey.slice(separator + 1)
      const binding = orderedBindingsForTask(taskId).find((entry) => sessionBindingKey(entry) === sessionKey)
      if (!binding) continue
      resolved.push({ localKey, panelKey: `${group.id}:${localKey}`, task, binding, sessionKey })
    }
    return resolved
  }, [visitedKeys, activeLocalKey, group.id, taskById, orderedBindingsForTask])

  const awaitingSyncCount = activeTask && awaitingSyncCountForTask ? awaitingSyncCountForTask(activeTask.id) : 0

  const handleCloseGroup = useCallback(() => {
    onCloseGroup()
  }, [onCloseGroup])

  return <>
    {mountedPanels.map((panel) => {
      const visible = panel.localKey === activeLocalKey
      const slot: 'single' | 'primary' | 'secondary' = !isMultiGroup ? 'single' : groupIndex === 0 ? 'primary' : 'secondary'
      const panelDraft = restoredDrafts?.[panel.panelKey]
      const localDraft = restoredDrafts?.[panel.localKey]
      const draftLookup = panelDraft && localDraft
        ? (panelDraft.nonce >= localDraft.nonce ? panelDraft : localDraft)
        : (panelDraft ?? localDraft)
      const initialDraft = draftStore?.readInitial(panel.panelKey, panel.localKey)
      return <Activity key={panel.panelKey} mode={visible ? 'visible' : 'hidden'}>
        <MountedChatPanel
          groupId={group.id}
          panelKey={panel.panelKey}
          task={panel.task}
          binding={panel.binding}
          sessionKey={panel.sessionKey}
          slot={slot}
          splitOrientation={parentSplit?.orientation ?? 'horizontal'}
          closeLabel={isMultiGroup ? 'Close split pane' : 'Hide chat panel'}
          hideClose={isPopupWindow && !isMultiGroup}
          minimalHeader={isPopupWindow}
          initialDraft={initialDraft}
          restoredDraft={draftLookup}
          headerTarget={!isMultiGroup && unifiedHeaderTarget ? unifiedHeaderTarget : undefined}
          cachedTitle={cachedTitles[agentHostKey(panel.binding.agentHost)]}
          customTitle={customTitles?.[agentHostKey(panel.binding.agentHost)]}
          visible={visible}
          active={visible && groupFocused}
          connectionRevision={connectionRevision}
          isMultiGroup={isMultiGroup}
          canSplitMore={canSplitMore}
          onTitles={onTitles}
          onRenameSession={onRenameSession}
          onDraftSnapshot={onDraftSnapshot}
          onActivateGroup={onActivateGroup}
          onSplit={onSplit}
          onPopOut={onPopOut}
          onOpenContextMenu={onOpenContextMenu}
          onOpenSessionDetach={onOpenSessionDetach}
          onCloseGroup={handleCloseGroup}
          onOpenDevices={onOpenDevices}
          onBrowseSessions={onBrowseSessions}
          onBusyChange={onBusyChange}
        />
      </Activity>
    })}

    {!activeBinding && (
      <aside
        className="chat-panel empty-chat"
        data-pane-slot={isMultiGroup ? (groupIndex === 0 ? 'primary' : 'secondary') : undefined}
        aria-label={isMultiGroup ? `Screen pane ${groupIndex + 1} task chat` : 'Task chat'}
        onPointerDownCapture={isMultiGroup ? onActivateGroup : undefined}
      >
        <header
          className="panel-header"
          onContextMenu={activeTask ? (event) => {
            event.preventDefault()
            onActivateGroup()
            onOpenContextMenu({ x: event.clientX, y: event.clientY, groupId: group.id, taskId: activeTask.id })
          } : undefined}
        >
          <span>AGENT HOST</span>
          <div className="panel-header-actions">
            {activeTask && canSplitMore && (
              <IconButton icon="split-horizontal" label="Split chat right" title="Split chat right (Ctrl+\) · Alt+Click to split down" onClick={(event) => onSplit(event.altKey ? 'down' : 'right', false, activeTask.id, null)} />
            )}
            {(!isPopupWindow || isMultiGroup) && (
              <IconButton icon="close" label={isMultiGroup ? 'Close split pane' : 'Hide chat panel'} onClick={onCloseGroup} />
            )}
          </div>
        </header>
        <div className="chat-context">
          <Icon name="server-environment" />
          <div>
            <strong>{activeTask?.title ?? 'Native Agent Host chats'}</strong>
            <span>{activeTask?.id ?? 'No task selected'}</span>
          </div>
        </div>
        <div className="empty-workbench">
          <span className="chat-welcome-icon"><Icon name={activeTask && awaitingSyncCount > 0 ? 'sync' : 'comment-discussion'} /></span>
          {activeTask && awaitingSyncCount > 0 ? <>
            <h2>Session links waiting for Git sync</h2>
            <p role="status">{activeTaskBindings.length
              ? `A remote session binding change for ${activeTask.id} is waiting for the publishing device to finish Git synchronization. ${activeTaskBindings.length} confirmed ${activeTaskBindings.length === 1 ? 'session remains' : 'sessions remain'} available in the Agent Host sessions sidebar.`
              : `A remote session binding change for ${activeTask.id} is waiting for the publishing device to finish Git synchronization. Existing links were not deleted; inspect or cancel pending changes in Remote devices if the publishing device is unavailable.`}</p>
            {gitSyncError && <p className="copilot-error" role="alert">{gitSyncError}</p>}
            <div className="workspace-welcome-actions">
              {onSyncNow && <button type="button" className="secondary-button" disabled={linksBusy || syncingLinks} onClick={onSyncNow}><Icon name="sync" /><span>{syncingLinks ? 'Syncing...' : 'Sync now'}</span></button>}
              {workspaceAvailable && onOpenDevices && <button type="button" className="secondary-button" onClick={onOpenDevices}><Icon name="remote" /><span>Remote devices</span></button>}
              {workspaceAvailable && onBrowseSessions && <button type="button" className="primary-button" disabled={linksBusy} onClick={() => onBrowseSessions(activeTask.id)}>Browse Agent Host sessions</button>}
            </div>
          </> : <>
            <h2>{activeTask ? 'Keep the conversation moving' : 'Your task conversations, front and center'}</h2>
            <p>{!activeTask
              ? 'Select a task to open its Agent Host chat.'
              : activeTaskBindings.length
                ? isPopupWindow
                  ? `Choose one of the linked sessions for ${activeTask.id} below.`
                  : `Choose a linked session for ${activeTask.id} in the Agent Host sessions sidebar.`
                : `No Agent Host chat is linked to ${activeTask.id}. ${isPopupWindow && !linksReady ? 'Loading workspace session links...' : isPopupWindow ? 'Dock to the main window to link or create one.' : 'Link an existing chat or create one from the Agent Host sessions sidebar.'}`}</p>
            {missingSelectedSession && <p role="status">The last selected session is no longer linked to this task. Choose a current session; no replacement was opened.</p>}
            {isPopupWindow && activeTask && activeTaskBindings.length > 0 && (
              <div className="split-picker-candidates" aria-label="Linked sessions">
                <div className="split-picker-list">
                  {activeTaskBindings.map((candidate) => {
                    const key = sessionBindingKey(candidate)
                    return <button key={key} type="button" className="secondary-button split-picker-chip" onClick={() => onSelectSession(activeTask.id, key)}>
                      <Icon name="copilot" />
                      <span>{sessionBindingTitle(candidate, cachedTitles)}</span>
                      <small>{machineLabel(candidate.owner, aliases)}</small>
                    </button>
                  })}
                </div>
              </div>
            )}
            <p className="muted">Local SDK and Companion sessions are not supported. Existing session data is left untouched.</p>
            {activeTask && workspaceAvailable && onBrowseSessions && (
              <button type="button" className="primary-button" disabled={linksBusy} onClick={() => onBrowseSessions(activeTask.id)}>Browse Agent Host sessions</button>
            )}
          </>}
        </div>
      </aside>
    )}
  </>
}
