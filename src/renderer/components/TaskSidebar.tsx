import { useState } from 'react'
import type { TaskFilter, TaskRecord } from '../../shared/tasks'
import { filterTasks, statusLabels } from '../../shared/tasks'
import type { TaskChat } from '../chat/useTaskChats'
import { Icon, IconButton } from './Primitives'

interface Props {
  tasks: TaskRecord[]
  selectedId: string | null
  view: 'tasks' | 'sessions'
  query: string
  onQuery(value: string): void
  onSelect(id: string): void
  onCreate(): void
  onClose(): void
  threads: Record<string, TaskChat>
}

export function TaskSidebar({ tasks, selectedId, view, query, onQuery, onSelect, onCreate, onClose, threads }: Props) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [collapsed, setCollapsed] = useState(false)
  const matches = filterTasks(tasks, query, filter)
  const visible = matches.filter((task) => !collapsed || !task.parentId || query.trim() || filter !== 'all')
  return (
    <aside className="sidebar" aria-label={view === 'tasks' ? 'Task explorer' : 'Session explorer'}>
      <header className="panel-header">
        <span>{view === 'tasks' ? 'EXPLORER' : 'SESSIONS'}</span>
        <div className="header-actions">
          <IconButton icon="add" label="Create demo task" onClick={onCreate} />
          <IconButton icon="layout-sidebar-left-off" label="Hide task sidebar" onClick={onClose} />
        </div>
      </header>
      <div className="workspace-heading"><span className="workspace-mark"><Icon name="layers" /></span><div><strong>Task Continuum</strong><span>Local demo workspace</span></div></div>
      <div className="sidebar-search"><Icon name="search" /><input id="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value={query} onChange={(event) => onQuery(event.target.value)} autoComplete="off" /></div>
      <div className="filter-bar" role="group" aria-label="Task status filter">
        {(['all', 'active', 'done'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All tasks' : value === 'active' ? 'Active' : 'Done'}<span>{filterTasks(tasks, '', value).length}</span></button>)}
      </div>
      <div className="tree-heading"><span>{view === 'tasks' ? 'TASKS' : 'TASK CONVERSATIONS'}</span><span>{matches.length}</span></div>
      <div className="sidebar-scroll">
        <ul className="task-list">
          {visible.map((task) => {
            const messages = threads[task.id]?.messages ?? []
            const busy = messages.some((message) => message.status === 'streaming')
            return <li key={task.id} className={`task-list-item ${task.parentId ? 'is-child' : ''}`}>
              {task.kind === 'epic' && view === 'tasks' && <button type="button" className="tree-disclosure" aria-label={collapsed ? 'Expand task group' : 'Collapse task group'} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} /></button>}
              <button type="button" className={`task-row ${selectedId === task.id ? 'is-selected' : ''}`} aria-label={`${task.id} ${task.title}`} aria-current={selectedId === task.id ? 'page' : undefined} onClick={() => onSelect(task.id)}>
                <Icon name={view === 'sessions' ? 'comment-discussion' : task.kind === 'epic' ? 'layers' : task.status === 'done' ? 'pass' : 'circle-large-outline'} className={`task-icon status-${task.status}`} />
                <span className="task-row-copy"><strong>{task.title}</strong><span>{task.id}<span className="row-dot">·</span>{view === 'sessions' ? busy ? 'Responding…' : `${messages.filter((message) => message.role === 'user').length} messages` : statusLabels[task.status]}</span></span>
                {task.status === 'in-progress' && <span className="active-indicator" />}
              </button>
            </li>
          })}
        </ul>
        {matches.length === 0 && <div className="empty-sidebar"><Icon name="search-stop" /><strong>No matching tasks</strong><p>Try a different title, ID, or status.</p><button type="button" className="text-button" onClick={() => { onQuery(''); setFilter('all') }}>Clear filters</button></div>}
      </div>
      <div className="sidebar-footer"><Icon name="beaker" /><div><strong>A small, local sandbox</strong><p>Explore freely. Demo changes stay in this window.</p></div></div>
    </aside>
  )
}