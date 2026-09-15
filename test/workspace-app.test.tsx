import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import { demoTasks } from '../src/renderer/data/tasks'
import type { WorkspaceBridge, WorkspaceSnapshot, WorkspaceState } from '../src/shared/workspace'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import type { AgentHostBridge, AgentHostSession, AgentHostTarget, AgentHostView } from '../src/shared/agentHost'
import type { AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import { agentHostTargetFixture } from './immutable-bindings-fixture'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { delete window.workspace; delete window.agentHost; delete window.remoteVSCode; vi.unstubAllGlobals() })

function fixtures() {
  const first: WorkspaceSnapshot = { id: 'workspace-one', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [{ ...demoTasks[1], title: 'Actual UI task', status: 'done', documents: { requirements: '# Actual requirements\n\nSaved in the first workspace.', plan: '# Actual plan\n\nA persisted plan.', checklist: null } }], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }
  const second: WorkspaceSnapshot = { ...first, id: 'workspace-two', name: 'Other-ad', root: 'Q:\\src\\Projects\\Other-ad', tasks: [{ ...first.tasks[0], title: 'Different task with same ID', status: 'blocked' }] }
  let state: WorkspaceState = { current: null, recent: [first, second] }
  const repository: Record<string, SessionLinksSnapshot> = {}
  let revision = 0
  const bridge: WorkspaceBridge = {
    getState: vi.fn(async () => state),
    openFolder: vi.fn(async () => { state = { ...state, current: first }; return state }),
    openRecent: vi.fn(async (id) => { state = { ...state, current: id === first.id ? first : second }; return state }),
    refresh: vi.fn(async () => state),
    useDemo: vi.fn(async () => { state = { ...state, current: null }; return state }),
    getSessionLinks: vi.fn(async (id) => repository[id] ?? { document: { schemaVersion: 1, bindings: {} }, revision: null }),
    updateSessionLink: vi.fn(async (request) => {
      if (request.expectedRevision !== (repository[request.workspaceId]?.revision ?? null)) throw new Error('Workspace session links changed.')
      const bindings = { ...repository[request.workspaceId]?.document.bindings }
      if (request.sessionId === null) delete bindings[request.taskId]
      else {
        if (!request.agentHost || !request.owner) throw new Error('An owned Agent Host target is required.')
        bindings[request.taskId] = { provider: 'agent-host', ...request.agentHost, sessionId: request.sessionId, owner: request.owner }
      }
      return repository[request.workspaceId] = { document: { schemaVersion: 1, bindings }, revision: (++revision).toString(16).padStart(64, '0') }
    }),
  }
  window.workspace = bridge
  return { bridge, first, second, repository }
}

