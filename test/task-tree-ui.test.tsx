import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskSidebar } from '../src/renderer/components/TaskSidebar'
import { TaskTree } from '../src/renderer/components/TaskTree'
import { buildTaskTree } from '../src/shared/taskTree'
import type { TaskRecord } from '../src/shared/tasks'
import { taskWorkspaceFixture } from './workspace-ui-fixture'

function task(id: string, title: string, parentId?: string): TaskRecord {
  return { id, title, parentId, kind: 'feature', status: 'backlog', priority: 'P2', owner: 'Owner', summary: '', goal: '', nextAction: '', requirements: [], plan: [], checklist: [] }
}

const tasks = [task('T-0001', 'MVP'), task('T-0002', 'Electron UI', 'T-0001'), task('T-0003', 'Backend', 'T-0001'), task('T-0005', 'Design icon', 'T-0002'), task('T-0006', 'Independent task')]
const nodes = buildTaskTree(tasks)

function Sidebar() {
  const [query, setQuery] = useState('')
  return <TaskSidebar tasks={tasks} selectedId={null} query={query} onQuery={setQuery} onSelect={vi.fn()} onCreate={vi.fn()} onCreateTask={vi.fn()} onClose={vi.fn()} />
}

describe('task explorer tree', () => {
  it('distinguishes labeled task actions from repository creation and keeps their routes separate', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    const onCreateTask = vi.fn()
    render(<TaskSidebar tasks={tasks} selectedId={null} query="" onQuery={vi.fn()} onSelect={vi.fn()} onCreate={onCreate} onCreateTask={onCreateTask} onClose={vi.fn()} workspace={taskWorkspaceFixture()} />)
    const actions = screen.getByRole('group', { name: 'Task creation actions' })
    const manual = within(actions).getByRole('button', { name: 'New task' })
    const agent = within(actions).getByRole('button', { name: 'Create task with agent' })
    const repository = screen.getByRole('button', { name: 'New task repository' })
    expect(manual).toHaveTextContent('New task')
    expect(manual).toHaveAttribute('title', 'New task (Ctrl+N)')
    expect(manual.querySelector('.codicon-new-file')).toBeInTheDocument()
    expect(agent).toHaveTextContent('With agent')
    expect(agent).toHaveAttribute('title', 'Create tasks with an agent in the chat panel')
    expect(agent.querySelector('.codicon-copilot')).toBeInTheDocument()
    expect(repository).toHaveTextContent('New repo')
    expect(repository.querySelector('.codicon-repo')).toBeInTheDocument()
    expect(actions).not.toContainElement(repository)
    await user.click(manual)
    expect(onCreateTask).toHaveBeenCalledExactlyOnceWith('form')
    await user.click(agent)
    expect(onCreateTask).toHaveBeenLastCalledWith('agent')
    expect(onCreate).not.toHaveBeenCalled()
    await user.click(repository)
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('renders ordered nested groups with true levels and no disclosure on leaves', () => {
    render(<TaskTree nodes={nodes} selectedId="T-0002" onSelect={vi.fn()} />)
    const tree = screen.getByRole('tree', { name: 'Tasks' })
    expect(within(tree).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual(['T-0001 MVP', 'T-0002 Electron UI', 'T-0005 Design icon', 'T-0003 Backend', 'T-0006 Independent task'])
    const child = screen.getByRole('treeitem', { name: 'T-0005 Design icon' })
    expect(child).toHaveAttribute('aria-level', '3')
    expect(within(screen.getByRole('treeitem', { name: 'T-0002 Electron UI' })).getByRole('treeitem', { name: 'T-0005 Design icon' })).toBe(child)
    expect(child).not.toHaveAttribute('aria-expanded')
    expect(screen.queryByRole('button', { name: 'Collapse T-0005' })).not.toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: 'T-0002 Electron UI' })).toHaveAttribute('aria-selected', 'true')
  })

  it('folds each branch independently without selecting it or losing sibling tasks', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<TaskTree nodes={nodes} selectedId={null} onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Collapse T-0002' }))
    expect(screen.queryByRole('treeitem', { name: 'T-0005 Design icon' })).not.toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: 'T-0003 Backend' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Collapse T-0001' }))
    expect(screen.getAllByRole('treeitem')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Expand T-0001' }))
    expect(screen.getByRole('button', { name: 'Expand T-0002' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'T-0005 Design icon' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps a matching grandchild under its visible ancestor path while filtering', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'Collapse T-0001' }))
    await user.type(screen.getByRole('textbox', { name: 'Filter tasks' }), 'icon')
    expect(screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))).toEqual(['T-0001 MVP', 'T-0002 Electron UI', 'T-0005 Design icon'])
    expect(screen.getByRole('treeitem', { name: 'T-0005 Design icon' })).toHaveAttribute('aria-level', '3')
    await user.click(screen.getByRole('button', { name: 'Collapse T-0002' }))
    expect(screen.queryByRole('treeitem', { name: 'T-0005 Design icon' })).not.toBeInTheDocument()
  })

  it('supports roving focus, parent/child arrows, Home/End, and explicit keyboard selection', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<TaskTree nodes={nodes} selectedId={null} onSelect={onSelect} />)
    const root = screen.getByRole('treeitem', { name: 'T-0001 MVP' })
    root.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('treeitem', { name: 'T-0002 Electron UI' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('treeitem', { name: 'T-0005 Design icon' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('treeitem', { name: 'T-0003 Backend' })).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(root).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(root).toHaveAttribute('aria-expanded', 'false')
    await user.keyboard('{End}{Enter}')
    expect(onSelect).toHaveBeenCalledWith('T-0006')
    await user.keyboard('{Home}{ArrowRight}')
    expect(root).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0)).toHaveLength(1)
  })

  it('reveals a task selected from outside a collapsed branch', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const view = render(<TaskTree nodes={nodes} selectedId="T-0003" onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Collapse T-0001' }))
    view.rerender(<TaskTree nodes={nodes} selectedId="T-0005" onSelect={onSelect} />)
    expect(screen.getByRole('treeitem', { name: 'T-0005 Design icon' })).toHaveAttribute('aria-selected', 'true')
  })
})