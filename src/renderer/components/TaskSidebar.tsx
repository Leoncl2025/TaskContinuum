import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskFilter, TaskRecord } from '../../shared/tasks'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { filterTasks } from '../../shared/tasks'
import { buildTaskTree } from '../../shared/taskTree'
import { Icon, IconButton } from './Primitives'
import { TaskTree } from './TaskTree'
import type { TaskCreationMode } from './TaskCreationDialog'

interface Props {
  tasks: TaskRecord[]
  selectedId: string | null
  query: string
  onQuery(value: string): void
  onSelect(id: string): void
  onCreate(): void
  onCreateTask(mode: TaskCreationMode): void
  creationDisabled?: boolean
  onClose(): void
  workspace?: WorkspaceSnapshot
  workspaceControls?: ReactNode
}

export function TaskSidebar({ tasks, selectedId, query, onQuery, onSelect, onCreate, onCreateTask, creationDisabled, onClose, workspace, workspaceControls }: Props) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  const matches = filterTasks(tasks, query, filter)
  const tree = buildTaskTree(tasks, query.trim() || filter !== 'all' ? new Set(matches.map((task) => task.id)) : undefined)
  return (
    <aside className="sidebar" aria-label="Task explorer">
      <header className="panel-header">
        <span>EXPLORER</span>
        <div className="header-actions">
          <button type="button" className="text-button sidebar-repository-action" aria-label="New task repository" title="Create a new task repository" disabled={creationDisabled} onClick={onCreate}><Icon name="repo" /><span>New repo</span></button>
          <IconButton icon="layout-sidebar-left-off" label="Hide task sidebar" onClick={onClose} />
        </div>
      </header>
      {workspaceControls ?? <div className="workspace-heading"><span className="workspace-mark"><Icon name="repo" /></span><div><strong>{workspace?.name ?? 'No workspace'}</strong><span>{workspace?.root ?? 'Create or open a task repository'}</span></div></div>}
      <div className="sidebar-task-actions" role="group" aria-label="Task creation actions">
        <button type="button" className="secondary-button" aria-label="New task" title="New task (Ctrl+N)" disabled={creationDisabled || !workspace} onClick={() => onCreateTask('form')}><Icon name="new-file" /><span>New task</span></button>
        <button type="button" className="secondary-button" aria-label="Create task with agent" title="Create tasks with an agent in the chat panel" disabled={creationDisabled || !workspace} onClick={() => onCreateTask('agent')}><Icon name="copilot" /><span>With agent</span></button>
      </div>
      <div className="sidebar-search"><Icon name="search" /><input id="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value={query} onChange={(event) => onQuery(event.target.value)} autoComplete="off" /></div>
      <div className="filter-bar" role="group" aria-label="Task status filter">
        {(['all', 'active', 'done'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All tasks' : value === 'active' ? 'Active' : 'Done'}<span>{filterTasks(tasks, '', value).length}</span></button>)}
      </div>
      <div className="tree-heading"><span>TASKS</span><span>{matches.length}</span></div>
      <div className="sidebar-scroll">
        <TaskTree key={`${query.trim()}:${filter}`} nodes={tree} selectedId={selectedId} onSelect={onSelect} />
        {matches.length === 0 && <div className="empty-sidebar"><Icon name={tasks.length ? 'search-stop' : 'checklist'} /><strong>{!tasks.length ? 'No tasks found' : 'No matching tasks'}</strong>{tasks.length > 0 ? <><p>Try a different title, ID, or status.</p><button type="button" className="text-button" onClick={() => { onQuery(''); setFilter('all') }}>Clear filters</button></> : workspace && <div className="task-empty-actions"><button type="button" className="primary-button" disabled={creationDisabled} onClick={() => onCreateTask('form')}>Create first task</button><button type="button" className="secondary-button" disabled={creationDisabled} onClick={() => onCreateTask('agent')}>Ask an agent to create tasks</button></div>}</div>}
      </div>
      {Boolean(workspace?.warnings.length) && <details className="workspace-warning"><summary>{workspace!.warnings.length} workspace warnings</summary>{workspace!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      <div className="sidebar-footer"><Icon name={workspace ? 'folder' : 'repo'} /><div><strong>{workspace ? workspace.title : 'Your tasks, in your repository'}</strong><p>{workspace ? `${tasks.length} tasks` : 'Task files and configuration stay together in Git.'}</p></div></div>
    </aside>
  )
}