import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostSessionsSidebar } from '../src/renderer/components/AgentHostSessionsSidebar'
import type { AgentHostBridge, AgentHostSession } from '../src/shared/agentHost'
import { sessionBindingKey } from '../src/renderer/chat/sessionBindings'
import type { SessionBindings } from '../src/renderer/chat/sessionBindings'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

afterEach(() => { delete window.agentHost })

function bridge(sessions: AgentHostSession[] = []): AgentHostBridge {
  return {
    list: vi.fn(async () => ({ sessions, warnings: [] })),
    watch: vi.fn(), unwatch: vi.fn(), send: vi.fn(), cancel: vi.fn(), models: vi.fn(async () => []), onView: vi.fn(() => () => {}),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []), create: vi.fn(), creationStatus: vi.fn(), bindCreation: vi.fn(),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []), createLocal: vi.fn(), localCreationStatus: vi.fn(),
  }
}

function binding(name: string, title = 'Agent Host') {
  const agentHost = agentHostTargetFixture(name)
  return { id: agentHost.sessionId, title, owner: agentHost.owner, agentHost }
}

describe('AgentHostSessionsSidebar', () => {
  it('supports tree collapse, expansion, keyboard navigation, and session activation', async () => {
    const first = binding('keyboard-first', 'Keyboard first')
    const second = binding('keyboard-second', 'Keyboard second')
    const onSelect = vi.fn()
    window.agentHost = bridge()
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Keyboard task" taskReady
      bindings={{ 'T-0002': [first, second] }} onSelect={onSelect} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    const root = within(tree).getByRole('treeitem', { name: 'T-0002 Keyboard task' })
    root.focus()
    expect(root).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(within(tree).getByRole('treeitem', { name: 'Keyboard first' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(tree).getByRole('treeitem', { name: 'Keyboard second' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(tree).getByRole('treeitem', { name: 'Keyboard first' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(root).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(root).toHaveAttribute('aria-expanded', 'false')
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1)
    await user.keyboard('{ArrowRight}')
    expect(root).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowRight}{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second)
  })

  it('shows every bound member in the task tree even when discovery fails', async () => {
    const first = binding('first-bound', 'First bound')
    const second = binding('second-bound', 'Second bound')
    const bindings: SessionBindings = { 'T-0002': [first, second] }
    window.agentHost = bridge()
    vi.mocked(window.agentHost.list).mockRejectedValueOnce(new Error('Discovery is offline.'))
    const onSelect = vi.fn()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Multi-session task" taskReady bindings={bindings}
      activeKey={sessionBindingKey(first)} onSelect={onSelect} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3)
    expect(within(tree).getByRole('treeitem', { name: 'First bound' })).toHaveAttribute('aria-selected', 'true')
    expect(within(tree).getAllByText('Not in discovery list')).toHaveLength(2)
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Discovery is offline.')
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Current' }))
    await userEvent.setup().click(within(screen.getByRole('tree', { name: 'Sessions for T-0002' })).getByRole('button', { name: 'Open Second bound' }))
    expect(onSelect).toHaveBeenCalledWith(second)
  })

  it('keeps navigation in the sidebar and prevents linking a session owned by another task', async () => {
    const local = agentHostTargetFixture('local-session')
    const remote = { ...agentHostTargetFixture('remote-session'), owner: { clientId: 'remote-owner', machineName: 'Remote machine' } }
    const sessions: AgentHostSession[] = [
      { ...local, title: 'Local work', provider: 'copilotcli', updatedAt: '', canSend: true },
      { ...remote, title: 'Remote work', provider: 'copilotcli', updatedAt: '', canSend: true },
    ]
    window.agentHost = bridge(sessions)
    const onClose = vi.fn()
    const onTasks = vi.fn()
    const onLink = vi.fn()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Target task" taskReady localOwnerId={local.owner.clientId}
      bindings={{ 'T-0003': [{ id: remote.sessionId, title: 'Remote work', owner: remote.owner, agentHost: remote }] }}
      onLink={onLink} onDevices={vi.fn()} onClose={onClose} onTasks={onTasks} />)

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Link' }))
    await screen.findByRole('region', { name: 'Host session Local work' })
    expect(screen.getByRole('combobox', { name: 'Session location' })).toHaveValue('local')
    expect(screen.queryByRole('region', { name: 'Host session Remote work' })).not.toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Session location' }), 'all')
    const remoteRow = screen.getByRole('region', { name: 'Host session Remote work' })
    expect(within(remoteRow).getByText('Linked to T-0003')).toBeInTheDocument()
    expect(within(remoteRow).getByRole('button', { name: 'Link Remote work to T-0002' })).toBeDisabled()
    expect(onLink).not.toHaveBeenCalled()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to tasks' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide session sidebar' }))
    expect(onTasks).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
