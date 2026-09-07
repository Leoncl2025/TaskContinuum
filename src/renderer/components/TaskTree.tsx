import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TaskTreeNode } from '../../shared/taskTree'
import { statusLabels } from '../../shared/tasks'
import { Icon } from './Primitives'

interface TreeRow {
  node: TaskTreeNode
  level: number
  parentId?: string
}

function flatten(nodes: TaskTreeNode[], collapsed: ReadonlySet<string>, level = 1, parentId?: string): TreeRow[] {
  return nodes.flatMap((node) => [
    { node, level, parentId },
    ...(collapsed.has(node.task.id) ? [] : flatten(node.children, collapsed, level + 1, node.task.id)),
  ])
}

export function TaskTree({ nodes, selectedId, onSelect }: { nodes: TaskTreeNode[]; selectedId: string | null; onSelect(id: string): void }) {
  const [expansion, setExpansion] = useState({ selectedId, collapsed: new Set<string>() })
  const [focusedId, setFocusedId] = useState(selectedId)
  const elements = useRef(new Map<string, HTMLLIElement>())
  let collapsed = expansion.collapsed
  if (expansion.selectedId !== selectedId) {
    const allRows = new Map(flatten(nodes, new Set()).map((row) => [row.node.task.id, row]))
    collapsed = new Set(collapsed)
    let parentId = selectedId ? allRows.get(selectedId)?.parentId : undefined
    while (parentId) { collapsed.delete(parentId); parentId = allRows.get(parentId)?.parentId }
    setExpansion({ selectedId, collapsed })
  }
  const visible = flatten(nodes, collapsed)
  const tabStop = visible.some((row) => row.node.task.id === focusedId) ? focusedId
    : visible.some((row) => row.node.task.id === selectedId) ? selectedId : visible[0]?.node.task.id

  function focus(id: string): void {
    setFocusedId(id)
    elements.current.get(id)?.focus()
  }

  function toggle(id: string): void {
    setExpansion((current) => {
      const next = new Set(current.collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedId, collapsed: next }
    })
    focus(id)
  }

  function handleKey(event: KeyboardEvent<HTMLLIElement>, node: TaskTreeNode): void {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const index = visible.findIndex((row) => row.node.task.id === node.task.id)
    let destination: string | undefined
    switch (event.key) {
      case 'ArrowDown': destination = visible[index + 1]?.node.task.id; break
      case 'ArrowUp': destination = visible[index - 1]?.node.task.id; break
      case 'Home': destination = visible[0]?.node.task.id; break
      case 'End': destination = visible.at(-1)?.node.task.id; break
      case 'ArrowRight':
        if (node.children.length && collapsed.has(node.task.id)) toggle(node.task.id)
        else destination = node.children[0]?.task.id
        break
      case 'ArrowLeft':
        if (node.children.length && !collapsed.has(node.task.id)) toggle(node.task.id)
        else destination = visible[index]?.parentId
        break
      case 'Enter':
      case ' ': onSelect(node.task.id); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (destination) focus(destination)
  }

  function renderNodes(items: TaskTreeNode[], level: number) {
    return items.map((node) => {
      const task = node.task
      const expanded = !collapsed.has(task.id)
      return <li key={task.id} role="treeitem" aria-label={`${task.id} ${task.title}`} aria-level={level}
        aria-selected={selectedId === task.id} aria-expanded={node.children.length ? expanded : undefined}
        tabIndex={tabStop === task.id ? 0 : -1} className="task-tree-item"
        ref={(element) => { if (element) elements.current.set(task.id, element); else elements.current.delete(task.id) }}
        onFocus={(event) => { if (event.target === event.currentTarget) setFocusedId(task.id) }}
        onKeyDown={(event) => handleKey(event, node)}>
        <div className={`tree-row ${selectedId === task.id ? 'is-selected' : ''} ${node.matches ? '' : 'is-context'}`}>
          {node.children.length ? <button type="button" className="tree-disclosure" tabIndex={-1}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${task.id}`} title={`${expanded ? 'Collapse' : 'Expand'} ${task.title}`}
            aria-expanded={expanded} onClick={() => toggle(task.id)}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} /></button>
            : <span className="tree-disclosure-spacer" />}
          <button type="button" className={`task-row ${selectedId === task.id ? 'is-selected' : ''}`} tabIndex={-1}
            aria-label={`${task.id} ${task.title}`} aria-current={selectedId === task.id ? 'page' : undefined}
            onClick={() => { focus(task.id); onSelect(task.id) }}>
            <Icon name={task.kind === 'epic' ? 'layers' : task.status === 'done' ? 'pass' : 'circle-large-outline'} className={`task-icon status-${task.status}`} />
            <span className="task-row-copy"><strong>{task.title}</strong><span>{task.id}<span className="row-dot">·</span>{statusLabels[task.status]}</span></span>
            {task.status === 'in-progress' && <span className="active-indicator" />}
          </button>
        </div>
        {node.children.length > 0 && expanded && <ul role="group" className="task-tree-group">{renderNodes(node.children, level + 1)}</ul>}
      </li>
    })
  }

  return <ul role="tree" aria-label="Tasks" className="task-list task-tree">{renderNodes(nodes, 1)}</ul>
}