import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostBridge, AgentHostSession } from '../src/shared/agentHost'
import type { AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import { agentHostCreationErrorMessages } from '../src/shared/agentHostCreation'
import { AgentHostCreationControls } from '../src/renderer/components/AgentHostCreationControls'
import { AgentHostSessionsSidebar } from '../src/renderer/components/AgentHostSessionsSidebar'

afterEach(() => { delete window.agentHost; vi.useRealTimers() })

function fixture() {
  const owner = { clientId: 'authenticated-owner', machineName: 'Paired workstation' }
  const worker: AgentHostWorker = {
    id: 'caller-local-worker', owner, state: 'connected',
    hosts: [{ hostId: 'exact-host-123', name: 'Native Host', available: true }],
    workspaces: [{ id: 'remote-workspace', name: 'Worker project', canSend: true, taskState: 'available', expectedRevision: 'a'.repeat(64) }],
  }
  const session: AgentHostSession = { sessionId: 'ahp-session:/created', chatId: 'ahp-chat:/created/main', owner, title: 'New native chat', provider: 'copilotcli', canSend: true, updatedAt: '' }
  const saved = new Map<string, AgentHostCreation>()
  const bridge: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []),
    createLocal: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    localCreationStatus: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    creationWorkers: vi.fn(async () => [worker]),
    creations: vi.fn(async (taskId) => [...saved.values()].filter((operation) => operation.taskId === taskId)),
    create: vi.fn(async (request) => {
      const operation: AgentHostCreation = { ...request, state: 'ready', session }
      saved.set(operation.operationId, operation)
      return operation
    }),
    creationStatus: vi.fn(async (id) => {
      const operation = saved.get(id)
      if (!operation) throw new Error('The saved operation cannot be reached.')
      return operation
    }),
    bindCreation: vi.fn(async (id) => {
      const operation = saved.get(id)
      if (!operation) throw new Error('No saved chat to bind.')
      const ready: AgentHostCreation = { ...operation, state: 'ready', session, error: undefined }
      saved.set(id, ready)
      return ready
    }),
    models: vi.fn(async () => []), watch: vi.fn(async () => 'watch'),
    unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onView: () => () => {},
  }
  window.agentHost = bridge
  function operation(state: AgentHostCreation['state']): AgentHostCreation {
    const value: AgentHostCreation = { operationId: crypto.randomUUID(), taskId: 'T-0002', workerId: worker.id, workspaceId: worker.workspaces[0].id, hostId: worker.hosts[0].hostId, state, ...(state === 'ready' || state === 'created-unbound' ? { session } : {}) }
    saved.set(value.operationId, value)
    return value
  }
  return { bridge, worker, session, saved, operation }
}

async function choose(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('option', { name: /Paired workstation/ })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Remote worker' })).toBeEnabled())
  await user.selectOptions(screen.getByRole('combobox', { name: 'Remote worker' }), 'caller-local-worker')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Shared worker workspace' }), 'remote-workspace')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'exact-host-123')
}

function localFixture() {
  const result = fixture()
  const owner = { clientId: 'd740398c-967a-4ae3-8910-a5e7b55e6763', machineName: 'This workstation' }
  const localWorker: AgentHostWorker = {
    id: owner.clientId, owner, local: true, state: 'connected',
    hosts: [{ hostId: 'local-native-host', name: 'Local native Host', available: true }],
    workspaces: [{ id: 'canonical-current-workspace', name: 'Current task project', canSend: true, taskState: 'available', expectedRevision: 'b'.repeat(64) }],
  }
  vi.mocked(result.bridge.creationWorkers).mockImplementation(async (_taskId, location) => location === 'local' ? [localWorker] : [result.worker])
  result.session.owner = owner
  return { ...result, localWorker }
}

async function selectLocation(user: ReturnType<typeof userEvent.setup>, location: 'local' | 'remote') {
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Execution location' })).toBeEnabled())
  await user.selectOptions(screen.getByRole('combobox', { name: 'Execution location' }), location)
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Execution location' })).toBeEnabled())
}

