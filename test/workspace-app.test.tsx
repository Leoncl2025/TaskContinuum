import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import { demoTasks } from '../src/renderer/data/tasks'
import { saveSessionBindings } from '../src/renderer/chat/sessionBindings'
import type { WorkspaceBridge, WorkspaceSnapshot, WorkspaceState } from '../src/shared/workspace'
import type { SendMessageRequest } from '../src/shared/sessions'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import type { AgentHostBridge, AgentHostSession } from '../src/shared/agentHost'
import type { AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import { mockCopilotBridge } from './copilot-fixtures'

afterEach(() => { delete window.workspace; delete window.copilot; delete window.agentHost })

function fixtures() {
  const first: WorkspaceSnapshot = { id: 'workspace-one', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [{ ...demoTasks[1], title: 'Actual UI task', status: 'done', documents: { requirements: '# Actual requirements\n\nSaved in the first workspace.', plan: '# Actual plan\n\nA persisted plan.', checklist: null } }], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }
  const second: WorkspaceSnapshot = { ...first, id: 'workspace-two', name: 'Other-ad', root: 'Q:\\src\\Projects\\Other-ad', tasks: [{ ...first.tasks[0], title: 'Different task with same ID', status: 'blocked' }] }
  let state: WorkspaceState = { current: null, recent: [first, second] }
  const repository: Record<string, SessionLinksSnapshot> = {}
  const bridge: WorkspaceBridge = {
    getState: vi.fn(async () => state),
    openFolder: vi.fn(async () => { state = { ...state, current: first }; return state }),
    openRecent: vi.fn(async (id) => { state = { ...state, current: id === first.id ? first : second }; return state }),
    refresh: vi.fn(async () => state),
    useDemo: vi.fn(async () => { state = { ...state, current: null }; return state }),
    getSessionLinks: vi.fn(async (id) => repository[id] ?? { document: { schemaVersion: 1, bindings: {} }, revision: null }),
    updateSessionLink: vi.fn(async (request) => {
      const bindings = { ...repository[request.workspaceId]?.document.bindings }
      if (request.sessionId === null) delete bindings[request.taskId]
      else bindings[request.taskId] = { provider: 'github-copilot', sessionId: request.sessionId }
      return repository[request.workspaceId] = { document: { schemaVersion: 1, bindings }, revision: 'a'.repeat(64) }
    }),
    migrateSessionLinks: vi.fn(async (request) => repository[request.workspaceId] = { document: { schemaVersion: 1, bindings: request.bindings }, revision: 'b'.repeat(64) }),
  }
  window.workspace = bridge
  return { bridge, first, second, repository }
}

function creationFixture() {
  const workspace = fixtures()
  const owner = { clientId: crypto.randomUUID(), machineName: 'Creation worker' }
  const target = { hostId: 'exact-host-123', sessionId: 'ahp-session:/new-chat', chatId: 'ahp-chat:/new-chat/main', owner }
  const session: AgentHostSession = { ...target, title: 'Created chat', provider: 'copilotcli', updatedAt: '', canSend: true }
  const worker: AgentHostWorker = { id: 'paired-worker', owner, state: 'connected', hosts: [{ hostId: target.hostId, name: 'Native Host', available: true }], workspaces: [{ id: 'worker-workspace', name: 'Worker project', canSend: true, taskState: 'available', expectedRevision: 'd'.repeat(64) }] }
  const saved = new Map<string, AgentHostCreation>()
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
    models: vi.fn(async () => []), watch: vi.fn(async () => crypto.randomUUID()),
    unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}), onView: () => () => {},
  }
  window.agentHost = agentHost
  return { ...workspace, agentHost, target, saved }
}

