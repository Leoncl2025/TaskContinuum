import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskFilter, TaskRecord } from '../../shared/tasks'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { filterTasks } from '../../shared/tasks'
import { buildTaskTree } from '../../shared/taskTree'
import { Icon, IconButton } from './Primitives'
import { TaskTree } from './TaskTree'

interface Props {
  tasks: TaskRecord[]
  selectedId: string | null
  query: string
  onQuery(value: string): void
  onSelect(id: string): void
  onCreate(): void
  onClose(): void
  workspace?: WorkspaceSnapshot
  workspaceControls?: ReactNode
}

export function TaskSidebar({ tasks, selectedId, query, onQuery, onSelect, onCreate, onClose, workspace, workspaceControls }: Props) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  const matches = filterTasks(tasks, query, filter)
  const tree = buildTaskTree(tasks, query.trim() || filter !== 'all' ? new Set(matches.map((task) => task.id)) : undefined)
  return (
    <aside className="sidebar" aria-label="Task explorer">
      <header className="panel-header">
        <span>EXPLORER</span>
        <div className="header-actions">
          {!workspace && <IconButton icon="add" label="Create demo task" onClick={onCreate} />}
          <IconButton icon="layout-sidebar-left-off" label="Hide task sidebar" onClick={onClose} />
        </div>
      </header>
      {workspaceControls ?? <div className="workspace-heading"><span className="workspace-mark"><Icon name="layers" /></span><div><strong>Task Continuum</strong><span>Local demo workspace</span></div></div>}
      <div className="sidebar-search"><Icon name="search" /><input id="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value={query} onChange={(event) => onQuery(event.target.value)} autoComplete="off" /></div>
      <div className="filter-bar" role="group" aria-label="Task status filter">
        {(['all', 'active', 'done'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All tasks' : value === 'active' ? 'Active' : 'Done'}<span>{filterTasks(tasks, '', value).length}</span></button>)}
      </div>
      <div className="tree-heading"><span>TASKS</span><span>{matches.length}</span></div>
      <div className="sidebar-scroll">
        <TaskTree key={`${query.trim()}:${filter}`} nodes={tree} selectedId={selectedId} onSelect={onSelect} />
        {matches.length === 0 && <div className="empty-sidebar"><Icon name="search-stop" /><strong>{workspace && !tasks.length ? 'No tasks found' : 'No matching tasks'}</strong>{tasks.length > 0 && <><p>Try a different title, ID, or status.</p><button type="button" className="text-button" onClick={() => { onQuery(''); setFilter('all') }}>Clear filters</button></>}</div>}
      </div>
      {Boolean(workspace?.warnings.length) && <details className="workspace-warning"><summary>{workspace!.warnings.length} workspace warnings</summary>{workspace!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="sidebar-footer"><Icon name={workspace ? 'lock' : 'beaker'} /><div><strong>{workspace ? workspace.title : 'A small, local sandbox'}</strong><p>{workspace ? `${tasks.length} tasks` : 'Explore freely. Demo changes stay in this window.'}</p></div></div>
    </aside>
  )
}