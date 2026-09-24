import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHostKey } from '../src/shared/agentHost'
import type { AgentHostBridge, AgentHostSession, AgentHostView } from '../src/shared/agentHost'
import { useSessionTitles } from '../src/renderer/chat/useSessionTitles'
import type { SessionTitleUpdate } from '../src/renderer/chat/useSessionTitles'
import { AgentHostPanel } from '../src/renderer/components/AgentHostPanel'
import { AgentHostSessionsSidebar } from '../src/renderer/components/AgentHostSessionsSidebar'
import { fixtureTasks } from './task-fixture'

afterEach(() => { delete window.agentHost })

function session(title = 'Remembered chat'): AgentHostSession {
  return {
    owner: { clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Owner-B' },
    sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original/main', title,
    provider: 'copilotcli', canSend: true, updatedAt: '2026-09-24T14:00:00.000Z',
  }
}

describe('local last-known session titles', () => {
  it('persists display titles across remount and isolates workspace, owner, session and chat identities', () => {
    const first = session()
    const otherOwner = { ...first, owner: { ...first.owner, clientId: '00000000-0000-4000-8000-000000000002' } }
    const otherChat = { ...first, chatId: 'ahp-chat:/another/main' }
    const otherSession = { ...first, sessionId: 'copilotcli:/another' }
    const mounted = renderHook(({ workspace }) => useSessionTitles(workspace), { initialProps: { workspace: 'workspace-one' } })
    act(() => mounted.result.current.remember([first]))
    expect(mounted.result.current.titles[agentHostKey(first)]).toBe(first.title)
    for (const target of [otherOwner, otherChat, otherSession]) expect(mounted.result.current.titles[agentHostKey(target)]).toBeUndefined()
    mounted.rerender({ workspace: 'workspace-two' })
    expect(mounted.result.current.titles).toEqual({})
    mounted.rerender({ workspace: 'workspace-one' })
    expect(mounted.result.current.titles[agentHostKey(first)]).toBe(first.title)
    mounted.unmount()
    const restored = renderHook(() => useSessionTitles('workspace-one'))
    expect(restored.result.current.titles[agentHostKey(first)]).toBe(first.title)
  })

  it('ignores missing/placeholder titles and older snapshots, but accepts a newer rename', () => {
    const first = session()
    const hook = renderHook(() => useSessionTitles('workspace'))
    act(() => hook.result.current.remember([first]))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    for (const title of ['', '  ', first.sessionId, first.chatId, 'Agent Host', 'New Copilot chat', 'Untitled chat']) {
      act(() => hook.result.current.remember([{ ...first, title, updatedAt: '2026-09-24T14:02:00.000Z' }]))
    }
    act(() => hook.result.current.remember([{ ...first, title: 'Older name', updatedAt: '2026-09-24T13:59:00.000Z' }]))
    expect(hook.result.current.titles[agentHostKey(first)]).toBe(first.title)
    expect(writes).not.toHaveBeenCalled()
    act(() => hook.result.current.remember([{ ...first, title: 'Renamed chat', updatedAt: '2026-09-24T14:03:00.000Z' }]))
    expect(hook.result.current.titles[agentHostKey(first)]).toBe('Renamed chat')
    expect(writes).toHaveBeenCalledOnce()
    for (let index = 0; index < 20; index++) act(() => hook.result.current.remember([{ ...first, title: 'Renamed chat', updatedAt: '2026-09-24T14:04:00.000Z' }]))
    expect(writes).toHaveBeenCalledOnce()
  })

  it('bounds persisted metadata and never stores permissions or connection state', () => {
    const hook = renderHook(() => useSessionTitles('workspace'))
    const updates = Array.from({ length: 300 }, (_, index) => ({ ...session(`Chat ${index}`), sessionId: `copilotcli:/${index}`, chatId: `ahp-chat:/${index}` }))
    act(() => hook.result.current.remember(updates))
    expect(Object.keys(hook.result.current.titles)).toHaveLength(256)
    expect(hook.result.current.titles[agentHostKey(updates[0])]).toBeUndefined()
    expect(hook.result.current.titles[agentHostKey(updates[299])]).toBe('Chat 299')
    const stored = localStorage.getItem(localStorage.key(0)!)!
    expect(JSON.parse(stored).entries).toHaveLength(256)
    for (const field of ['canSend', 'connected', 'machineName', 'provider']) expect(stored).not.toContain(field)
  })

  it('reports unavailable storage but keeps live titles in memory', () => {
    const hook = renderHook(() => useSessionTitles('workspace'))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage denied.') })
    act(() => hook.result.current.remember([session()]))
    expect(hook.result.current.titles[agentHostKey(session())]).toBe('Remembered chat')
    expect(hook.result.current.error).toContain('only until this workspace closes')
    expect(localStorage.length).toBe(0)
  })

  it('reports corrupt or unreadable cached data instead of accepting it as authority', () => {
    const hook = renderHook(() => useSessionTitles('workspace'))
    act(() => hook.result.current.remember([session()]))
    localStorage.setItem(localStorage.key(0)!, '{broken')
    hook.unmount()
    const corrupted = renderHook(() => useSessionTitles('workspace'))
    expect(corrupted.result.current.titles).toEqual({})
    expect(corrupted.result.current.error).toContain('invalid')
    corrupted.unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage denied.') })
    const denied = renderHook(() => useSessionTitles('workspace'))
    expect(denied.result.current.titles).toEqual({})
    expect(denied.result.current.error).toContain('could not be read')
  })
})

function fixture() {
  const known = session()
  const target = { sessionId: known.sessionId, chatId: known.chatId, owner: known.owner }
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = { target, state: 'connected', canSend: true, readOnly: false, terminals: {},
    chat: { resource: target.chatId, title: known.title, modifiedAt: known.updatedAt, status: 1, turns: [] } }
  const bridge = {
    list: vi.fn(async () => ({ sessions: [known], warnings: [] as string[] })),
    onView: (listener: Parameters<AgentHostBridge['onView']>[0]) => { listeners.add(listener); return () => listeners.delete(listener) },
    watch: vi.fn(async () => { for (const listener of listeners) listener({ id: 'watch', view: structuredClone(view) }); return 'watch' }),
    unwatch: vi.fn(async () => {}), terminal: vi.fn(async () => {}), releaseTerminal: vi.fn(async () => {}),
    models: vi.fn(async () => []), send: vi.fn(async () => {}), resolveDelivery: vi.fn(async () => 'not-found' as const), cancel: vi.fn(async () => {}),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []), create: vi.fn(async () => { throw new Error('No automatic creation.') }),
    creationStatus: vi.fn(async () => { throw new Error('No creation operation.') }), bindCreation: vi.fn(async () => { throw new Error('No binding operation.') }),
    abandonCreation: vi.fn(async () => { throw new Error('No abandonment operation.') }),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []), createLocal: vi.fn(async () => { throw new Error('No automatic local creation.') }),
    localCreationStatus: vi.fn(async () => { throw new Error('No local creation operation.') }),
  }
  window.agentHost = bridge
  const binding = { id: target.sessionId, title: 'Agent Host', owner: target.owner, ownerIsRemote: true, agentHost: target }
  const onSelect = vi.fn()
  function Workspace({ panel = false }: { panel?: boolean }) {
    const titles = useSessionTitles('workspace')
    return <>
      <AgentHostSessionsSidebar taskId={fixtureTasks[1].id} taskTitle="Task" taskReady localOwnerId="caller"
        bindings={{ [fixtureTasks[1].id]: [binding] }} cachedTitles={titles.titles} titleCacheError={titles.error} onTitles={titles.remember}
        onSelect={onSelect} onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />
      {panel && <AgentHostPanel task={fixtureTasks[1]} target={target} cachedTitle={titles.titles[agentHostKey(target)]} onTitles={titles.remember} onDetach={vi.fn()} onClose={vi.fn()} />}
    </>
  }
  return { Workspace, bridge, binding, onSelect, known, view, emit: (next = view) => { for (const listener of listeners) listener({ id: 'watch', view: structuredClone(next) }) } }
}

