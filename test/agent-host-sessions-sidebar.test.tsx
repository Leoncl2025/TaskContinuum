import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostSessionsSidebar } from '../src/renderer/components/AgentHostSessionsSidebar'
import type { AgentHostBridge, AgentHostSession } from '../src/shared/agentHost'
import { agentHostKey } from '../src/shared/agentHost'
import { sessionBindingKey } from '../src/renderer/chat/sessionBindings'
import type { SessionBindings } from '../src/renderer/chat/sessionBindings'
import { agentHostTargetFixture } from './immutable-bindings-fixture'
import { MachineAliasesProvider } from '../src/renderer/MachineAliasesProvider'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { delete window.agentHost; delete window.remoteVSCode })

function bridge(sessions: AgentHostSession[] = []): AgentHostBridge {
  return {
    list: vi.fn(async () => ({ sessions, warnings: [] })),
    watch: vi.fn(), unwatch: vi.fn(), terminal: vi.fn(), releaseTerminal: vi.fn(), send: vi.fn(), resolveDelivery: vi.fn(), cancel: vi.fn(), models: vi.fn(async () => []), onView: vi.fn(() => () => {}),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []), create: vi.fn(), creationStatus: vi.fn(), bindCreation: vi.fn(), abandonCreation: vi.fn(),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []), createLocal: vi.fn(), localCreationStatus: vi.fn(),
  }
}

function binding(name: string, title = 'Agent Host') {
  const agentHost = agentHostTargetFixture(name)
  return { id: agentHost.sessionId, title, owner: agentHost.owner, agentHost }
}

describe('AgentHostSessionsSidebar', () => {
  it('keeps cached titles and alias search together without changing link targets', async () => {
    const target = agentHostTargetFixture('cached-alias')
    const session: AgentHostSession = { ...target, title: 'Discovery title', provider: 'copilotcli', updatedAt: '', canSend: true }
    window.agentHost = bridge([session])
    const git = gitSyncUiFixture()
    window.remoteVSCode = git.remote
    git.setStatus({ ...git.getStatus(), machineAliases: { [target.owner.clientId]: 'Build desk' } })
    const onLink = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<MachineAliasesProvider workspaceId="workspace"><AgentHostSessionsSidebar taskId="T-0002" taskReady initialView="link"
      cachedTitles={{ [agentHostKey(target)]: 'Remembered work' }} onLink={onLink} onDevices={vi.fn()} onClose={vi.fn()} /></MachineAliasesProvider>)

    const row = await screen.findByRole('region', { name: 'Host session Remembered work' })
    expect(within(row).getByText(`Build desk (${target.owner.machineName}) / Read and send`)).toBeInTheDocument()
    const search = screen.getByRole('textbox', { name: 'Find Agent Host session' })
    for (const query of ['Remembered work', 'Build desk', target.owner.machineName]) {
      await user.clear(search)
      await user.type(search, query)
      expect(screen.getByRole('region', { name: 'Host session Remembered work' })).toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: 'Link Remembered work to T-0002' }))
    expect(onLink).toHaveBeenCalledExactlyOnceWith(session)
  })

  it('updates aliases for bound sessions without changing selection, ownership, or detach targets', async () => {
    const first = binding('alias-first', 'First conversation')
    const otherTarget = { ...agentHostTargetFixture('alias-second'), owner: { clientId: 'other-owner', machineName: first.owner.machineName } }
    const second = { id: otherTarget.sessionId, title: 'Second conversation', owner: otherTarget.owner, agentHost: otherTarget, ownerIsRemote: true }
    const catalogue = bridge()
    window.agentHost = catalogue
    const git = gitSyncUiFixture()
    window.remoteVSCode = git.remote
    git.setStatus({ ...git.getStatus(), machineAliases: { [first.owner.clientId]: 'Office', [second.owner.clientId]: 'Laptop' } })
    const onSelect = vi.fn()
    const onDetach = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<MachineAliasesProvider workspaceId="workspace"><AgentHostSessionsSidebar taskId="T-0002" taskTitle="Multiple conversations" taskReady
      bindings={{ 'T-0002': [first, second] }} activeKey={sessionBindingKey(first)} onSelect={onSelect} onDetach={onDetach}
      onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} /></MachineAliasesProvider>)

    expect(await screen.findByText(`Local / Office (${first.owner.machineName})`)).toHaveAttribute('title', first.owner.machineName)
    expect(screen.getByText(`Remote / Laptop (${second.owner.machineName})`)).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: first.title })).toHaveAttribute('aria-selected', 'true')
    git.setStatus({ ...git.getStatus(), machineAliases: { [first.owner.clientId]: 'Build desk', [second.owner.clientId]: 'Laptop' } })
    await act(async () => git.notify())
    expect(screen.getByText(`Local / Build desk (${first.owner.machineName})`)).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: first.title })).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onDetach).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: `Open ${second.title}` }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second)
    await user.click(screen.getByRole('button', { name: `Unlink ${first.title}` }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    expect(onDetach).toHaveBeenCalledExactlyOnceWith(first)
    git.setStatus({ ...git.getStatus(), machineAliases: {} })
    await act(async () => git.notify())
    expect(screen.getByText(`Local / ${first.owner.machineName}`)).toBeInTheDocument()
    expect(screen.getByText(`Remote / ${second.owner.machineName}`)).toBeInTheDocument()
    expect(catalogue.list).toHaveBeenCalledOnce()
    expect(catalogue.create).not.toHaveBeenCalled()
    expect(catalogue.send).not.toHaveBeenCalled()
  })

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
    const toggle = within(root).getByRole('button', { name: 'Collapse sessions for Keyboard task' })
    expect(toggle).toHaveTextContent('Keyboard task')
    expect(toggle).not.toHaveTextContent('T-0002')
    expect(toggle).toHaveAttribute('title', 'Keyboard task (T-0002)')
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