function creationFixture() {
  const workspace = fixtures()
  const owner = { clientId: crypto.randomUUID(), machineName: 'Creation-worker' }
  const target = { hostId: 'exact-host-123', sessionId: 'ahp-session:/new-chat', chatId: 'ahp-chat:/new-chat/main', owner }
  const session: AgentHostSession = { ...target, title: 'Created chat', provider: 'copilotcli', updatedAt: '', canSend: true }
  const worker: AgentHostWorker = { id: 'paired-worker', owner, state: 'connected', hosts: [{ hostId: target.hostId, name: 'Native Host', available: true }], workspaces: [{ id: 'worker-workspace', name: 'Worker project', canSend: true, taskState: 'available', expectedRevision: 'd'.repeat(64) }] }
  const saved = new Map<string, AgentHostCreation>()
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const watched = new Map<string, AgentHostView>()
  const agentHost: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })), creationWorkers: vi.fn(async () => [worker]),
    creations: vi.fn(async (taskId) => [...saved.values()].filter((operation) => operation.taskId === taskId)),
    create: vi.fn(async (request) => {
      const operation: AgentHostCreation = { ...request, state: 'ready', session }
      saved.set(request.operationId, operation)
      workspace.repository[workspace.first.id] = { document: { schemaVersion: 1, bindings: { ...workspace.repository[workspace.first.id]?.document.bindings, [request.taskId]: { provider: 'agent-host', ...target } } }, revision: 'e'.repeat(64) }
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
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...replacement } } }, revision: 'f'.repeat(64) }
    await act(async () => { finishReload(repository[first.id]) })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Keep selected task'))
    expect(agentHost.watch).not.toHaveBeenCalled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('reloads the already-saved creation binding only for its original task without a demo runtime', async () => {
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
    expect(await screen.findByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Actual UI task')
    await waitFor(() => expect(agentHost.watch).toHaveBeenCalledWith(target))
    expect(screen.queryByRole('dialog', { name: 'Agent Host sessions' })).not.toBeInTheDocument()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), taskId: 'T-0002', workerId: 'paired-worker', workspaceId: 'worker-workspace', hostId: target.hostId, expectedRevision: 'd'.repeat(64) })
    expect(agentHost.send).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Other task draft' }))
    expect(screen.queryByRole('textbox', { name: /Message/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
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
    const dialog = screen.getByRole('dialog', { name: 'Agent Host sessions' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Saved links could not be read.')
    expect(within(dialog).getByText('ahp-session:/new-chat')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Open created chat' }))
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
    const secondSnapshot: SessionLinksSnapshot = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...secondTarget } } }, revision: 'b'.repeat(64) }
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

  it('does not close a newly opened picker when completion from a closed picker arrives', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Close Agent Host sessions' }))
    await user.click(screen.getByRole('button', { name: 'T-0003 New picker task' }))
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    await act(async () => { finishReload(repository[first.id]) })
    expect(screen.getByRole('dialog', { name: 'Agent Host sessions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New picker task')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0003' })).toBeInTheDocument()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledTimes(1)
  })

  it('passes a bound task to the picker as ineligible for creation', async () => {
    const { first, repository, agentHost, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'b'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await selectCreationTarget(user)
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(screen.getByText(/Creation requires an unbound task/)).toBeInTheDocument()
    expect(agentHost.create).not.toHaveBeenCalled()
  })

  it('opens the exact AHP Git link without creating, sending or cancelling a session', async () => {
    const { first, repository, agentHost, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64), localOwner: target.owner }
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

  it('opens real tasks and documents, then switches back to the demo', async () => {
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), 'demo')
    expect(await screen.findByRole('heading', { level: 1, name: 'UI based on Electron' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create demo task' })).toBeEnabled()
  })

  it('keeps the current workspace and draft if folder selection is cancelled or fails', async () => {
    const { bridge, first, repository, target } = creationFixture()
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64) }
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
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...firstTarget } } }, revision: 'a'.repeat(64) }
    repository[second.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...secondTarget } } }, revision: 'b'.repeat(64) }
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
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64) }
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
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64) }
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
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'c'.repeat(64) }
    vi.mocked(agentHost.watch).mockRejectedValue(new Error('The original Agent Host is unavailable.'))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The original Agent Host is unavailable.')
    expect(screen.getByText(target.sessionId)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(bridge.updateSessionLink).toHaveBeenCalledWith({ workspaceId: first.id, taskId: 'T-0002', sessionId: null, expectedRevision: 'c'.repeat(64) }))
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('routes a linked session back to its owning task without rewriting the repository', async () => {
    const { bridge, first, repository, target, agentHost } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Another task' })
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0003': { provider: 'agent-host', ...target } } }, revision: 'd'.repeat(64) }
    vi.mocked(agentHost.list).mockResolvedValue({ sessions: [{ ...target, title: 'Existing Host work', provider: 'copilotcli', updatedAt: '', canSend: true }], warnings: [] })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    const row = await screen.findByRole('button', { name: 'Link Existing Host work to T-0002' })
    await waitFor(() => expect(row).toBeEnabled())
    await user.click(row)
    expect(await screen.findByRole('heading', { name: 'Another task', level: 1 })).toBeInTheDocument()
    await screen.findByText('Original Host chat')
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(repository[first.id].document.bindings['T-0003'].sessionId).toBe(target.sessionId)
    expect(agentHost.create).not.toHaveBeenCalled()
    expect(agentHost.send).not.toHaveBeenCalled()
  })

  it('keeps detach confirmation recoverable and cannot remove a binding changed by a notification', async () => {
    const { bridge, first, repository, target } = creationFixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await user.click(await screen.findByRole('button', { name: 'Detach conversation' }))
    const dialog = screen.getByRole('dialog', { name: 'Detach conversation' })
    repository[first.id] = { document: { schemaVersion: 1, bindings: {} }, revision: 'b'.repeat(64) }
    await act(async () => remote.notify())
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The task binding changed.')
    expect(within(dialog).getByRole('button', { name: 'Detach session' })).toBeDisabled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Keep conversation' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled()
  })
})