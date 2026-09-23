import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostBridge, AgentHostView } from '../src/shared/agentHost'
import type { LocalAgentHostCreation } from '../src/shared/localAgentHostCreation'
import App from '../src/renderer/App'
import { taskWorkspaceFixture, workspaceBridgeFixture } from './workspace-ui-fixture'

afterEach(() => { delete window.workspace; delete window.desktop; delete window.agentHost })

async function setup(mode: 'form' | 'agent' = 'form', configure?: (agent: AgentHostBridge) => void, strict = false) {
  const workspace = { ...taskWorkspaceFixture(), tasks: [] }
  const bridge = workspaceBridgeFixture({ current: workspace, recent: [workspace] })
  window.workspace = bridge
  const copyText = vi.fn(async () => {})
  window.desktop = {
    getInfo: vi.fn(async () => ({ name: 'Task Continuum', version: 'test', platform: 'win32', security: { sandboxed: true, contextIsolated: true } })),
    copyText, minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
  const target = { sessionId: 'copilotcli:/local-task-creation', chatId: 'ahp-chat:/local-task-creation', owner: { clientId: crypto.randomUUID(), machineName: 'This PC' } }
  const session = { ...target, title: 'Task planning', provider: 'copilotcli', updatedAt: new Date().toISOString(), canSend: true }
  const saved: LocalAgentHostCreation[] = []
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = { target, state: 'connected', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Task planning', modifiedAt: '', status: 1, turns: [] } }
  let watchId = ''
  const emit = () => { for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }) }
  const agent: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []),
    create: vi.fn(async () => { throw new Error('Remote creation must not be used.') }),
    creationStatus: vi.fn(async () => { throw new Error('Remote creation must not be used.') }),
    bindCreation: vi.fn(async () => { throw new Error('Task binding must not be used.') }),
    localCreationHosts: vi.fn(async () => [{ hostId: 'local-host', name: 'Local VS Code', available: true }]),
    localCreations: vi.fn(async () => structuredClone(saved)),
    createLocal: vi.fn(async (request) => {
      const result: LocalAgentHostCreation = { ...request, state: 'ready', session }
      saved.push(result)
      return result
    }),
    localCreationStatus: vi.fn(async (operationId) => {
      const result = saved.find((item) => item.operationId === operationId)
      if (!result) throw new Error('Unknown local creation.')
      return result
    }),
    models: vi.fn(async () => [{ id: 'local-model', name: 'Local model', provider: 'copilotcli' }]),
    watch: vi.fn(async () => { watchId = crypto.randomUUID(); emit(); return watchId }),
    unwatch: vi.fn(async () => {}), terminal: vi.fn(async () => {}), releaseTerminal: vi.fn(async () => {}),
    send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onView: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  configure?.(agent)
  window.agentHost = agent
  const user = userEvent.setup()
  render(strict ? <StrictMode><App /></StrictMode> : <App />)
  const button = await waitFor(() => {
    const candidate = screen.getByRole('button', { name: mode === 'form' ? 'New task' : 'Create task with agent' })
    expect(candidate).toBeEnabled()
    return candidate
  })
  await user.click(button)
  const dialog = mode === 'agent'
    ? await screen.findByRole('region', { name: 'Task creation' })
    : await screen.findByRole('dialog', { name: 'Create task' })
  if (mode === 'form') await waitFor(() => expect(bridge.getTaskCreationContext).toHaveBeenCalledWith(workspace.id))
  return { workspace, bridge, copyText, user, dialog, agent, target, view, emit, saved }
}