describe('cached titles in the session sidebar and chat header', () => {
  it('retains titles across partial discovery, failed refresh and workspace restart without pretending the chat is online', async () => {
    const f = fixture()
    const user = userEvent.setup()
    const mounted = render(<f.Workspace />)
    await screen.findByRole('treeitem', { name: f.known.title })
    f.bridge.list.mockResolvedValue({ sessions: [], warnings: [] })
    await user.click(screen.getByRole('button', { name: 'Refresh Agent Host sessions' }))
    await screen.findByText('Not in discovery list')
    expect(screen.getByRole('treeitem', { name: f.known.title })).toBeInTheDocument()
    expect(screen.getByText(f.known.title)).toHaveAttribute('title', 'Last known title saved on this device')
    f.bridge.list.mockRejectedValue(new Error('Discovery unavailable.'))
    await user.click(screen.getByRole('button', { name: 'Refresh Agent Host sessions' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Agent Host sessions' })).toBeEnabled())
    expect(screen.getByRole('treeitem', { name: f.known.title })).toBeInTheDocument()
    mounted.unmount()
    render(<f.Workspace />)
    expect(screen.getByRole('treeitem', { name: f.known.title })).toBeInTheDocument()
    expect(screen.getByText('Not in discovery list')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Open ${f.known.title}` }))
    expect(f.onSelect).toHaveBeenCalledExactlyOnceWith(f.binding)
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Discovery unavailable.')
    expect(screen.queryByRole('region', { name: /^Host session / })).not.toBeInTheDocument()
    expect(f.bridge.create).not.toHaveBeenCalled()
    expect(f.bridge.send).not.toHaveBeenCalled()
    expect(f.bridge.watch).not.toHaveBeenCalled()
  })

  it('updates the sidebar from live renames without another catalogue request or reconnect and restores the header offline', async () => {
    const f = fixture()
    const mounted = render(<f.Workspace panel />)
    await screen.findByRole('treeitem', { name: f.known.title })
    await waitFor(() => expect(f.bridge.watch).toHaveBeenCalledOnce())
    f.view.chat!.title = 'Updated live title'
    f.view.chat!.modifiedAt = '2026-09-24T14:02:00.000Z'
    act(() => f.emit())
    expect(screen.getByRole('treeitem', { name: 'Updated live title' })).toBeInTheDocument()
    expect(within(screen.getByRole('complementary', { name: 'Agent Host task chat' })).getByText('Updated live title')).toBeInTheDocument()
    act(() => f.emit({ ...f.view, target: { ...f.view.target, chatId: 'ahp-chat:/different' }, chat: { ...f.view.chat!, title: 'Wrong chat' } }))
    expect(screen.queryByText('Wrong chat')).not.toBeInTheDocument()
    expect(f.bridge.watch).toHaveBeenCalledOnce()
    expect(f.bridge.list).toHaveBeenCalledOnce()
    mounted.unmount()
    f.view.state = 'offline'
    f.view.canSend = false
    f.view.readOnly = true
    f.view.chat = undefined
    f.bridge.list.mockResolvedValue({ sessions: [], warnings: [] })
    render(<f.Workspace panel />)
    expect(screen.getByRole('treeitem', { name: 'Updated live title' })).toBeInTheDocument()
    const panel = screen.getByRole('complementary', { name: 'Agent Host task chat' })
    expect(within(panel).getByText('Updated live title')).toBeInTheDocument()
    expect(await within(panel).findByText('Offline history')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(f.bridge.send).not.toHaveBeenCalled()
  })

  it('surfaces title-cache storage errors without removing the real discovered title', async () => {
    const f = fixture()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded.') })
    render(<f.Workspace />)
    expect(await screen.findByRole('treeitem', { name: f.known.title })).toBeInTheDocument()
    expect(screen.getByText(/Chat titles could not be saved/)).toHaveAttribute('role', 'status')
  })

  it('does not add previously seen titles to an empty task or the link catalogue', async () => {
    const f = fixture()
    const hook = renderHook(() => useSessionTitles('workspace'))
    act(() => hook.result.current.remember([f.known] satisfies SessionTitleUpdate[]))
    f.bridge.list.mockResolvedValue({ sessions: [], warnings: [] })
    render(<AgentHostSessionsSidebar taskId="T-0099" taskReady cachedTitles={hook.result.current.titles}
      onLink={vi.fn()} onDevices={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('treeitem', { name: f.known.title })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Link' }))
    expect(await screen.findByText('No available Agent Host sessions.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^Host session / })).not.toBeInTheDocument()
  })
})