describe('explicit task-local Agent Host creation', () => {
  it('creates locally while unrelated existing-session discovery is still pending', async () => {
    const { bridge, session, localWorker } = localFixture()
    let finishList!: (result: Awaited<ReturnType<AgentHostBridge['list']>>) => void
    vi.mocked(bridge.list).mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve }))
    const onCreated = vi.fn(async () => {})
    const onLink = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar initialView="create" taskId="T-0002" taskReady onLink={onLink} onCreated={onCreated} onDevices={vi.fn()} onClose={vi.fn()} />)
    await selectLocation(user, 'local')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    expect(screen.getByRole('button', { name: 'Refresh Agent Host sessions' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session))
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({
      operationId: expect.any(String), taskId: 'T-0002', workerId: localWorker.id,
      workspaceId: 'canonical-current-workspace', hostId: 'local-native-host', expectedRevision: 'b'.repeat(64),
    })
    expect(bridge.list).toHaveBeenCalledOnce()
    expect(onLink).not.toHaveBeenCalled()
    expect(bridge.createLocal).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
    await act(async () => { finishList({ sessions: [], warnings: [] }) })
  })

  it('creates and assigns using only the trusted current workspace and the exact chosen Host', async () => {
    const { bridge, localWorker, session } = localFixture()
    localWorker.hosts.push({ hostId: 'second-local-host', name: 'Second local Host', available: true })
    const onCreated = vi.fn(async () => {})
    const onLink = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar initialView="create" taskId="T-0002" taskReady onLink={onLink} onCreated={onCreated} onDevices={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Execution location' })).toHaveValue('remote')
    await selectLocation(user, 'local')
    expect(bridge.creationWorkers).toHaveBeenCalledWith('T-0002')
    expect(bridge.creationWorkers).toHaveBeenLastCalledWith('T-0002', 'local')
    expect(screen.getByRole('heading', { name: 'Create on this computer' })).toBeInTheDocument()
    expect(screen.getByText('This workstation')).toBeInTheDocument()
    expect(screen.getByText('Current task project')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Remote worker' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Shared worker workspace' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'second-local-host')
    expect(bridge.create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session))
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), taskId: 'T-0002', workerId: localWorker.id,
      workspaceId: 'canonical-current-workspace', hostId: 'second-local-host', expectedRevision: 'b'.repeat(64),
    })
    expect(bridge.send).not.toHaveBeenCalled()
    expect(bridge.createLocal).not.toHaveBeenCalled()
    expect(bridge.localCreations).not.toHaveBeenCalled()
    expect(bridge.localCreationHosts).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
    expect(onLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Create' }))
    await selectLocation(user, 'remote')
    await choose(user)
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
  })

  it.each(['blocked', 'offline', 'no Host', 'no consent', 'no binding backend', 'unavailable Host'] as const)('surfaces %s and disables local creation', async (reason) => {
    const { bridge, localWorker } = localFixture()
    const message = `Local creation diagnostic: ${reason}.`
    if (reason === 'blocked' || reason === 'offline') { localWorker.state = reason; localWorker.error = message }
    if (reason === 'no Host') { localWorker.hosts = []; localWorker.error = message }
    if (reason === 'no consent') { localWorker.workspaces[0].canSend = false; localWorker.workspaces[0].error = message }
    if (reason === 'no binding backend') { localWorker.workspaces[0].taskState = 'unavailable'; localWorker.workspaces[0].error = message }
    if (reason === 'unavailable Host') { localWorker.hosts[0].available = false; localWorker.hosts[0].error = message }
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await selectLocation(user, 'local')
    if (localWorker.hosts.length) await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.createLocal).not.toHaveBeenCalled()
  })

  it.each(['empty', 'older preload', 'multiple local workers', 'no workspace', 'multiple workspaces'] as const)('fails closed for a %s catalogue', async (reason) => {
    const { bridge, localWorker, worker } = localFixture()
    if (reason === 'empty') vi.mocked(bridge.creationWorkers).mockResolvedValue([])
    if (reason === 'older preload') vi.mocked(bridge.creationWorkers).mockResolvedValue([worker])
    if (reason === 'multiple local workers') vi.mocked(bridge.creationWorkers).mockResolvedValue([localWorker, { ...localWorker, id: 'another-local-worker' }])
    if (reason === 'no workspace') localWorker.workspaces = []
    if (reason === 'multiple workspaces') localWorker.workspaces.push({ ...localWorker.workspaces[0], id: 'other-workspace' })
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await selectLocation(user, 'local')
    expect(screen.getByRole('status')).toHaveTextContent(reason === 'no workspace' || reason === 'multiple workspaces' ? 'exactly one verified current workspace' : 'did not provide a trusted local worker')
    expect(screen.queryByRole('option', { name: /Paired workstation/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('surfaces local discovery and shared history failures without falling back to remote creation', async () => {
    const { bridge } = localFixture()
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Execution location' })).toBeEnabled())
    vi.mocked(bridge.creationWorkers).mockRejectedValue(new Error('Local Host consent is required.'))
    vi.mocked(bridge.creations).mockRejectedValue(new Error('Shared creation history is unreadable.'))
    await selectLocation(user, 'local')
    expect(screen.getByText(/Workers could not be loaded/)).toHaveTextContent('Local Host consent is required.')
    expect(screen.getByText(/Creation is disabled to avoid duplicates/)).toHaveTextContent('Shared creation history is unreadable.')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.createLocal).not.toHaveBeenCalled()
  })

  it.each(['local', 'remote'] as const)('keeps an unresolved %s operation across mode changes even when history omits it', async (initialLocation) => {
    const { bridge } = localFixture()
    vi.mocked(bridge.create).mockRejectedValue(new Error('Acknowledgement lost.'))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    if (initialLocation === 'local') {
      await selectLocation(user, 'local')
      await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    } else await choose(user)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    await selectLocation(user, initialLocation === 'local' ? 'remote' : 'local')
    if (initialLocation === 'local') await choose(user)
    else await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    expect(screen.getByRole('region', { name: `Creation ${request.operationId}` })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Outcome uncertain · T-0002' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.creationStatus).toHaveBeenCalledExactlyOnceWith(request.operationId)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it('prevents mode changes while a catalogue is in flight and clears the old selection on a later switch', async () => {
    const { bridge, worker } = localFixture()
    let complete!: (workers: AgentHostWorker[]) => void
    vi.mocked(bridge.creationWorkers).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await waitFor(() => expect(bridge.creationWorkers).toHaveBeenCalledWith('T-0002'))
    const picker = screen.getByRole('combobox', { name: 'Execution location' })
    expect(picker).toBeDisabled()
    fireEvent.change(picker, { target: { value: 'local' } })
    expect(picker).toHaveValue('remote')
    await act(async () => { complete([worker]) })
    await choose(user)
    await selectLocation(user, 'local')
    expect(screen.getByRole('combobox', { name: 'Exact Agent Host' })).toHaveValue('')
    expect(screen.queryByRole('option', { name: /Native Host — available/ })).not.toBeInTheDocument()
    expect(screen.getByText('Current task project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('recovers a durable local operation after remount even with remote selected by default', async () => {
    const { bridge, saved, session } = localFixture()
    vi.mocked(bridge.create).mockImplementationOnce(async (request) => {
      const operation: AgentHostCreation = { ...request, state: 'uncertain' }
      saved.set(request.operationId, operation)
      return operation
    })
    const user = userEvent.setup()
    const first = render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await selectLocation(user, 'local')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    first.unmount()
    const onCreated = vi.fn(async () => {})
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await waitFor(() => expect(bridge.creationStatus).toHaveBeenCalledExactlyOnceWith(request.operationId))
    await choose(user)
    expect(screen.getByRole('combobox', { name: 'Execution location' })).toHaveValue('remote')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    saved.set(request.operationId, { ...request, state: 'ready', session })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.bindCreation).not.toHaveBeenCalled()
    expect(bridge.createLocal).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('prevents switching and duplicate creation until a local operation completes, then retries only binding', async () => {
    const { bridge, saved, session } = localFixture()
    let complete!: (operation: AgentHostCreation) => void
    vi.mocked(bridge.create).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const onCreated = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await selectLocation(user, 'local')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'local-native-host')
    const button = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    const picker = screen.getByRole('combobox', { name: 'Execution location' })
    expect(picker).toBeDisabled()
    fireEvent.change(picker, { target: { value: 'remote' } })
    expect(picker).toHaveValue('local')
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    await act(async () => {
      const operation: AgentHostCreation = { ...request, state: 'created-unbound', session }
      saved.set(request.operationId, operation)
      complete(operation)
    })
    await selectLocation(user, 'remote')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry binding' }))
    expect(bridge.bindCreation).toHaveBeenCalledExactlyOnceWith(request.operationId)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.send).not.toHaveBeenCalled()
  })
})

describe('explicit remote Agent Host creation', () => {
  it('distinguishes acknowledged lazy native initialization from a saved task assignment', async () => {
    const { bridge, operation } = fixture()
    operation('ready').nativeLifecycle = 'creating'
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    expect(await screen.findByText('The Host acknowledged this chat. Its native agent initializes on the first explicit send; no warm-up prompt was sent.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Created and assigned · T-0002' })).toBeInTheDocument()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('uses send access on a paired worker with zero sessions without another permission dialog or prompt', async () => {
    const { bridge, worker, session } = fixture()
    const onCreated = vi.fn(async () => {})
    const onLink = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar initialView="create" taskId="T-0002" taskReady onLink={onLink} onCreated={onCreated} onDevices={vi.fn()} onClose={vi.fn()} />)
    await choose(user)
    expect(screen.getByText(/Creates in the selected workspace folder/)).toHaveTextContent('Creates in the selected workspace folder (no worktree). Native tool approvals remain on the worker. No prompt is sent.')
    expect(bridge.creationWorkers).toHaveBeenCalledWith('T-0002')
    expect(bridge.creations).toHaveBeenCalledWith('T-0002')
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: 'Agent Host sessions' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session))
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), taskId: 'T-0002', workerId: worker.id,
      workspaceId: worker.workspaces[0].id, hostId: worker.hosts[0].hostId, expectedRevision: 'a'.repeat(64),
    })
    expect(bridge.send).not.toHaveBeenCalled()
    expect(bridge.models).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
    expect(onLink).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'offline', 'blocked', 'missing task', 'unverified task', 'unsupported', 'unavailable Host'] as const)('denies creation for %s', async (reason) => {
    const { bridge, worker } = fixture()
    if (reason === 'read-only') worker.workspaces[0].canSend = false
    if (reason === 'offline') worker.state = 'offline'
    if (reason === 'blocked') worker.state = 'blocked'
    if (reason === 'missing task') worker.workspaces[0].taskState = 'missing'
    if (reason === 'unverified task') worker.workspaces[0].taskState = 'unavailable'
    if (reason === 'unsupported') worker.state = 'unsupported'
    if (reason === 'unavailable Host') worker.hosts[0].available = false
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    const button = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(button).toBeDisabled()
    await user.click(button)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
  })

  it('permits a bound task and a second creation after the first completes', async () => {
    const { bridge, worker, session } = fixture()
    worker.workspaces[0].taskState = 'bound'
    const firstRevision = worker.workspaces[0].expectedRevision
    vi.mocked(bridge.create).mockImplementation(async (request) => {
      const created: AgentHostCreation = {
        ...request,
        state: 'ready',
        session: { ...session, sessionId: `ahp-session:/${request.operationId}`, chatId: `ahp-chat:/${request.operationId}/main` },
      }
      worker.workspaces[0].expectedRevision = 'c'.repeat(64)
      return created
    })
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    const button = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(button).toBeEnabled()
    await user.click(button)
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    await waitFor(() => expect(bridge.create).toHaveBeenCalledTimes(2))
    const [first, second] = vi.mocked(bridge.create).mock.calls.map(([request]) => request)
    expect(first.expectedRevision).toBe(firstRevision)
    expect(second.expectedRevision).toBe('c'.repeat(64))
    expect(first.operationId).not.toBe(second.operationId)
    expect(screen.getAllByRole('heading', { name: 'Created and assigned · T-0002' })).toHaveLength(2)
  })

  it('shows the worker history error and keeps an existing uncertain operation without replaying it', async () => {
    const { bridge, worker, operation } = fixture()
    const error = agentHostCreationErrorMessages['creation-records-unavailable']
    const pending = operation('uncertain')
    pending.error = error
    worker.state = 'blocked'
    worker.error = error
    worker.hosts = []
    worker.workspaces = []
    vi.mocked(bridge.creationStatus).mockRejectedValue(new Error(error))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await screen.findByRole('option', { name: /Paired workstation/ })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Remote worker' })).toBeEnabled())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Remote worker' }), worker.id)
    expect(screen.getByText('This worker is connected, but its creation records must be repaired before creating.')).toBeInTheDocument()
    expect(screen.getAllByText(error)).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Outcome uncertain · T-0002' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(screen.queryByText('This worker exposes no Agent Hosts.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(bridge.creationStatus).toHaveBeenLastCalledWith(pending.operationId)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('shows unavailable APIs in an older preload while existing linking still works', async () => {
    const { session } = fixture()
    const list = vi.fn(async () => ({ sessions: [session], warnings: [] }))
    window.agentHost = { list } as unknown as AgentHostBridge
    const onLink = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostSessionsSidebar initialView="link" taskId="T-0002" taskReady onLink={onLink} onDevices={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Link New native chat to T-0002' }))
    expect(onLink).toHaveBeenCalledExactlyOnceWith(session)
    await user.click(screen.getByRole('tab', { name: 'Create' }))
    expect(screen.getByText(/Remote creation is unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
  })

  it('does not discover or create without a selected task', async () => {
    const { bridge } = fixture()
    render(<AgentHostCreationControls taskReady />)
    expect(screen.getByRole('button', { name: 'Create and assign' })).toBeDisabled()
    expect(bridge.creationWorkers).not.toHaveBeenCalled()
    expect(bridge.creations).not.toHaveBeenCalled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('requires the exact selected Host and passes a null remote revision unchanged', async () => {
    const { bridge, worker } = fixture()
    worker.hosts.push({ hostId: 'second-host', name: 'Second native Host', available: true })
    worker.workspaces[0].expectedRevision = null
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), '')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Exact Agent Host' }), 'second-host')
    expect(bridge.create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    expect(bridge.create).toHaveBeenCalledWith({ operationId: expect.any(String), taskId: 'T-0002', workerId: worker.id, workspaceId: 'remote-workspace', hostId: 'second-host', expectedRevision: null })
  })

  it('fails closed when saved operations cannot be read and displays discovery errors', async () => {
    const { bridge, worker } = fixture()
    worker.error = 'Worker capabilities are limited.'
    worker.workspaces[0].error = 'Task revision warning.'
    worker.hosts[0].error = 'Native Host warning.'
    vi.mocked(bridge.creations).mockRejectedValue(new Error('Saved operation store unavailable.'))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    expect(screen.getByText(/Creation is disabled to avoid duplicates/)).toHaveTextContent('Saved operation store unavailable.')
    expect(screen.getByText('Worker capabilities are limited.')).toBeInTheDocument()
    expect(screen.getByText('Task revision warning.')).toBeInTheDocument()
    expect(screen.getByText('Native Host warning.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('shows a worker discovery failure without creating or sending', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.creationWorkers).mockRejectedValue(new Error('Device disconnected.'))
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Device disconnected.')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('keeps an IPC rejection uncertain and checks the same operation instead of resubmitting', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.create).mockRejectedValue(new Error('Connection ended before acknowledgement.'))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    expect(await screen.findByText('Connection ended before acknowledgement.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Outcome uncertain · T-0002' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(bridge.creationStatus).toHaveBeenCalledExactlyOnceWith(vi.mocked(bridge.create).mock.calls[0][0].operationId)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it('recovers an uncertain durable operation after remount without another create', async () => {
    const { bridge, operation, saved, session } = fixture()
    const uncertain = operation('uncertain')
    const user = userEvent.setup()
    const first = render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await waitFor(() => expect(bridge.creationStatus).toHaveBeenCalledExactlyOnceWith(uncertain.operationId))
    first.unmount()
    const onCreated = vi.fn(async () => {})
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await waitFor(() => expect(bridge.creationStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled())
    const row = screen.getByRole('region', { name: `Creation ${uncertain.operationId}` })
    expect(within(row).getByText('caller-local-worker')).toBeInTheDocument()
    expect(within(row).getByText(/Paired workstation/)).toBeInTheDocument()
    saved.set(uncertain.operationId, { ...uncertain, state: 'ready', session })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session))
    expect(vi.mocked(bridge.creationStatus).mock.calls.every(([id]) => id === uncertain.operationId)).toBe(true)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it('polls and checks on reconnect without creating or retrying binding', async () => {
    vi.useFakeTimers()
    const { bridge, operation } = fixture()
    const uncertain = operation('uncertain')
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    expect(bridge.creationStatus).toHaveBeenCalledExactlyOnceWith(uncertain.operationId)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(bridge.creationStatus).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(bridge.creationStatus).toHaveBeenCalledTimes(3)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it.each([
    ['remote', 'Execution location'],
    ['remote', 'Remote worker'],
    ['remote', 'Shared worker workspace'],
    ['remote', 'Exact Agent Host'],
    ['local', 'Exact Agent Host'],
  ] as const)('keeps the %s %s picker interactive throughout background refreshes', async (location, label) => {
    vi.useFakeTimers()
    const { bridge, worker, localWorker } = localFixture()
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    if (location === 'local') {
      await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Execution location' }), { target: { value: 'local' } }) })
    } else {
      fireEvent.change(screen.getByRole('combobox', { name: 'Remote worker' }), { target: { value: worker.id } })
      fireEvent.change(screen.getByRole('combobox', { name: 'Shared worker workspace' }), { target: { value: worker.workspaces[0].id } })
    }
    const selectedWorker = location === 'local' ? localWorker : worker
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: selectedWorker.hosts[0].hostId } })
    const picker = screen.getByRole('combobox', { name: label })
    const options = within(picker).getAllByRole('option')
    act(() => { picker.focus() })
    vi.mocked(bridge.creationWorkers).mockClear()

    for (const trigger of ['timer', 'online'] as const) {
      let finish!: (workers: AgentHostWorker[]) => void
      vi.mocked(bridge.creationWorkers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      await act(async () => {
        if (trigger === 'timer') await vi.advanceTimersByTimeAsync(5000)
        else window.dispatchEvent(new Event('online'))
      })
      expect(picker).toBeEnabled()
      expect(picker).toHaveFocus()
      expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Refresh workers and creation status' })).toBeEnabled()
      expect(screen.getByRole('region', { name: location === 'local' ? 'Create on this computer' : 'Create on remote worker' })).toHaveAttribute('aria-busy', 'false')
      await act(async () => { finish([structuredClone(selectedWorker)]) })
      expect(screen.getByRole('combobox', { name: label })).toBe(picker)
      expect(picker).toBeEnabled()
      expect(picker).toHaveFocus()
      within(picker).getAllByRole('option').forEach((option, index) => expect(option).toBe(options[index]))
      expect(screen.getByRole('combobox', { name: 'Execution location' })).toHaveValue(location)
      expect(screen.getByRole('combobox', { name: 'Exact Agent Host' })).toHaveValue(selectedWorker.hosts[0].hostId)
      if (location === 'remote') {
        expect(screen.getByRole('combobox', { name: 'Remote worker' })).toHaveValue(worker.id)
        expect(screen.getByRole('combobox', { name: 'Shared worker workspace' })).toHaveValue(worker.workspaces[0].id)
      }
      expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    }
    expect(bridge.creationWorkers).toHaveBeenCalledTimes(2)
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it('retains choices and keeps creation available during a slow poll without overlapping polls', async () => {
    vi.useFakeTimers()
    const { bridge, worker } = fixture()
    worker.hosts.push({ hostId: 'second-host', name: 'Second native Host', available: true })
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    let finish!: (workers: AgentHostWorker[]) => void
    vi.mocked(bridge.creationWorkers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    for (const picker of screen.getAllByRole('combobox')) {
      if (picker.getAttribute('aria-label') === 'Execution location' || picker.getAttribute('aria-label') === 'Remote worker') expect(picker).toBeEnabled()
    }
    fireEvent.change(screen.getByRole('combobox', { name: 'Remote worker' }), { target: { value: worker.id } })
    expect(screen.getByRole('combobox', { name: 'Shared worker workspace' })).toBeEnabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared worker workspace' }), { target: { value: worker.workspaces[0].id } })
    expect(screen.getByRole('combobox', { name: 'Exact Agent Host' })).toBeEnabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: 'second-host' } })
    const create = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(create).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
      window.dispatchEvent(new Event('online'))
    })
    expect(bridge.creationWorkers).toHaveBeenCalledTimes(2)
    expect(bridge.create).not.toHaveBeenCalled()
    await act(async () => { finish([structuredClone(worker)]) })
    expect(screen.getByRole('combobox', { name: 'Remote worker' })).toHaveValue(worker.id)
    expect(screen.getByRole('combobox', { name: 'Shared worker workspace' })).toHaveValue(worker.workspaces[0].id)
    expect(screen.getByRole('combobox', { name: 'Exact Agent Host' })).toHaveValue('second-host')
    expect(create).toBeEnabled()
    await act(async () => { fireEvent.click(create) })
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({
      operationId: expect.any(String), taskId: 'T-0002', workerId: worker.id,
      workspaceId: worker.workspaces[0].id, hostId: 'second-host', expectedRevision: worker.workspaces[0].expectedRevision,
    })
  })

  it.each([
    ['remote', 'before'],
    ['remote', 'after'],
    ['local', 'before'],
    ['local', 'after'],
  ] as const)('creates immediately during a %s poll that finishes %s creation', async (location, pollCompletion) => {
    vi.useFakeTimers()
    const { bridge, worker, localWorker, saved, session } = localFixture()
    const onCreated = vi.fn(async () => {})
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />) })
    if (location === 'local') {
      await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Execution location' }), { target: { value: 'local' } }) })
    } else {
      fireEvent.change(screen.getByRole('combobox', { name: 'Remote worker' }), { target: { value: worker.id } })
      fireEvent.change(screen.getByRole('combobox', { name: 'Shared worker workspace' }), { target: { value: worker.workspaces[0].id } })
    }
    const selectedWorker = location === 'local' ? localWorker : worker
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: selectedWorker.hosts[0].hostId } })
    let finishWorkers!: (workers: AgentHostWorker[]) => void
    let finishHistory!: (operations: AgentHostCreation[]) => void
    let finishCreation!: (operation: AgentHostCreation) => void
    vi.mocked(bridge.creationWorkers).mockImplementationOnce(() => new Promise((resolve) => { finishWorkers = resolve }))
    vi.mocked(bridge.creations).mockImplementationOnce(() => new Promise((resolve) => { finishHistory = resolve }))
    vi.mocked(bridge.create).mockImplementationOnce(() => new Promise((resolve) => { finishCreation = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const catalogueReads = vi.mocked(bridge.creationWorkers).mock.calls.length
    const create = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(create).toBeEnabled()
    act(() => { fireEvent.click(create); fireEvent.click(create) })
    expect(bridge.create).toHaveBeenCalledExactlyOnceWith({
      operationId: expect.any(String), taskId: 'T-0002', workerId: selectedWorker.id,
      workspaceId: selectedWorker.workspaces[0].id, hostId: selectedWorker.hosts[0].hostId,
      expectedRevision: selectedWorker.workspaces[0].expectedRevision,
    })
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    expect(create).toBeDisabled()
    for (const picker of screen.getAllByRole('combobox')) expect(picker).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
      window.dispatchEvent(new Event('online'))
    })
    expect(bridge.creationWorkers).toHaveBeenCalledTimes(catalogueReads)
    async function finishPoll() {
      await act(async () => {
        finishWorkers([{ ...selectedWorker, state: 'offline', error: 'Outdated worker status.' }])
        finishHistory([{ ...request, state: 'uncertain', error: 'Outdated creation status.' }])
      })
    }
    if (pollCompletion === 'before') {
      await finishPoll()
      expect(screen.getByRole('heading', { name: 'Creating · T-0002' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh workers and creation status' })).toBeDisabled()
      for (const picker of screen.getAllByRole('combobox')) expect(picker).toBeDisabled()
      expect(onCreated).not.toHaveBeenCalled()
    }
    await act(async () => {
      const ready: AgentHostCreation = { ...request, state: 'ready', session }
      saved.set(request.operationId, ready)
      finishCreation(ready)
    })
    if (pollCompletion === 'after') await finishPoll()
    expect(screen.getByRole('heading', { name: 'Created and assigned · T-0002' })).toBeInTheDocument()
    expect(create).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.creationStatus).not.toHaveBeenCalled()
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it.each(['Check status', 'Retry binding'] as const)('prioritizes %s over a pending background status check', async (action) => {
    vi.useFakeTimers()
    const { bridge, operation, saved, session } = fixture()
    const unbound = operation('created-unbound')
    const onCreated = vi.fn(async () => {})
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />) })
    let finishStatus!: (operation: AgentHostCreation) => void
    vi.mocked(bridge.creationStatus).mockImplementationOnce(() => new Promise((resolve) => { finishStatus = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const button = screen.getByRole('button', { name: action })
    expect(button).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeDisabled()
    if (action === 'Check status') saved.set(unbound.operationId, { ...unbound, state: 'ready', session })
    await act(async () => { fireEvent.click(button) })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session)
    await act(async () => { finishStatus({ ...unbound, state: 'uncertain', error: 'Superseded status response.' }) })
    expect(screen.getByRole('heading', { name: 'Created and assigned · T-0002' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(bridge.creationStatus).toHaveBeenCalledTimes(action === 'Check status' ? 3 : 2)
    expect(bridge.bindCreation).toHaveBeenCalledTimes(action === 'Retry binding' ? 1 : 0)
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('lets an explicit refresh supersede a slow poll without surfacing its late failures', async () => {
    vi.useFakeTimers()
    const { bridge, worker } = fixture()
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    let failWorkers!: (error: Error) => void
    let failHistory!: (error: Error) => void
    let finishRefresh!: (workers: AgentHostWorker[]) => void
    vi.mocked(bridge.creationWorkers)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failWorkers = reject }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve }))
    vi.mocked(bridge.creations).mockImplementationOnce(() => new Promise((_resolve, reject) => { failHistory = reject }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const refresh = screen.getByRole('button', { name: 'Refresh workers and creation status' })
    expect(refresh).toBeEnabled()
    act(() => { fireEvent.click(refresh); fireEvent.click(refresh) })
    expect(bridge.creationWorkers).toHaveBeenCalledTimes(3)
    expect(refresh).toBeDisabled()
    await act(async () => {
      failWorkers(new Error('Superseded worker request failed.'))
      failHistory(new Error('Superseded history request failed.'))
    })
    expect(refresh).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Remote worker' })).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => { finishRefresh([worker]) })
    expect(refresh).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Remote worker' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['workers', 'history'] as const)('still prevents creation after a background %s failure', async (source) => {
    vi.useFakeTimers()
    const { bridge, worker } = fixture()
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    fireEvent.change(screen.getByRole('combobox', { name: 'Remote worker' }), { target: { value: worker.id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared worker workspace' }), { target: { value: worker.workspaces[0].id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: worker.hosts[0].hostId } })
    const create = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(create).toBeEnabled()
    if (source === 'workers') vi.mocked(bridge.creationWorkers).mockRejectedValueOnce(new Error('Latest workers unavailable.'))
    else vi.mocked(bridge.creations).mockRejectedValueOnce(new Error('Latest history unavailable.'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(create).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(`Latest ${source} unavailable.`)
    expect(screen.getByRole('button', { name: 'Refresh workers and creation status' })).toBeEnabled()
    for (const picker of screen.getAllByRole('combobox')) expect(picker).toBeEnabled()
    fireEvent.click(create)
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('discards an old background catalogue when the execution location changes', async () => {
    vi.useFakeTimers()
    const { bridge, worker, localWorker } = localFixture()
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    let finish!: (workers: AgentHostWorker[]) => void
    vi.mocked(bridge.creationWorkers).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const picker = screen.getByRole('combobox', { name: 'Execution location' })
    expect(picker).toBeEnabled()
    await act(async () => { fireEvent.change(picker, { target: { value: 'local' } }) })
    expect(bridge.creationWorkers).toHaveBeenLastCalledWith('T-0002', 'local')
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: localWorker.hosts[0].hostId } })
    await act(async () => { finish([worker]) })
    expect(picker).toHaveValue('local')
    expect(screen.getByText('Current task project')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Native Host/ })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Exact Agent Host' })).toHaveValue(localWorker.hosts[0].hostId)
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it.each(['offline', 'read-only', 'unavailable Host'] as const)('still disables creation when a background refresh reports %s', async (reason) => {
    vi.useFakeTimers()
    const { bridge, worker } = fixture()
    await act(async () => { render(<AgentHostCreationControls taskId="T-0002" taskReady />) })
    fireEvent.change(screen.getByRole('combobox', { name: 'Remote worker' }), { target: { value: worker.id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared worker workspace' }), { target: { value: worker.workspaces[0].id } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Exact Agent Host' }), { target: { value: worker.hosts[0].hostId } })
    const create = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    expect(create).toBeEnabled()
    const updatedWorker = structuredClone(worker)
    if (reason === 'offline') updatedWorker.state = 'offline'
    if (reason === 'read-only') updatedWorker.workspaces[0].canSend = false
    if (reason === 'unavailable Host') updatedWorker.hosts[0].available = false
    vi.mocked(bridge.creationWorkers).mockResolvedValue([updatedWorker])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(create).toBeDisabled()
    for (const picker of screen.getAllByRole('combobox')) expect(picker).toBeEnabled()
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
    expect(bridge.create).not.toHaveBeenCalled()
  })

  it('retries only binding for a created-unbound session and retains binding failures', async () => {
    const { bridge, operation } = fixture()
    const unbound = operation('created-unbound')
    vi.mocked(bridge.bindCreation).mockRejectedValueOnce(new Error('Repository revision changed.'))
    const onCreated = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry binding' })).toBeEnabled())
    expect(bridge.bindCreation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Retry binding' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Repository revision changed.')
    expect(screen.getByText('ahp-session:/created')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry binding' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', unbound.session))
    expect(vi.mocked(bridge.bindCreation).mock.calls).toEqual([[unbound.operationId], [unbound.operationId]])
    expect(bridge.create).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('guards rapid double clicks and permits a fresh operation only after confirmed failure', async () => {
    const { bridge, saved } = fixture()
    let complete!: (operation: AgentHostCreation) => void
    vi.mocked(bridge.create).mockImplementationOnce((request) => {
      saved.set(request.operationId, { ...request, state: 'creating' })
      return new Promise((resolve) => { complete = resolve })
    })
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady />)
    await choose(user)
    const button = screen.getByRole('button', { name: 'Create and assign to T-0002' })
    act(() => { fireEvent.click(button); fireEvent.click(button) })
    expect(bridge.create).toHaveBeenCalledTimes(1)
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    await act(async () => { const failed: AgentHostCreation = { ...request, state: 'failed', error: 'Host rejected creation before starting.' }; saved.set(request.operationId, failed); complete(failed) })
    expect(screen.getByRole('heading', { name: 'Creation failed · T-0002' })).toBeInTheDocument()
    expect(bridge.create).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    expect(bridge.create).toHaveBeenCalledTimes(2)
    expect(vi.mocked(bridge.create).mock.calls[1][0].operationId).not.toBe(request.operationId)
  })

  it('does not open or bind another task when selection changes during creation', async () => {
    const { bridge, session, saved } = fixture()
    let complete!: (operation: AgentHostCreation) => void
    vi.mocked(bridge.create).mockImplementationOnce((request) => {
      saved.set(request.operationId, { ...request, state: 'creating' })
      return new Promise((resolve) => { complete = resolve })
    })
    const onCreated = vi.fn(async () => {})
    const user = userEvent.setup()
    const result = render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await choose(user)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    const request = vi.mocked(bridge.create).mock.calls[0][0]
    result.rerender(<AgentHostCreationControls taskId="T-0003" taskReady onCreated={onCreated} />)
    await act(async () => { const ready: AgentHostCreation = { ...request, state: 'ready', session }; saved.set(request.operationId, ready); complete(ready) })
    await waitFor(() => expect(bridge.creations).toHaveBeenCalledWith('T-0003'))
    expect(onCreated).not.toHaveBeenCalled()
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(request.taskId).toBe('T-0002')
    expect(screen.getByRole('button', { name: 'Create and assign to T-0003' })).toBeDisabled()
    expect(screen.queryByRole('region', { name: `Creation ${request.operationId}` })).not.toBeInTheDocument()
    result.unmount()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open created chat' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open created chat' }))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('T-0002', session)
    expect(bridge.create).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched result and retains the original operation identity', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.create).mockImplementationOnce(async (request) => ({ ...request, taskId: 'T-0003', state: 'ready' }))
    const onCreated = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await choose(user)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('does not match the original creation operation')
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Outcome uncertain · T-0002' })).toBeInTheDocument()
  })

  it('keeps a saved ready chat recoverable when the workbench callback fails', async () => {
    const { bridge } = fixture()
    const onCreated = vi.fn(async () => {}).mockRejectedValueOnce(new Error('Local links could not be reloaded.'))
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await choose(user)
    await user.click(screen.getByRole('button', { name: 'Create and assign to T-0002' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Local links could not be reloaded.')
    expect(screen.getByRole('heading', { name: 'Created and assigned · T-0002' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Open created chat' }))
    expect(onCreated).toHaveBeenCalledTimes(2)
    expect(bridge.create).toHaveBeenCalledTimes(1)
    expect(bridge.bindCreation).not.toHaveBeenCalled()
  })

  it('does not treat resolved history as a pending operation after a task was detached', async () => {
    const { bridge, operation } = fixture()
    operation('ready')
    const onCreated = vi.fn(async () => {})
    const user = userEvent.setup()
    render(<AgentHostCreationControls taskId="T-0002" taskReady onCreated={onCreated} />)
    await choose(user)
    expect(screen.getByRole('heading', { name: 'Created and assigned · T-0002' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and assign to T-0002' })).toBeEnabled()
    expect(onCreated).not.toHaveBeenCalled()
    expect(bridge.create).not.toHaveBeenCalled()
  })
})
