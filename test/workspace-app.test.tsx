import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import { fixtureTasks } from './task-fixture'
import { workspaceBridgeFixture } from './workspace-ui-fixture'
import type { WorkspaceBridge, WorkspaceSnapshot, WorkspaceState } from '../src/shared/workspace'
import { taskSessionLinks } from '../src/shared/sessionBindings'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import type { AgentHostBridge, AgentHostSession, AgentHostTarget, AgentHostView } from '../src/shared/agentHost'
import type { AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import { agentHostTargetFixture } from './immutable-bindings-fixture'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { delete window.workspace; delete window.agentHost; delete window.remoteVSCode; vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixtures() {
  const first: WorkspaceSnapshot = { id: 'workspace-one', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [{ ...fixtureTasks[1], title: 'Actual UI task', status: 'done', documents: { requirements: '# Actual requirements\n\nSaved in the first workspace.', plan: '# Actual plan\n\nA persisted plan.', checklist: null } }], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }
  const second: WorkspaceSnapshot = { ...first, id: 'workspace-two', name: 'Other-ad', root: 'Q:\\src\\Projects\\Other-ad', tasks: [{ ...first.tasks[0], title: 'Different task with same ID', status: 'blocked' }] }
  let state: WorkspaceState = { current: null, recent: [first, second] }
  const repository: Record<string, SessionLinksSnapshot> = {}
  let revision = 0
  const bridge: WorkspaceBridge = {
    ...workspaceBridgeFixture(),
    getState: vi.fn(async () => state),
    openFolder: vi.fn(async () => { state = { ...state, current: first }; return state }),
    openRecent: vi.fn(async (id) => { state = { ...state, current: id === first.id ? first : second }; return state }),
    refresh: vi.fn(async () => state),
    closeWorkspace: vi.fn(async () => { state = { ...state, current: null }; return state }),
    getSessionLinks: vi.fn(async (id) => repository[id] ?? { document: { schemaVersion: '2.1', bindings: {} }, revision: null }),
    updateSessionLink: vi.fn(async (request) => {
      if (request.expectedRevision !== (repository[request.workspaceId]?.revision ?? null)) throw new Error('Workspace session links changed.')
      const current = repository[request.workspaceId]?.document.bindings ?? {}
      const bindings = Object.fromEntries(Object.keys(current).map((taskId) => [taskId, [...taskSessionLinks(current, taskId)]]))
      if (request.sessionId === null) {
        if (!request.detachTarget) throw new Error('An exact detach target is required.')
        const remaining = (bindings[request.taskId] ?? []).filter((link) =>
          link.sessionId !== request.detachTarget!.sessionId
          || link.chatId !== request.detachTarget!.chatId
          || link.owner.clientId !== request.detachTarget!.owner.clientId)
        if (remaining.length) bindings[request.taskId] = remaining
        else delete bindings[request.taskId]
      } else {
        if (!request.agentHost || !request.owner) throw new Error('An owned Agent Host target is required.')
        const link = { provider: 'agent-host' as const, ...request.agentHost, sessionId: request.sessionId, owner: request.owner }
        bindings[request.taskId] = [...(bindings[request.taskId] ?? []).filter((item) =>
          item.sessionId !== link.sessionId || item.owner.clientId !== link.owner.clientId), link]
      }
      return repository[request.workspaceId] = { document: { schemaVersion: '2.1', bindings }, revision: (++revision).toString(16).padStart(64, '0') }
    }),
  }
  window.workspace = bridge
  return { bridge, first, second, repository }
}

function creationFixture() {
  const workspace = fixtures()
  const owner = { clientId: crypto.randomUUID(), machineName: 'Creation-worker' }
  const target = { sessionId: 'ahp-session:/new-chat', chatId: 'ahp-chat:/new-chat/main', owner }
  const session: AgentHostSession = { ...target, title: 'Created chat', provider: 'copilotcli', updatedAt: '', canSend: true }
  const worker: AgentHostWorker = { id: 'paired-worker', owner, state: 'connected', hosts: [{ hostId: 'exact-host-123', name: 'Native Host', available: true }], workspaces: [{ id: 'worker-workspace', name: 'Worker project', canSend: true, taskState: 'available', expectedRevision: 'd'.repeat(64) }] }
  const saved = new Map<string, AgentHostCreation>()
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const watched = new Map<string, AgentHostView>()
  const agentHost: AgentHostBridge = {
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []),
    createLocal: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    localCreationStatus: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    list: vi.fn(async () => ({ sessions: [], warnings: [] })), creationWorkers: vi.fn(async () => [worker]),
    creations: vi.fn(async (taskId) => [...saved.values()].filter((operation) => operation.taskId === taskId)),
    create: vi.fn(async (request) => {
      const operation: AgentHostCreation = { ...request, state: 'ready', session }
      saved.set(request.operationId, operation)
      const current = workspace.repository[workspace.first.id]?.document.bindings ?? {}
      workspace.repository[workspace.first.id] = { document: { schemaVersion: '2.1', bindings: { ...current, [request.taskId]: [...taskSessionLinks(current, request.taskId), { provider: 'agent-host', ...target }] } }, revision: 'e'.repeat(64) }
      return operation
    }),
    creationStatus: vi.fn(async (id) => saved.get(id)!),
    bindCreation: vi.fn(async (id) => saved.get(id)!),
    models: vi.fn(async () => [{ id: 'ui-model', name: 'UI model', provider: 'copilotcli' }]),
    watch: vi.fn(async (target: AgentHostTarget) => {
      const id = crypto.randomUUID()
      const view: AgentHostView = { target, state: 'connected', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Original Host chat', modifiedAt: '', status: 1, turns: [] } }
      watched.set(id, view)
      for (const listener of listeners) listener({ id, view })
      return id
    }),
    unwatch: vi.fn(async (id) => { watched.delete(id) }), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onView: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  window.agentHost = agentHost
  return { ...workspace, agentHost, target, saved }
}

async function selectCreationTarget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
  expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Agent Host sessions' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: 'Create' }))
  await screen.findByRole('option', { name: /Creation-worker/ })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Remote worker' })).toBeEnabled())
  await user.selectOptions(screen.getByRole('combobox', { name: 'Remote worker' }), 'paired-worker')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Shared worker workspace' }), 'worker-workspace')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'exact-host-123')
}

describe('workspace switching in the desktop workbench', () => {
  it('does not select a replacement chat when the created binding changes during reload', async () => {
    const { bridge, first, repository, agentHost, target } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Keep selected task' })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await user.click(screen.getByRole('button', { name: 'T-0003 Keep selected task' }))
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    await selectCreationTarget(user)
    let finishReload!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.getSessionLinks).mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve }))
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(finishReload).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('tab', { name: 'Keep selected task' }))
    const replacement = { ...target, sessionId: 'ahp-session:/replacement', chatId: 'ahp-chat:/replacement/main' }
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...replacement }] } }, revision: 'f'.repeat(64) }
    await act(async () => { finishReload(repository[first.id]) })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Keep selected task'))
    expect(agentHost.watch).not.toHaveBeenCalled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('keeps the selected task when creation finishes, then exposes the saved session on its original task', async () => {
    const { bridge, first, repository, agentHost, target } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Other task draft' })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await user.click(screen.getByRole('button', { name: 'T-0003 Other task draft' }))
    expect(screen.queryByRole('textbox', { name: /Message/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    expect(agentHost.create).not.toHaveBeenCalled()
    await selectCreationTarget(user)
    let finishReload!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.getSessionLinks).mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve }))
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(finishReload).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('tab', { name: 'Other task draft' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Other task draft')
    await act(async () => { finishReload(repository[first.id]) })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Other task draft')
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Agent Host sessions' })).not.toBeInTheDocument()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), taskId: 'T-0002', workerId: 'paired-worker', workspaceId: 'worker-workspace', hostId: 'exact-host-123', expectedRevision: 'd'.repeat(64) })
    expect(agentHost.send).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    await user.click(await screen.findByRole('button', { name: `Open ${target.sessionId}` }))
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledWith(target))
    expect(await screen.findByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Unlink ${target.sessionId}` }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /Message/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Browse Agent Host sessions' })).toBeInTheDocument()
  })

  it('retains a ready operation for recovery when reloading its saved binding fails', async () => {
    const { bridge, agentHost } = creationFixture()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await selectCreationTarget(user)
    vi.mocked(bridge.getSessionLinks).mockRejectedValueOnce(new Error('Saved links could not be read.'))
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    const sidebar = screen.getByRole('complementary', { name: 'Agent Host sessions' })
    expect(await screen.findByText(/Saved links could not be read/)).toBeInTheDocument()
    expect(within(sidebar).getByText('ahp-session:/new-chat')).toBeInTheDocument()
    await user.click(within(sidebar).getByRole('button', { name: 'Open created chat' }))
    expect(await screen.findByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Agent Host sessions' })).not.toBeInTheDocument()
    expect(agentHost.create).toHaveBeenCalledTimes(1)
    expect(agentHost.bindCreation).not.toHaveBeenCalled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('does not apply an old creation callback in a new workspace with the same task ID', async () => {
    const { bridge, first, second, repository, agentHost } = creationFixture()
    const user = userEvent.setup()
    const original = render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await selectCreationTarget(user)
    let finishReload!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.getSessionLinks).mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve }))
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(finishReload).toBeTypeOf('function'))
    original.unmount()
    const secondTarget = agentHostTargetFixture('existing-second-workspace')
    const secondSnapshot: SessionLinksSnapshot = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...secondTarget }] } }, revision: 'b'.repeat(64) }
    repository[second.id] = secondSnapshot
    await bridge.openRecent(second.id)
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Different task with same ID' })
    await user.type(await screen.findByRole('textbox', { name: 'Message Agent Host' }), 'Keep the new workspace draft')
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep the new workspace draft')
    await act(async () => { finishReload(repository[first.id]) })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Different task with same ID')
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep the new workspace draft')
    expect(screen.getByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    expect(agentHost.watch).toHaveBeenLastCalledWith(secondTarget)
    expect(repository[second.id]).toEqual(secondSnapshot)
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledTimes(1)
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('does not replace a newly opened sessions sidebar when an old creation completion arrives', async () => {
    const { bridge, first, repository, agentHost } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'New picker task' })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await selectCreationTarget(user)
    let finishReload!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.getSessionLinks).mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve }))
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(finishReload).toBeTypeOf('function'))
    await user.click(screen.getByRole('button', { name: 'Hide session sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.click(screen.getByRole('button', { name: 'T-0003 New picker task' }))
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    await act(async () => { finishReload(repository[first.id]) })
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New picker task')
    await user.click(screen.getByRole('tab', { name: 'Create' }))
    expect(screen.getByRole('button', { name: 'Create and assign to T-0003' })).toBeInTheDocument()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledTimes(1)
  })

  it('allows another native session to be created for a task that already has one', async () => {
    const { first, repository, agentHost } = creationFixture()
    const existing = agentHostTargetFixture('existing-chat')
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...existing }] } }, revision: 'b'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await selectCreationTarget(user)
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(agentHost.create).toHaveBeenCalledOnce())
    expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0002')).toHaveLength(2)
  })

  it('explicitly reconfirms an existing Agent Host link and retries access without losing its draft', async () => {
    const { bridge, first, repository, agentHost, target } = creationFixture()
    const snapshot: SessionLinksSnapshot = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64), localOwner: target.owner }
    repository[first.id] = snapshot
    vi.mocked(agentHost.list).mockResolvedValue({ sessions: [{ ...target, title: 'Original Host chat', provider: 'copilotcli', updatedAt: '', canSend: true }], warnings: [] })
    const message = 'A Git-only edit cannot grant local Agent Host access. Confirm the link on its owner.'
    vi.mocked(agentHost.watch).mockRejectedValueOnce(new Error(message))
    vi.mocked(agentHost.models).mockRejectedValueOnce(new Error(message))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    const panel = await screen.findByRole('complementary', { name: 'Agent Host task chat' })
    await waitFor(() => expect(within(panel).getAllByRole('alert')).toHaveLength(2))
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    await user.type(within(panel).getByRole('textbox', { name: 'Message Agent Host' }), 'Keep this unsent draft')
    await user.click(within(panel).getByRole('button', { name: 'Review session link' }))
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    await user.click(await screen.findByRole('button', { name: 'Link Original Host chat to T-0002' }))
    await waitFor(() => expect(bridge.updateSessionLink).toHaveBeenCalledExactlyOnceWith({
      workspaceId: first.id, taskId: 'T-0002', sessionId: target.sessionId,
      agentHost: { chatId: target.chatId }, owner: target.owner, expectedRevision: snapshot.revision,
    }))
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledTimes(2))
    expect(agentHost.watch).toHaveBeenLastCalledWith(target)
    expect(agentHost.models).toHaveBeenCalledTimes(2)
    expect(within(panel).getByText('Connected', { exact: true })).toBeInTheDocument()
    expect(within(panel).queryAllByRole('alert')).toEqual([])
    expect(within(panel).getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep this unsent draft')
    expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0002')).toEqual([{ provider: 'agent-host', ...target }])
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('opens the exact AHP Git link without creating, sending or cancelling a session', async () => {
    const { first, repository, agentHost, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64), localOwner: target.owner }
    const user = userEvent.setup()
    const view = render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledWith(target))
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
    expect(agentHost.cancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary', { name: 'VS Code task chat' })).not.toBeInTheDocument()
    view.unmount()
    await waitFor(() => expect(agentHost.unwatch).toHaveBeenCalledOnce())
    expect(agentHost.cancel).not.toHaveBeenCalled()
  })

  it('manages multiple task sessions without replacing links or losing per-session drafts', async () => {
    const { bridge, first, repository, agentHost } = creationFixture()
    const sessionA = agentHostTargetFixture('session-a')
    const sessionB = agentHostTargetFixture('session-b')
    const sessionC = agentHostTargetFixture('session-c')
    repository[first.id] = {
      document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...sessionA }, { provider: 'agent-host', ...sessionB }] } },
      revision: 'a'.repeat(64),
    }
    vi.mocked(agentHost.list).mockResolvedValue({
      sessions: [
        { ...sessionA, title: 'Session A', provider: 'copilotcli', updatedAt: '', canSend: true },
        { ...sessionB, title: 'Session B', provider: 'copilotcli', updatedAt: '', canSend: true },
        { ...sessionC, title: 'Session C', provider: 'copilotcli', updatedAt: '', canSend: true },
      ],
      warnings: [],
    })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    const firstDraft = await screen.findByRole('textbox', { name: 'Message Agent Host' })
    await user.type(firstDraft, 'Draft for session A')
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    const sidebar = screen.getByRole('complementary', { name: 'Agent Host sessions' })
    const tree = within(sidebar).getByRole('tree', { name: 'Sessions for T-0002' })
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3)
    expect(within(tree).getByRole('treeitem', { name: 'Session A' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Agent Host sessions' })).not.toBeInTheDocument()

    await user.click(within(tree).getByRole('button', { name: 'Open Session B' }))
    await user.type(await screen.findByRole('textbox', { name: 'Message Agent Host' }), 'Draft for session B')
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    await user.click(screen.getByRole('button', { name: 'Open Session A' }))
    expect(await screen.findByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft for session A')

    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    await user.click(await screen.findByRole('button', { name: 'Link Session C to T-0002' }))
    await waitFor(() => expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0002')).toHaveLength(3))
    expect(screen.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Unlink Session A' }))
    await user.click(within(screen.getByRole('region', { name: 'Detach conversation' })).getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0002').map((link) => link.sessionId)).toEqual([sessionB.sessionId, sessionC.sessionId]))
    expect(screen.getByRole('button', { name: 'Open Session B' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Unlink Session C' }))
    await user.click(within(screen.getByRole('region', { name: 'Detach conversation' })).getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(screen.getByText(/Choose a linked session for T-0002/)).toBeInTheDocument())
    expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0002')).toEqual([{ provider: 'agent-host', ...sessionB }])
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
    expect(agentHost.cancel).not.toHaveBeenCalled()
    expect(bridge.updateSessionLink).toHaveBeenCalledTimes(3)
  })

  it('preserves the selected session and its draft across compact sidebar and chat pane switches', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
    }))
    const { bridge, first, repository, agentHost } = creationFixture()
    const sessionA = agentHostTargetFixture('compact-a')
    const sessionB = agentHostTargetFixture('compact-b')
    repository[first.id] = {
      document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...sessionA }, { provider: 'agent-host', ...sessionB }] } },
      revision: 'a'.repeat(64),
    }
    vi.mocked(agentHost.list).mockResolvedValue({
      sessions: [
        { ...sessionA, title: 'Compact A', provider: 'copilotcli', updatedAt: '', canSend: true },
        { ...sessionB, title: 'Compact B', provider: 'copilotcli', updatedAt: '', canSend: true },
      ],
      warnings: [],
    })
    const user = userEvent.setup()
    await bridge.openFolder()
    render(<App />)
    await screen.findByRole('textbox', { name: 'Message Agent Host' })

    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    const tree = await screen.findByRole('tree', { name: 'Sessions for T-0002' })
    await user.click(within(tree).getByRole('button', { name: 'Open Compact B' }))
    const panel = await screen.findByRole('complementary', { name: 'Agent Host task chat' })
    expect(screen.getByRole('button', { name: 'Toggle chat panel' })).toHaveAttribute('aria-pressed', 'true')
    await user.type(within(panel).getByRole('textbox', { name: 'Message Agent Host' }), 'Compact session B draft')

    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    const reopenedTree = await screen.findByRole('tree', { name: 'Sessions for T-0002' })
    expect(within(reopenedTree).getByRole('treeitem', { name: 'Compact B' })).toHaveAttribute('aria-selected', 'true')
    await user.click(within(reopenedTree).getByRole('button', { name: 'Open Compact B' }))
    expect(await screen.findByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Compact session B draft')
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
    expect(agentHost.cancel).not.toHaveBeenCalled()
  })

  it('opens real tasks and documents, then closes to an empty workbench', async () => {
    const { first } = fixtures()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue(first.id)
    expect(screen.getByRole('combobox', { name: 'Task status' })).toHaveValue('done')
    expect(screen.getByRole('combobox', { name: 'Task status' })).toBeDisabled()
    expect(screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).disabled)).toBe(true)
    expect(screen.queryByText('Sample task')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create demo task' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Requirements' }))
    expect(screen.getByText('Saved in the first workspace.')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), '')
    expect(await screen.findByRole('heading', { level: 1, name: 'Create your task repository' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create task repository' })).toBeEnabled()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('keeps the current workspace and draft if folder selection is cancelled or fails', async () => {
    const { bridge, first, repository, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.type(await screen.findByRole('textbox', { name: 'Message Agent Host' }), 'Keep my draft')
    vi.mocked(bridge.openFolder).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Not an AgentDesk workspace'))
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep my draft')
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not an AgentDesk workspace')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Actual UI task')
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep my draft')
  })

  it('isolates exact Agent Host identities across identical task IDs in different workspaces', async () => {
    const { first, second, repository, agentHost } = creationFixture()
    const firstTarget = agentHostTargetFixture('first-session')
    const secondTarget = agentHostTargetFixture('second-session')
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...firstTarget }] } }, revision: 'a'.repeat(64) }
    repository[second.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...secondTarget }] } }, revision: 'b'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledWith(firstTarget))
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'First workspace draft')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), second.id)
    expect(await screen.findByRole('heading', { level: 1, name: 'Different task with same ID' })).toBeInTheDocument()
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledWith(secondTarget))
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('')
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
    expect(agentHost.cancel).not.toHaveBeenCalled()
  })

  it('locks workspace changes during an explicit native send and releases them after completion', async () => {
    const { first, repository, target, agentHost } = creationFixture()
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64) }
    let finish!: () => void
    vi.mocked(agentHost.send).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('option', { name: 'UI model' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), 'ui-model')
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Continue')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Switch workspace folder' })).toBeDisabled()
    expect(agentHost.send).toHaveBeenCalledExactlyOnceWith(target, expect.any(String), 'Continue', undefined, { id: 'ui-model' })
    await act(async () => finish())
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled())
    expect(agentHost.create).not.toHaveBeenCalled()
  })

  it('refreshes actual task content without dropping the draft or selected task', async () => {
    const { bridge, first, repository, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.type(await screen.findByRole('textbox', { name: 'Message Agent Host' }), 'Draft stays here')
    vi.mocked(bridge.refresh).mockResolvedValue({ current: { ...first, tasks: [{ ...first.tasks[0], title: 'Changed on disk' }] }, recent: [first] })
    await user.click(screen.getByRole('button', { name: 'Refresh workspace' }))
    expect(await screen.findByRole('heading', { name: 'Changed on disk', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft stays here')
  })

  it('handles an empty real workspace without inventing demo tasks', async () => {
    const { bridge, first } = fixtures()
    vi.mocked(bridge.openFolder).mockResolvedValue({ current: { ...first, tasks: [] }, recent: [first] })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('heading', { name: 'No tasks in this workspace' })).toBeInTheDocument()
    expect(screen.queryByText('Sample task')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('does not discover or migrate old browser session links while opening a workspace', async () => {
    const { bridge, first } = fixtures()
    const key = `taskcontinuum:session-bindings:v1:${first.id}`
    const content = JSON.stringify({ 'T-0002': { id: 'legacy-session', title: 'Private conversation title' } })
    localStorage.setItem(key, content)
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    expect(screen.queryByRole('button', { name: 'Review links' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save links to workspace' })).not.toBeInTheDocument()
    expect(screen.queryByText('legacy-session')).not.toBeInTheDocument()
    expect(screen.queryByText('Private conversation title')).not.toBeInTheDocument()
    expect(bridge).not.toHaveProperty('migrateSessionLinks')
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(content)
  })

  it('keeps the original AH binding visible and detachable when its Host is unavailable', async () => {
    const { bridge, first, repository, target, agentHost } = creationFixture()
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'c'.repeat(64) }
    vi.mocked(agentHost.watch).mockRejectedValue(new Error('The original Agent Host is unavailable.'))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The original Agent Host is unavailable.')
    expect(screen.getByText(target.sessionId)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: `Unlink ${target.sessionId}` }))
    const confirmation = screen.getByRole('region', { name: 'Detach conversation' })
    await user.click(within(confirmation).getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(bridge.updateSessionLink).toHaveBeenCalledWith({
      workspaceId: first.id, taskId: 'T-0002', sessionId: null, detachTarget: target, expectedRevision: 'c'.repeat(64),
    }))
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('does not silently reassign a session that belongs to another task', async () => {
    const { bridge, first, repository, target, agentHost } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Another task' })
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0003': [{ provider: 'agent-host', ...target }] } }, revision: 'd'.repeat(64) }
    vi.mocked(agentHost.list).mockResolvedValue({ sessions: [{ ...target, title: 'Existing Host work', provider: 'copilotcli', updatedAt: '', canSend: true }], warnings: [] })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    await user.click(screen.getByRole('tab', { name: 'Link' }))
    const row = await screen.findByRole('button', { name: 'Link Existing Host work to T-0002' })
    expect(row).toBeDisabled()
    expect(screen.getByText('Linked to T-0003')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Actual UI task', level: 1 })).toBeInTheDocument()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(taskSessionLinks(repository[first.id].document.bindings, 'T-0003')).toEqual([{ provider: 'agent-host', ...target }])
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('keeps detach confirmation recoverable and cannot remove a binding changed by a notification', async () => {
    const { bridge, first, repository, target } = creationFixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: { 'T-0002': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await user.click(await screen.findByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: `Unlink ${target.sessionId}` }))
    const confirmation = screen.getByRole('region', { name: 'Detach conversation' })
    repository[first.id] = { document: { schemaVersion: '2.1', bindings: {} }, revision: 'b'.repeat(64) }
    await act(async () => remote.notify())
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('The task binding changed.')
    expect(within(confirmation).getByRole('button', { name: 'Detach session' })).toBeDisabled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    await user.click(within(confirmation).getByRole('button', { name: 'Keep conversation' }))
    expect(screen.queryByRole('region', { name: 'Detach conversation' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to tasks' }))
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled()
  })
})