describe('quick task creation', () => {
  it('creates a first task using configured defaults and opens it without publishing or creating sessions', async () => {
    const { workspace, bridge, user, dialog, agent } = await setup()
    expect(screen.getByRole('button', { name: 'New task repository' })).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox', { name: 'Task title' }), '实现登录')
    await user.type(within(dialog).getByRole('textbox', { name: 'Description (optional)' }), 'Add a sign-in flow.')
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(bridge.createTask).toHaveBeenCalledExactlyOnceWith({
      workspaceId: workspace.id,
      draft: { title: '实现登录', description: 'Add a sign-in flow.', parentId: null, owner: 'fixture-user', type: 'feature', priority: 'P2', acceptance: [] },
    })
    expect(await screen.findByRole('heading', { level: 1, name: '实现登录' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '实现登录' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Create task' })).not.toBeInTheDocument()
    expect((await bridge.getState()).current?.tasks).toHaveLength(1)
    expect(bridge.createRepository).not.toHaveBeenCalled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
    expect(bridge.getTaskAgentInstructions).not.toHaveBeenCalled()
    expect(agent.createLocal).not.toHaveBeenCalled()
  })

  it('retains input and does not duplicate a pending creation when submission is repeated', async () => {
    const { bridge, user, dialog } = await setup()
    let fail!: (error: Error) => void
    vi.mocked(bridge.createTask).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Task title' }), 'Keep this title')
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    fireEvent.submit(dialog.querySelector('form')!)
    expect(bridge.createTask).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => { fail(new Error('Task creation is already in progress.')) })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already in progress')
    expect(within(dialog).getByRole('textbox', { name: 'Task title' })).toHaveValue('Keep this title')
    expect((await bridge.getState()).current?.tasks).toEqual([])
  })

  it('directly creates a local session in an empty workspace and sends contextual instructions through native chat', async () => {
    const { workspace, bridge, copyText, user, dialog, agent, target } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(dialog.parentElement).toHaveClass('active-task')
    expect(dialog.nextElementSibling).toHaveAttribute('aria-label', 'Resize task details')
    expect(screen.getByRole('main', { name: 'Task workspace' })).toBeInTheDocument()
    expect(agent.createLocal).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), hostId: 'local-host' })
    expect(agent.send).not.toHaveBeenCalled()
    const input = within(dialog).getByRole('textbox', { name: 'Message Agent Host' })
    await user.type(input, 'Create a sign-in task.')
    expect(within(dialog).getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent Host model' }), await within(dialog).findByRole('option', { name: 'Local model' }))
    await user.click(within(dialog).getByRole('button', { name: 'Send to Agent Host' }))
    expect(bridge.getTaskAgentInstructions).toHaveBeenCalledExactlyOnceWith({ workspaceId: workspace.id, goal: 'Create a sign-in task.', parentId: null })
    expect(agent.send).toHaveBeenCalledExactlyOnceWith(target, expect.any(String), expect.stringContaining(workspace.root), undefined, { id: 'local-model' })
    await waitFor(() => expect(input).toHaveValue(''))
    await user.type(input, 'Also cover logout.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to Agent Host' }))
    expect(agent.send).toHaveBeenLastCalledWith(target, expect.any(String), 'Also cover logout.', undefined, { id: 'local-model' })
    expect(bridge.getTaskAgentInstructions).toHaveBeenCalledOnce()
    expect(copyText).not.toHaveBeenCalled()
    expect(bridge.createTask).not.toHaveBeenCalled()
    expect(bridge.createRepository).not.toHaveBeenCalled()
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(agent.create).not.toHaveBeenCalled()
    expect(agent.bindCreation).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole('button', { name: 'Detach conversation' })).not.toBeInTheDocument()
  })

  it('retains the creation draft and model while hiding and restoring central chat', async () => {
    const { user, dialog, agent } = await setup('agent')
    const input = await within(dialog).findByRole('textbox', { name: 'Message Agent Host' })
    await user.type(input, 'Keep this unsent task request.')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent Host model' }), await within(dialog).findByRole('option', { name: 'Local model' }))
    await user.click(screen.getByRole('button', { name: 'Toggle chat panel' }))
    expect(screen.queryByRole('region', { name: 'Task creation' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Toggle chat panel' }))
    await within(dialog).findByText('Connected', { exact: true })
    expect(within(dialog).getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep this unsent task request.')
    expect(within(dialog).getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('local-model')
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('requires human review and confirmation before creating an agent-provided JSON draft', async () => {
    const { bridge, user, dialog: panel } = await setup('agent')
    await within(panel).findByRole('complementary', { name: 'Agent Host task creation chat' })
    await user.click(within(panel).getByRole('button', { name: 'Review agent draft' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create task' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Agent task draft (JSON)' }), {
      target: { value: '```json\n{"title":"Agent proposal","description":"Proposed requirements","acceptance":["Sign-in works"]}\n```' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Review draft' }))
    expect(within(dialog).getByRole('textbox', { name: 'Task title' })).toHaveValue('Agent proposal')
    expect(within(dialog).getByText(/No task files have been created yet/)).toBeInTheDocument()
    expect(bridge.createTask).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(bridge.createTask).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ title: 'Agent proposal', acceptance: ['Sign-in works'] }),
    }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent proposal' })).toBeInTheDocument()
  })

  it('rejects unsafe draft fields without changing tasks or switching to a success state', async () => {
    const { bridge, user, dialog: panel } = await setup('agent')
    await within(panel).findByRole('complementary', { name: 'Agent Host task creation chat' })
    await user.click(within(panel).getByRole('button', { name: 'Review agent draft' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create task' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Agent task draft (JSON)' }), {
      target: { value: '{"title":"Not accepted","id":"T-0001","status":"done"}' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Review draft' }))
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(bridge.createTask).not.toHaveBeenCalled()
    expect((await bridge.getState()).current?.tasks).toEqual([])
  })

  it('refreshes and selects task files created externally by an agent', async () => {
    const { workspace, bridge, user, dialog, agent } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    vi.mocked(bridge.getSessionLinks).mockRejectedValue(new Error('Enable Automatic workspace links before accessing session bindings.'))
    await bridge.createTask({ workspaceId: workspace.id, draft: { title: 'Created externally' } })
    await user.click(within(dialog).getByRole('button', { name: 'Refresh created tasks' }))
    expect(bridge.refresh).toHaveBeenCalledOnce()
    expect(await screen.findByRole('heading', { level: 1, name: 'Created externally' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Create task' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('complementary', { name: 'Agent Host task creation chat' })).toBeInTheDocument()
    expect(within(dialog).getByText('Opened T-0001. You can keep chatting here.')).toBeInTheDocument()
    expect(bridge.getSessionLinks).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Show task conversation' }))
    expect(screen.getByRole('complementary', { name: 'Task chat' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create task with agent' }))
    await screen.findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reopens the original local conversation without creating a second session', async () => {
    const { user, dialog, agent } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    await user.click(within(dialog).getByRole('button', { name: 'Hide chat panel' }))
    await user.click(screen.getByRole('button', { name: 'Create task with agent' }))
    await screen.findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(agent.localCreations).toHaveBeenCalledTimes(2)
    expect(agent.createLocal).toHaveBeenCalledOnce()
  })

  it('checks a saved chat before reopening and permits explicit creation after confirmed deletion', async () => {
    const { user, dialog, agent, saved } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    await user.click(within(dialog).getByRole('button', { name: 'Hide chat panel' }))
    vi.mocked(agent.localCreationStatus).mockResolvedValueOnce({ ...saved[0], state: 'failed', error: 'The original task creation session was explicitly deleted.' })
    await user.click(screen.getByRole('button', { name: 'Create task with agent' }))
    const panel = await screen.findByRole('region', { name: 'Task creation' })
    expect(await within(panel).findByText(/session was explicitly deleted/)).toBeInTheDocument()
    expect(agent.localCreationStatus).toHaveBeenCalledExactlyOnceWith(saved[0].operationId)
    expect(within(panel).queryByRole('complementary', { name: 'Agent Host task creation chat' })).not.toBeInTheDocument()
    expect(agent.createLocal).toHaveBeenCalledOnce()
    await user.click(within(panel).getByRole('button', { name: 'Create local agent session' }))
    await within(panel).findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(agent.createLocal).toHaveBeenCalledTimes(2)
    expect(vi.mocked(agent.createLocal).mock.calls[1][0].operationId).not.toBe(saved[0].operationId)
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('moves from quick create to the central chat pane without nesting chat in a dialog', async () => {
    const { user, dialog, agent } = await setup()
    await user.click(within(dialog).getByRole('button', { name: 'Create with agent in the chat panel' }))
    const panel = await screen.findByRole('region', { name: 'Task creation' })
    await within(panel).findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(panel.parentElement).toHaveClass('active-task')
    expect(agent.createLocal).toHaveBeenCalledOnce()
  })

  it.each(['Reconnect Agent Host', 'Retry loading models'])('checks for deletion through %s without automatically replacing the chat', async (button) => {
    const { user, dialog, agent, saved } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    await within(dialog).findByRole('option', { name: 'Local model' })
    vi.mocked(agent.localCreationStatus).mockResolvedValueOnce({ ...saved[0], state: 'failed', error: 'The original local session was explicitly deleted.' })
    await user.click(within(dialog).getByRole('button', { name: button }))
    expect(await within(dialog).findByText(/session was explicitly deleted/)).toBeInTheDocument()
    expect(agent.localCreationStatus).toHaveBeenCalledExactlyOnceWith(saved[0].operationId)
    expect(within(dialog).getByRole('button', { name: 'Create local agent session' })).toBeEnabled()
    expect(within(dialog).queryByRole('complementary', { name: 'Agent Host task creation chat' })).not.toBeInTheDocument()
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('retains the unsent draft during uncertain revalidation and resumes only the same chat', async () => {
    const { user, dialog, agent, saved } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    const input = within(dialog).getByRole('textbox', { name: 'Message Agent Host' })
    await user.type(input, 'Keep these requirements.')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent Host model' }), await within(dialog).findByRole('option', { name: 'Local model' }))
    vi.mocked(agent.localCreationStatus).mockResolvedValueOnce({ ...saved[0], state: 'uncertain', error: 'The original Host is temporarily offline.' })
    await user.click(within(dialog).getByRole('button', { name: 'Reconnect Agent Host' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('temporarily offline')
    expect(input).toHaveValue('Keep these requirements.')
    expect(within(dialog).getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Create local agent session' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Reconnect Agent Host' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled())
    expect(input).toHaveValue('Keep these requirements.')
    expect(vi.mocked(agent.localCreationStatus).mock.calls).toEqual([[saved[0].operationId], [saved[0].operationId]])
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('does not duplicate automatic creation under Strict Mode effect replay', async () => {
    const { dialog, agent } = await setup('agent', undefined, true)
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('checks an in-progress native creation until its original chat is ready', async () => {
    const { dialog, agent } = await setup('agent', (agent) => {
      const create = vi.mocked(agent.createLocal).getMockImplementation()!
      vi.mocked(agent.createLocal).mockImplementationOnce(async (request) => {
        vi.mocked(agent.localCreationStatus).mockImplementationOnce(() => create(request))
        return { ...request, state: 'creating' }
      })
    })
    expect(await within(dialog).findByText('Creating the local session...')).toBeInTheDocument()
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' }, { timeout: 3000 })
    expect(agent.localCreationStatus).toHaveBeenCalledOnce()
    expect(agent.createLocal).toHaveBeenCalledOnce()
  })

  it('requires an explicit host choice when several local hosts are available', async () => {
    const { user, dialog, agent } = await setup('agent', (agent) => {
      vi.mocked(agent.localCreationHosts).mockResolvedValue([
        { hostId: 'first-host', name: 'First VS Code', available: true },
        { hostId: 'second-host', name: 'Second VS Code', available: true },
      ])
    })
    const hosts = await within(dialog).findByRole('combobox', { name: 'Local Agent Host' })
    expect(agent.createLocal).not.toHaveBeenCalled()
    await user.selectOptions(hosts, 'second-host')
    await user.click(within(dialog).getByRole('button', { name: 'Create local agent session' }))
    expect(agent.createLocal).toHaveBeenCalledExactlyOnceWith({ operationId: expect.any(String), hostId: 'second-host' })
  })

  it('reports an unavailable local host without falling back to remote creation or copying', async () => {
    const { dialog, agent, copyText } = await setup('agent', (agent) => { vi.mocked(agent.localCreationHosts).mockResolvedValue([]) })
    expect(await within(dialog).findByText(/No supported local Agent Host is available/)).toBeInTheDocument()
    expect(agent.createLocal).not.toHaveBeenCalled()
    expect(agent.create).not.toHaveBeenCalled()
    expect(copyText).not.toHaveBeenCalled()
  })

  it('inspects an uncertain original operation instead of replaying creation', async () => {
    const { dialog, agent, user } = await setup('agent', (agent) => {
      vi.mocked(agent.createLocal).mockImplementation(async (request) => ({ ...request, state: 'uncertain', error: 'Native acknowledgement was lost.' }))
      vi.mocked(agent.localCreationStatus).mockImplementation(async (operationId) => ({ operationId, hostId: 'local-host', state: 'uncertain' }))
    })
    expect(await within(dialog).findByText(/Session creation outcome is uncertain/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Check session status' }))
    expect(agent.localCreationStatus).toHaveBeenCalledExactlyOnceWith(vi.mocked(agent.createLocal).mock.calls[0][0].operationId)
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(within(dialog).queryByRole('button', { name: 'Create local agent session' })).not.toBeInTheDocument()
  })

  it('does not retry a lost create response when local hosts are reloaded', async () => {
    const { dialog, agent, user } = await setup('agent', (agent) => {
      vi.mocked(agent.createLocal).mockRejectedValue(new Error('The native creation response was lost.'))
    })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('creation response was lost')
    await user.click(within(dialog).getByRole('button', { name: 'Reload local hosts' }))
    await waitFor(() => expect(agent.localCreations).toHaveBeenCalledTimes(2))
    expect(agent.createLocal).toHaveBeenCalledOnce()
    expect(await within(dialog).findByRole('button', { name: 'Check session status' })).toBeEnabled()
    expect(within(dialog).queryByRole('button', { name: 'Create local agent session' })).not.toBeInTheDocument()
  })

  it('retains the user draft and sends nothing if task guidance cannot be generated', async () => {
    const { bridge, user, dialog, agent } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    vi.mocked(bridge.getTaskAgentInstructions).mockRejectedValue(new Error('The selected parent task no longer exists.'))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent Host model' }), await within(dialog).findByRole('option', { name: 'Local model' }))
    const input = within(dialog).getByRole('textbox', { name: 'Message Agent Host' })
    await user.type(input, 'Keep my requirements.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to Agent Host' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('parent task no longer exists')
    expect(input).toHaveValue('Keep my requirements.')
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('rejects oversized first-message context without dropping the request or creating another session', async () => {
    const { bridge, user, dialog, agent } = await setup('agent')
    await within(dialog).findByRole('complementary', { name: 'Agent Host task creation chat' })
    vi.mocked(bridge.getTaskAgentInstructions).mockResolvedValue('x'.repeat(4001))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent Host model' }), await within(dialog).findByRole('option', { name: 'Local model' }))
    const input = within(dialog).getByRole('textbox', { name: 'Message Agent Host' })
    await user.type(input, 'Keep this request.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to Agent Host' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('exceed the chat limit')
    expect(input).toHaveValue('Keep this request.')
    expect(agent.send).not.toHaveBeenCalled()
    expect(agent.createLocal).toHaveBeenCalledOnce()
  })
})
