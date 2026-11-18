import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
    watch: vi.fn(), unwatch: vi.fn(), loadHistory: vi.fn(), terminal: vi.fn(), releaseTerminal: vi.fn(), send: vi.fn(), resolveDelivery: vi.fn(), cancel: vi.fn(), models: vi.fn(async () => []), onView: vi.fn(() => () => {}), onHistoryTransfer: vi.fn(() => () => {}),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []), create: vi.fn(), creationStatus: vi.fn(), bindCreation: vi.fn(), abandonCreation: vi.fn(),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []), createLocal: vi.fn(), localCreationStatus: vi.fn(),
  }
}

function binding(name: string, title = 'Agent Host') {
  const agentHost = agentHostTargetFixture(name)
  return { id: agentHost.sessionId, title, owner: agentHost.owner, agentHost }
}

describe('AgentHostSessionsSidebar', () => {
  it('overlays the exact session row with real byte progress without intercepting its controls', async () => {
    const first = binding('transfer-first', 'Transferring conversation')
    const second = binding('transfer-second', 'Other conversation')
    window.agentHost = bridge()
    const props = { taskId: 'T-0002', taskReady: true, bindings: { 'T-0002': [first, second] },
      activeKey: sessionBindingKey(first), onSelect: vi.fn(), onDetach: vi.fn(async () => {}),
      onLink: vi.fn(), onDevices: vi.fn(), onClose: vi.fn() }
    const progress = { receivedBytes: 1024 * 1024, totalBytes: 117.1 * 1024 * 1024, kind: 'recent' as const }
    const rendered = render(<AgentHostSessionsSidebar {...props} historyTransfers={{ [agentHostKey(first.agentHost)]: progress }} />)
    const row = screen.getByRole('treeitem', { name: first.title })
    const other = screen.getByRole('treeitem', { name: second.title })
    const bar = within(row).getByRole('progressbar', { name: `History transfer for ${first.title}` })
    expect(Number(bar.getAttribute('value'))).toBeCloseTo(100 / 117.1)
    expect(bar).toHaveAttribute('aria-valuetext', 'Recent history: 0.8% (1.0 / 117.1 MiB)')
    expect(within(row).getByText('0.8%')).toBeVisible()
    expect(within(row).getByText(first.title)).toBeVisible()
    expect(within(other).queryByRole('progressbar')).not.toBeInTheDocument()
    const user = userEvent.setup()
    expect(within(row).queryByRole('button', { name: `Unlink ${first.title}` })).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: `Open ${first.title}` }))
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(first)
    await user.click(within(row).getByRole('button', { name: `Show details for ${first.title}` }))
    const details = within(row).getByRole('group', { name: `Details for ${first.title}` })
    expect(details).toBeVisible()
    expect(within(details).getByRole('button', { name: `Unlink ${first.title}` })).toBeEnabled()
    rendered.rerender(<AgentHostSessionsSidebar {...props} historyTransfers={{}} />)
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: `Open ${first.title}` })).toHaveTextContent(first.owner.machineName)
    expect(window.agentHost.watch).not.toHaveBeenCalled()
  })

  it('keeps progress tied to owner and chat identities and exposes resume information', () => {
    const first = binding('same-transfer-id', 'Same title')
    const secondTarget = { ...first.agentHost, owner: { clientId: crypto.randomUUID(), machineName: 'Other owner' } }
    const second = { ...first, owner: secondTarget.owner, agentHost: secondTarget }
    window.agentHost = bridge()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskReady bindings={{ 'T-0002': [first, second] }}
      historyTransfers={{ [agentHostKey(second.agentHost)]: { receivedBytes: 75 * 1024, totalBytes: 100 * 1024, resumed: true } }}
      onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)
    const rows = screen.getAllByRole('treeitem', { name: first.title })
    expect(within(rows[0]).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(rows[1]).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Resuming history: 75% (75.0 / 100.0 KiB) - Resumed from saved progress')
  })

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
    for (const removed of ['AGENT HOST SESSIONS', 'Current task']) expect(screen.queryByText(removed, { exact: true })).not.toBeInTheDocument()
    for (const removed of ['Back to tasks', 'Link existing', 'Create new']) expect(screen.queryByRole('button', { name: removed })).not.toBeInTheDocument()
    for (const tab of ['Current', 'Link', 'Create']) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument()
    expect(within(tree).queryByText(/Current task title/)).not.toBeInTheDocument()
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2)
    expect(within(tree).queryByRole('button', { name: /^Unlink / })).not.toBeInTheDocument()
    for (const hidden of [first.id, second.id, 'Current session', 'Read only', 'Not in discovery list']) {
      expect(within(tree).queryByText(hidden, { exact: true })).not.toBeInTheDocument()
    }
    const row = within(tree).getByRole('treeitem', { name: first.title })
    expect(within(within(row).getByRole('button', { name: `Open ${first.title}` })).getByText(first.owner.machineName)).toBeInTheDocument()
    const secondRow = within(tree).getByRole('treeitem', { name: second.title })
    await user.click(within(secondRow).getByText(second.owner.machineName))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second)
    expect(secondRow).toHaveAttribute('aria-expanded', 'false')
    expect(within(tree).queryByRole('group')).not.toBeInTheDocument()
    onSelect.mockClear()
    await user.click(within(row).getByRole('button', { name: `Show details for ${first.title}` }))
    const details = within(row).getByRole('group', { name: `Details for ${first.title}` })
    expect(within(details).getByText(first.id, { exact: true })).toBeInTheDocument()
    expect(within(details).getByText(first.agentHost.chatId, { exact: true })).toBeInTheDocument()
    expect(within(details).getByText('Read only')).toBeInTheDocument()
    expect(within(details).getByText('Remote')).toBeInTheDocument()
    expect(within(details).getByText('Current session')).toBeInTheDocument()
    expect(within(details).getByRole('button', { name: `Unlink ${first.title}` })).toBeEnabled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(window.agentHost.watch).not.toHaveBeenCalled()
    await user.click(within(row).getByRole('button', { name: `Hide details for ${first.title}` }))
    expect(within(row).queryByRole('group')).not.toBeInTheDocument()
    await user.click(within(secondRow).getByRole('button', { name: `Show details for ${second.title}` }))
    const secondDetails = within(secondRow).getByRole('group', { name: `Details for ${second.title}` })
    await user.click(within(secondDetails).getByRole('button', { name: `Unlink ${second.title}` }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onDetach).not.toHaveBeenCalled()
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
    await user.click(screen.getByRole('button', { name: `Show details for ${first.title}` }))
    await user.click(screen.getByRole('button', { name: `Unlink ${first.title}` }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    expect(onDetach).toHaveBeenCalledExactlyOnceWith(first)
    git.setStatus({ ...git.getStatus(), machineAliases: {} })
    await act(async () => git.notify())
    expect(within(screen.getByRole('button', { name: `Open ${first.title}` })).getByText(first.owner.machineName)).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: `Open ${second.title}` })).getByText(second.owner.machineName)).toBeInTheDocument()
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
    const onLink = vi.fn()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Target task" taskReady localOwnerId={local.owner.clientId}
      bindings={{ 'T-0003': [{ id: remote.sessionId, title: 'Remote work', owner: remote.owner, agentHost: remote }] }}
      onLink={onLink} onDevices={vi.fn()} onClose={onClose} />)

    await userEvent.setup().click(screen.getByRole('tab', { name: 'Link' }))
    await screen.findByRole('region', { name: 'Host session Local work' })
    expect(screen.getByRole('combobox', { name: 'Session location' })).toHaveValue('local')
    expect(screen.queryByRole('region', { name: 'Host session Remote work' })).not.toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Session location' }), 'all')
    const remoteRow = screen.getByRole('region', { name: 'Host session Remote work' })
    expect(within(remoteRow).getByText('Linked to T-0003')).toBeInTheDocument()
    expect(within(remoteRow).getByRole('button', { name: 'Link Remote work to T-0002' })).toBeDisabled()
    expect(onLink).not.toHaveBeenCalled()

    expect(screen.queryByRole('button', { name: 'Back to tasks' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide session sidebar' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reorders linked sessions via drag-and-drop and Alt+ArrowUp/Down without activating or rebinding', async () => {
    const first = binding('drag-first', 'First session')
    const second = binding('drag-second', 'Second session')
    const third = binding('drag-third', 'Third session')
    window.agentHost = bridge()
    const onSelect = vi.fn()
    const onReorder = vi.fn()
    const user = userEvent.setup()

    function StatefulSidebar() {
      const [items, setItems] = useState([first, second, third])
      return <AgentHostSessionsSidebar taskId="T-0002" taskTitle="Reorder task" taskReady
        bindings={{ 'T-0002': items }} activeKey={sessionBindingKey(second)} onSelect={onSelect}
        onReorder={(orderedKeys) => {
          onReorder(orderedKeys)
          setItems((current) => orderedKeys.map((key) => current.find((item) => sessionBindingKey(item) === key)!))
        }}
        onDetach={vi.fn(async () => {})} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />
    }

    render(<StatefulSidebar />)
    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    const labels = () => within(tree).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))
    expect(labels()).toEqual(['First session', 'Second session', 'Third session'])

    const thirdItem = within(tree).getByRole('treeitem', { name: 'Third session' })
    expect(within(thirdItem).queryByRole('button', { name: 'Unlink Third session' })).not.toBeInTheDocument()

    // Dragging on an action icon button in the row header is prevented and does not reorder.
    const showDetailsButton = within(thirdItem).getByRole('button', { name: 'Show details for Third session' })
    expect(fireEvent.dragStart(showDetailsButton)).toBe(false)
    expect(onReorder).not.toHaveBeenCalled()

    await user.click(showDetailsButton)
    expect(thirdItem).toHaveAttribute('aria-expanded', 'true')
    expect(within(within(thirdItem).getByRole('group', { name: 'Details for Third session' })).getByRole('button', { name: 'Unlink Third session' })).toBeEnabled()

    // Dragging Third session onto First session moves it to the top and keeps its expansion attached.
    const thirdRow = thirdItem.querySelector('.session-tree-row')!
    const firstItem = within(tree).getByRole('treeitem', { name: 'First session' })
    fireEvent.dragStart(thirdRow)
    expect(thirdRow).toHaveAttribute('data-dragging', 'true')
    fireEvent.dragOver(firstItem)
    expect(firstItem).toHaveAttribute('data-drop', 'before')
    fireEvent.drop(firstItem)
    expect(labels()).toEqual(['Third session', 'First session', 'Second session'])
    expect(onReorder).toHaveBeenLastCalledWith([first, second, third].length ? [third, first, second].map(sessionBindingKey) : [])
    expect(within(tree).getByRole('treeitem', { name: 'Third session' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(tree).getByRole('treeitem', { name: 'Second session' })).toHaveAttribute('aria-selected', 'true')
    expect(onSelect).not.toHaveBeenCalled()

    // Keyboard Alt+ArrowDown moves the focused session down while preserving focus.
    const movedThird = within(tree).getByRole('treeitem', { name: 'Third session' })
    movedThird.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(labels()).toEqual(['First session', 'Third session', 'Second session'])
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(labels()).toEqual(['Third session', 'First session', 'Second session'])
    expect(onSelect).not.toHaveBeenCalled()
    expect(window.agentHost.watch).not.toHaveBeenCalled()
  })

  it('smart-sorts sessions by last response, creation time, and name, and switches back to manual on drag', async () => {
    const s1 = binding('sort-1', 'Zeta session')
    const s2 = binding('sort-2', 'Alpha session')
    const s3 = binding('sort-3', 'Beta session')
    window.agentHost = bridge([
      { ...s1.agentHost, title: s1.title, provider: 'copilotcli', createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-12T10:00:00Z', canSend: true },
      { ...s2.agentHost, title: s2.title, provider: 'copilotcli', createdAt: '2026-11-12T10:00:00Z', updatedAt: '2026-11-16T15:00:00Z', canSend: true },
      { ...s3.agentHost, title: s3.title, provider: 'copilotcli', createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T12:00:00Z', canSend: true },
    ])
    const onReorder = vi.fn()
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar taskId="T-0002" taskTitle="Smart sort" taskReady
      bindings={{ 'T-0002': [s1, s2, s3] }} onReorder={onReorder} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    const tree = await screen.findByRole('tree', { name: 'Sessions for T-0002' })
    const sortTrigger = screen.getByRole('button', { name: 'Sort sessions' })
    const labels = () => within(tree).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))
    await screen.findByRole('treeitem', { name: 'Alpha session' })
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
    expect(sortTrigger).toHaveTextContent('Manual')

    async function chooseSort(optionName: RegExp | string) {
      await user.click(sortTrigger)
      const listbox = screen.getByRole('listbox', { name: 'Sort sessions by' })
      await user.click(within(listbox).getByRole('option', { name: optionName }))
    }

    await chooseSort('Last response')
    expect(sortTrigger).toHaveTextContent('Last response')
    expect(labels()).toEqual(['Alpha session', 'Beta session', 'Zeta session'])

    await chooseSort('Created (newest)')
    expect(labels()).toEqual(['Beta session', 'Alpha session', 'Zeta session'])

    await chooseSort('Created (oldest)')
    expect(labels()).toEqual(['Zeta session', 'Alpha session', 'Beta session'])

    await chooseSort('Name (A–Z)')
    expect(labels()).toEqual(['Alpha session', 'Beta session', 'Zeta session'])

    // Escape closes the sort menu and returns focus to the trigger.
    await user.click(sortTrigger)
    expect(screen.getByRole('listbox', { name: 'Sort sessions by' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Sort sessions by' })).not.toBeInTheDocument()
    expect(sortTrigger).toHaveFocus()

    // Dragging Zeta to the top transitions sort mode back to manual.
    const zetaRow = within(tree).getByRole('treeitem', { name: 'Zeta session' }).querySelector('.session-tree-row')!
    const alphaItem = within(tree).getByRole('treeitem', { name: 'Alpha session' })
    fireEvent.dragStart(zetaRow)
    fireEvent.dragOver(alphaItem)
    fireEvent.drop(alphaItem)
    expect(sortTrigger).toHaveTextContent('Manual')
    expect(onReorder).toHaveBeenCalledExactlyOnceWith([s1, s2, s3].map(sessionBindingKey))
  })

  it('expands the requested session details and reveals Unlink when expandSession is triggered', async () => {
    const first = binding('expand-first', 'First session')
    const second = binding('expand-second', 'Second session')
    window.agentHost = bridge()
    const onDetach = vi.fn(async () => {})
    const user = userEvent.setup()
    const { rerender } = render(<AgentHostSessionsSidebar taskId="T-0002" taskReady initialView="link"
      bindings={{ 'T-0002': [first, second] }} onDetach={onDetach} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('tab', { name: 'Link' })).toHaveAttribute('aria-selected', 'true')
    rerender(<AgentHostSessionsSidebar taskId="T-0002" taskReady initialView="link"
      bindings={{ 'T-0002': [first, second] }} expandSession={{ key: sessionBindingKey(second), id: 1 }}
      onDetach={onDetach} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    const tree = screen.getByRole('tree', { name: 'Sessions for T-0002' })
    expect(within(tree).getByRole('treeitem', { name: 'First session' })).toHaveAttribute('aria-expanded', 'false')
    const secondItem = within(tree).getByRole('treeitem', { name: 'Second session' })
    expect(secondItem).toHaveAttribute('aria-expanded', 'true')
    await user.click(within(secondItem).getByRole('button', { name: 'Unlink Second session' }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    expect(onDetach).toHaveBeenCalledExactlyOnceWith(second)
  })
})