async function selectCreationTarget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
  await screen.findByRole('option', { name: /Creation worker/ })
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

  it('reloads the already-saved creation binding for its original task and clears only that task', async () => {
    const { bridge, first, repository, agentHost, target } = creationFixture()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Other task draft' })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { level: 1, name: 'Actual UI task' })
    await user.click(screen.getByRole('button', { name: 'T-0003 Other task draft' }))
    await user.type(screen.getByRole('textbox', { name: 'Message to demo agent' }), 'Keep the other task draft')
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    await user.type(screen.getByRole('textbox', { name: 'Message to demo agent' }), 'Clear only the original task draft')
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
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep the other task draft')
    await user.click(screen.getByRole('tab', { name: 'Actual UI task' }))
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue(''))
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
    await bridge.openRecent(second.id)
    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Different task with same ID' })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toBeEnabled())
    await user.type(screen.getByRole('textbox', { name: 'Message to demo agent' }), 'Keep the new workspace draft')
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep the new workspace draft')
    await act(async () => { finishReload(repository[first.id]) })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Different task with same ID')
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep the new workspace draft')
    expect(screen.queryByRole('complementary', { name: 'Agent Host task chat' })).not.toBeInTheDocument()
    expect(repository[second.id]).toBeUndefined()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agentHost.create).toHaveBeenCalledTimes(1)
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
    const { first, repository, agentHost } = creationFixture()
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'already-linked' } } }, revision: 'b'.repeat(64) }
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

  it('opens an AHP Git link without resuming or creating a CLI session', async () => {
    const { first, repository } = fixtures()
    const host = mockCopilotBridge()
    await host.bridge.connect()
    window.copilot = host.bridge
    const owner = { clientId: crypto.randomUUID(), machineName: 'Owner-B' }
    const target = { hostId: 'host-instance-123', sessionId: 'ahp-session:/original', chatId: 'ahp-chat:/original/main', owner }
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64), localOwner: owner }
    window.agentHost = { list: vi.fn(async () => ({ sessions: [], warnings: [] })), creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []), create: vi.fn(async () => { throw new Error('No creation expected.') }), creationStatus: vi.fn(async () => { throw new Error('No creation expected.') }), bindCreation: vi.fn(async () => { throw new Error('No creation expected.') }), models: vi.fn(async () => []), watch: vi.fn(async () => crypto.randomUUID()), unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}), onView: () => () => {} }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('complementary', { name: 'Agent Host task chat' })).toBeInTheDocument()
    await waitFor(() => expect(window.agentHost!.watch).toHaveBeenCalledWith(target))
    expect(host.bridge.resumeSession).not.toHaveBeenCalled()
    expect(host.bridge.createSession).not.toHaveBeenCalled()
    expect(host.bridge.importSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary', { name: 'VS Code task chat' })).not.toBeInTheDocument()
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
    const { bridge } = fixtures()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.type(screen.getByRole('textbox', { name: 'Message to demo agent' }), 'Keep my draft')
    vi.mocked(bridge.openFolder).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Not an AgentDesk workspace'))
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep my draft')
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not an AgentDesk workspace')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Actual UI task')
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep my draft')
  })

  it('isolates session bindings across identical task IDs and uses the active workspace as the new session directory', async () => {
    const { first, second, repository } = fixtures()
    const host = mockCopilotBridge()
    await host.bridge.connect()
    window.copilot = host.bridge
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'first-session' } } }, revision: 'a'.repeat(64) }
    repository[second.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'second-session' } } }, revision: 'b'.repeat(64) }
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await waitFor(() => expect(host.bridge.resumeSession).toHaveBeenCalledWith('first-session'))
    await user.type(screen.getByRole('textbox', { name: 'Message to Copilot' }), 'First workspace draft')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), second.id)
    expect(await screen.findByRole('heading', { level: 1, name: 'Different task with same ID' })).toBeInTheDocument()
    await waitFor(() => expect(host.bridge.resumeSession).toHaveBeenCalledWith('second-session'))
    expect(screen.getByRole('textbox', { name: 'Message to Copilot' })).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    const sessions = within(screen.getByRole('complementary', { name: 'Local sessions' }))
    await waitFor(() => expect(sessions.getByRole('button', { name: 'New Copilot session' })).toBeEnabled())
    await user.click(sessions.getByRole('button', { name: 'New Copilot session' }))
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue(second.root)
    await user.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(host.bridge.createSession).toHaveBeenCalledWith({ workingDirectory: second.root, model: undefined }))
  })

  it('locks workspace changes during an active response and releases them after completion', async () => {
    fixtures()
    const host = mockCopilotBridge()
    await host.bridge.connect()
    window.copilot = host.bridge
    let request!: SendMessageRequest
    let finish!: () => void
    vi.mocked(host.bridge.send).mockImplementation((value) => {
      request = value
      host.emit({ type: 'delta', ...value, text: 'Workspace response' })
      return new Promise<void>((resolve) => { finish = resolve })
    })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Existing CLI work' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Resume Existing CLI work' }))
    await user.type(screen.getByRole('textbox', { name: 'Message to Copilot' }), 'Continue')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Workspace response')
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Switch workspace folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled()
    await act(async () => { host.emit({ type: 'complete', ...request }); finish() })
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled()
  })

  it('refreshes actual task content without dropping the draft or selected task', async () => {
    const { bridge, first } = fixtures()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.type(screen.getByRole('textbox', { name: 'Message to demo agent' }), 'Draft stays here')
    vi.mocked(bridge.refresh).mockResolvedValue({ current: { ...first, tasks: [{ ...first.tasks[0], title: 'Changed on disk' }] }, recent: [first] })
    await user.click(screen.getByRole('button', { name: 'Refresh workspace' }))
    expect(await screen.findByRole('heading', { name: 'Changed on disk', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Draft stays here')
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

  it('reviews local-only links before saving them to the repository without private titles', async () => {
    const { bridge, first } = fixtures()
    saveSessionBindings({ 'T-0002': { id: 'legacy-session', title: 'Private conversation title' } }, first.id)
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await user.click(await screen.findByRole('button', { name: 'Review links' }))
    const dialog = screen.getByRole('dialog', { name: 'Save session links to workspace' })
    expect(within(dialog).getByText('legacy-session')).toBeInTheDocument()
    expect(within(dialog).queryByText('Private conversation title')).not.toBeInTheDocument()
    expect(bridge.migrateSessionLinks).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Save links to workspace' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(bridge.migrateSessionLinks).toHaveBeenCalledWith({ workspaceId: first.id, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'legacy-session' } } })
  })

  it('keeps a repository link visible and detachable when the session is unavailable locally', async () => {
    const { bridge, first, repository } = fixtures()
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'session-on-another-machine' } } }, revision: 'c'.repeat(64) }
    const host = mockCopilotBridge()
    await host.bridge.connect()
    vi.mocked(host.bridge.resumeSession).mockRejectedValue(new Error('This local Copilot conversation was not found.'))
    window.copilot = host.bridge
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not resume linked session session-on-another-machine')
    expect(screen.getByText('session-on-another-machine')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to Copilot' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(bridge.updateSessionLink).toHaveBeenCalledWith({ workspaceId: first.id, taskId: 'T-0002', sessionId: null, expectedRevision: 'c'.repeat(64) }))
  })

  it('routes a linked session back to its owning task without rewriting the repository', async () => {
    const { bridge, first, repository } = fixtures()
    first.tasks.push({ ...first.tasks[0], id: 'T-0003', title: 'Another task' })
    repository[first.id] = { document: { schemaVersion: 1, bindings: { 'T-0003': { provider: 'github-copilot', sessionId: 'native-session' } } }, revision: 'd'.repeat(64) }
    const host = mockCopilotBridge()
    await host.bridge.connect()
    window.copilot = host.bridge
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    await screen.findByRole('heading', { name: 'Actual UI task', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    const row = await screen.findByRole('button', { name: 'Resume Existing CLI work' })
    await waitFor(() => expect(row).toBeEnabled())
    expect(within(row).getByText('T-0003')).toBeInTheDocument()
    await user.click(row)
    expect(await screen.findByRole('heading', { name: 'Another task', level: 1 })).toBeInTheDocument()
    await screen.findByText('Previous local answer')
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(repository[first.id].document.bindings['T-0003'].sessionId).toBe('native-session')
  })
})