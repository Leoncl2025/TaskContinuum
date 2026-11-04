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
  it('shows compact rows without a duplicate task heading and expands details separately from activation and unlink', async () => {
    const first = { ...binding('compact-first', 'First conversation'), ownerIsRemote: true }
    const second = binding('compact-second', 'Second conversation')
    window.agentHost = bridge([{ ...first.agentHost, title: first.title, provider: 'copilotcli', updatedAt: '', canSend: false }])
    const onSelect = vi.fn(), onDetach = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Current task title" taskReady
      bindings={{ 'T-0002': [first, second] }} activeKey={sessionBindingKey(first)} onSelect={onSelect} onDetach={onDetach}
      onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)
    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    expect(screen.getAllByText(/Current task title/)).toHaveLength(1)
    expect(within(tree).queryByText(/Current task title/)).not.toBeInTheDocument()
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2)
    for (const hidden of [first.id, second.id, 'Current session', 'Read only', 'Not in discovery list']) {
      expect(within(tree).queryByText(hidden, { exact: true })).not.toBeInTheDocument()
    }
    const row = within(tree).getByRole('treeitem', { name: first.title })
    expect(within(row).getByText(first.owner.machineName)).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: `Show details for ${first.title}` }))
    const details = within(row).getByRole('group', { name: `Details for ${first.title}` })
    expect(within(details).getByText(first.id, { exact: true })).toBeInTheDocument()
    expect(within(details).getByText(first.agentHost.chatId, { exact: true })).toBeInTheDocument()
    expect(within(details).getByText('Read only')).toBeInTheDocument()
    expect(within(details).getByText('Remote')).toBeInTheDocument()
    expect(within(details).getByText('Current session')).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
    expect(window.agentHost.watch).not.toHaveBeenCalled()
    await user.click(within(row).getByRole('button', { name: `Hide details for ${first.title}` }))
    expect(within(row).queryByRole('group')).not.toBeInTheDocument()
    await user.click(within(tree).getByRole('button', { name: `Unlink ${second.title}` }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onDetach).not.toHaveBeenCalled()
    expect(within(tree).queryByRole('group')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    expect(onDetach).toHaveBeenCalledExactlyOnceWith(second)
    await user.click(within(row).getByRole('button', { name: `Open ${first.title}` }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(first)
    expect(window.agentHost.create).not.toHaveBeenCalled()
    expect(window.agentHost.send).not.toHaveBeenCalled()
  })

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

  it('keeps expansion attached to the exact binding when equal titles and IDs are reordered', async () => {
    const first = binding('same-id', 'Same title')
    const second = { ...binding('same-id', 'Same title'), owner: { clientId: '00000000-0000-4000-8000-000000000022', machineName: 'Another-machine' } }
    second.agentHost = { ...second.agentHost, owner: second.owner }
    window.agentHost = bridge([])
    const onSelect = vi.fn()
    const props = { taskId: 'T-0002', taskReady: true, activeKey: sessionBindingKey(first), onSelect, onLink: vi.fn(), onDevices: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<AgentHostSessionsSidebar {...props} bindings={{ 'T-0002': [first, second] }} />)
    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    const rows = within(tree).getAllByRole('treeitem')
    const user = userEvent.setup()
    await user.click(within(rows[0]).getByRole('button', { name: 'Show details for Same title' }))
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true')
    expect(rows[1]).toHaveAttribute('aria-expanded', 'false')
    rerender(<AgentHostSessionsSidebar {...props} bindings={{ 'T-0002': [second, first] }} />)
    const reordered = within(tree).getAllByRole('treeitem')
    expect(reordered[0]).toHaveAttribute('aria-expanded', 'false')
    expect(reordered[1]).toHaveAttribute('aria-expanded', 'true')
    expect(reordered[1]).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(within(reordered[0]).getByRole('button', { name: 'Open Same title' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second)
    expect(window.agentHost.watch).not.toHaveBeenCalled()
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

    expect(await screen.findByText(`Office (${first.owner.machineName})`)).toHaveAttribute('title', first.owner.machineName)
    expect(screen.getByText(`Laptop (${second.owner.machineName})`)).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: first.title })).toHaveAttribute('aria-selected', 'true')
    git.setStatus({ ...git.getStatus(), machineAliases: { [first.owner.clientId]: 'Build desk', [second.owner.clientId]: 'Laptop' } })
    await act(async () => git.notify())
    expect(screen.getByText(`Build desk (${first.owner.machineName})`)).toBeInTheDocument()
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
    expect(within(screen.getByRole('treeitem', { name: first.title })).getByText(first.owner.machineName)).toBeInTheDocument()
    expect(within(screen.getByRole('treeitem', { name: second.title })).getByText(second.owner.machineName)).toBeInTheDocument()
    expect(catalogue.list).toHaveBeenCalledOnce()
    expect(catalogue.create).not.toHaveBeenCalled()
    expect(catalogue.send).not.toHaveBeenCalled()
  })

  it('supports flat keyboard navigation and per-session detail expansion without activating a session', async () => {
    const first = binding('keyboard-first', 'Keyboard first')
    const second = binding('keyboard-second', 'Keyboard second')
    const onSelect = vi.fn()
    window.agentHost = bridge()
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Keyboard task" taskReady
      bindings={{ 'T-0002': [first, second] }} onSelect={onSelect} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    const row = within(tree).getByRole('treeitem', { name: 'Keyboard first' })
    expect(within(tree).queryByRole('treeitem', { name: 'T-0002 Keyboard task' })).not.toBeInTheDocument()
    row.focus()
    expect(row).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(within(row).getByText(first.id, { exact: true })).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
    await user.keyboard('{End}')
    expect(within(tree).getByRole('treeitem', { name: 'Keyboard second' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(tree).getByRole('treeitem', { name: 'Keyboard first' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(row).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(within(row).queryByText(first.id, { exact: true })).not.toBeInTheDocument()
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2)
    await user.keyboard('{ArrowRight}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowDown}{Enter}')
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
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2)
    expect(within(tree).getByRole('treeitem', { name: 'First bound' })).toHaveAttribute('aria-selected', 'true')
    expect(within(tree).queryByText('Not in discovery list')).not.toBeInTheDocument()
    await userEvent.setup().click(within(tree).getByRole('button', { name: 'Show details for First bound' }))
    await userEvent.setup().click(within(tree).getByRole('button', { name: 'Show details for Second bound' }))
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
