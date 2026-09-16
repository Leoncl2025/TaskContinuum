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
  creationDisabled?: boolean
  onClose(): void
  workspace?: WorkspaceSnapshot
  workspaceControls?: ReactNode
}

export function TaskSidebar({ tasks, selectedId, query, onQuery, onSelect, onCreate, creationDisabled, onClose, workspace, workspaceControls }: Props) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  const matches = filterTasks(tasks, query, filter)
  const tree = buildTaskTree(tasks, query.trim() || filter !== 'all' ? new Set(matches.map((task) => task.id)) : undefined)
  return (
    <aside className="sidebar" aria-label="Task explorer">
      <header className="panel-header">
        <span>EXPLORER</span>
        <div className="header-actions">
          <IconButton icon="add" label="New task repository" disabled={creationDisabled} onClick={onCreate} />
          <IconButton icon="layout-sidebar-left-off" label="Hide task sidebar" onClick={onClose} />
        </div>
      </header>
      {workspaceControls ?? <div className="workspace-heading"><span className="workspace-mark"><Icon name="repo" /></span><div><strong>{workspace?.name ?? 'No workspace'}</strong><span>{workspace?.root ?? 'Create or open a task repository'}</span></div></div>}
      <div className="sidebar-search"><Icon name="search" /><input id="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value={query} onChange={(event) => onQuery(event.target.value)} autoComplete="off" /></div>
      <div className="filter-bar" role="group" aria-label="Task status filter">
        {(['all', 'active', 'done'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All tasks' : value === 'active' ? 'Active' : 'Done'}<span>{filterTasks(tasks, '', value).length}</span></button>)}
      </div>
      <div className="tree-heading"><span>TASKS</span><span>{matches.length}</span></div>
      <div className="sidebar-scroll">
        <TaskTree key={`${query.trim()}:${filter}`} nodes={tree} selectedId={selectedId} onSelect={onSelect} />
        {matches.length === 0 && <div className="empty-sidebar"><Icon name={tasks.length ? 'search-stop' : 'checklist'} /><strong>{!tasks.length ? 'No tasks found' : 'No matching tasks'}</strong>{tasks.length > 0 && <><p>Try a different title, ID, or status.</p><button type="button" className="text-button" onClick={() => { onQuery(''); setFilter('all') }}>Clear filters</button></>}</div>}
      </div>
      {Boolean(workspace?.warnings.length) && <details className="workspace-warning"><summary>{workspace!.warnings.length} workspace warnings</summary>{workspace!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="sidebar-footer"><Icon name={workspace ? 'lock' : 'repo'} /><div><strong>{workspace ? workspace.title : 'Your tasks, in your repository'}</strong><p>{workspace ? `${tasks.length} tasks` : 'Task files and configuration stay together in Git.'}</p></div></div>
    </aside>
  )
}