import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import type { SendMessageRequest } from '../src/shared/sessions'
import { mockCopilotBridge } from './copilot-fixtures'

afterEach(() => { delete window.copilot; delete window.vscodeChat })
function localSessions() { return within(screen.getByRole('complementary', { name: 'Local sessions' })) }

async function connectedApp() {
  const host = mockCopilotBridge()
  window.copilot = host.bridge
  const user = userEvent.setup()
  const view = render(<App />)
  await user.click(within(screen.getByRole('complementary', { name: 'Task chat' })).getByRole('button', { name: 'Connect Copilot' }))
  await screen.findByText('Copilot connected')
  await user.click(screen.getByRole('button', { name: 'Sessions' }))
  await waitFor(() => expect(localSessions().getByRole('button', { name: 'Resume Existing CLI work' })).toBeEnabled())
  return { host, user, view }
}

describe('Copilot workbench integration', () => {
  it('restores a native session, streams a real adapter reply, and persists the binding', async () => {
    const { host, user, view } = await connectedApp()
    await user.click(localSessions().getByRole('button', { name: 'Resume Existing CLI work' }))
    expect(await screen.findByText('Previous local answer')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message to Copilot' }), 'Continue the work')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText('A real local response')).toBeInTheDocument()
    expect(host.bridge.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-session', message: 'Continue the work' }))
    expect(localStorage.getItem('taskcontinuum:session-bindings:v1')).toContain('native-session')
    view.unmount()
    render(<App />)
    expect(await screen.findByText('Previous local answer')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message to Copilot' })).toBeEnabled()
  })

  it('previews VS Code history and imports it only after confirmation', async () => {
    const { host, user } = await connectedApp()
    await user.click(localSessions().getByRole('button', { name: 'Preview Existing VS Code work' }))
    const preview = await screen.findByRole('dialog', { name: 'Continue VS Code conversation' })
    expect(host.bridge.importSession).not.toHaveBeenCalled()
    await user.click(within(preview).getByRole('button', { name: 'Continue in new session' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(host.bridge.importSession).toHaveBeenCalledWith('preview-token', expect.objectContaining({ workingDirectory: host.source.workingDirectory }))
    expect(localStorage.getItem('taskcontinuum:session-bindings:v1')).toContain('imported-session')
  })

  it('links and restores an original VS Code conversation without CLI resume, import, or fork', async () => {
    const { host, user, view } = await connectedApp()
    host.source.id = `vscode:0:${'a'.repeat(32)}:original-chat.jsonl`
    const read = vi.fn(async () => ({ session: host.source, messages: host.messages }))
    window.vscodeChat = { read, open: vi.fn(async () => {}), watch: vi.fn(async () => {}), onChange: () => () => {} }
    await user.click(localSessions().getByRole('button', { name: 'Preview Existing VS Code work' }))
    expect(screen.queryByRole('button', { name: 'Continue in new session' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import into new session' })).toHaveAttribute('aria-expanded', 'false')
    await user.click(await screen.findByRole('button', { name: 'Link to current task' }))
    expect(await screen.findByRole('complementary', { name: 'VS Code task chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Original session linked' })).toBeInTheDocument()
    expect(screen.queryByText('Copilot disconnected')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledWith({ nativeSessionId: 'original-chat', workspaceStorageId: 'a'.repeat(32) })
    expect(host.bridge.createSession).not.toHaveBeenCalled()
    expect(host.bridge.importSession).not.toHaveBeenCalled()
    expect(host.bridge.resumeSession).not.toHaveBeenCalled()
    expect(host.bridge.send).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('taskcontinuum:session-bindings:v1')!)['T-0002']).toMatchObject({ id: 'original-chat', vscodeWorkspaceStorageId: 'a'.repeat(32) })
    view.unmount()
    render(<App />)
    await screen.findByText('Previous local answer')
    expect(host.bridge.resumeSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Detach conversation' }))
    await user.click(screen.getByRole('button', { name: 'Detach session' }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'VS Code task chat' })).not.toBeInTheDocument())
  })

  it('reopens a streaming session without resuming, rebinding, or cancelling it', async () => {
    const { host, user } = await connectedApp()
    let request!: SendMessageRequest
    let complete!: () => void
    vi.mocked(host.bridge.send).mockImplementation((value) => {
      request = value
      host.emit({ type: 'delta', ...value, text: 'Still working' })
      return new Promise<void>((resolve) => { complete = resolve })
    })
    await user.click(localSessions().getByRole('button', { name: 'Resume Existing CLI work' }))
    await user.type(screen.getByRole('textbox', { name: 'Message to Copilot' }), 'Continue')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Still working')
    vi.mocked(host.bridge.resumeSession).mockRejectedValue(new Error('This conversation is still responding.'))
    await user.click(localSessions().getByRole('button', { name: 'Resume Existing CLI work' }))
    expect(host.bridge.resumeSession).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.click(screen.getByRole('button', { name: 'T-0003 Backend service' }))
    await user.click(screen.getByRole('button', { name: 'Sessions' }))
    await waitFor(() => expect(localSessions().getByRole('button', { name: 'Resume Existing CLI work' })).toBeEnabled())
    await user.click(localSessions().getByRole('button', { name: 'Resume Existing CLI work' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('UI based on Electron')
    expect(host.bridge.resumeSession).toHaveBeenCalledOnce()
    expect(host.bridge.abort).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => {
      host.emit({ type: 'delta', ...request, text: ' without interruption' })
      host.emit({ type: 'complete', ...request })
      complete()
    })
    expect(await screen.findByText('Still working without interruption')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('taskcontinuum:session-bindings:v1')!)['T-0002'].id).toBe('native-session')
  })

  it('creates a native session without sending a hidden initial model request', async () => {
    const { host, user } = await connectedApp()
    await user.click(localSessions().getByRole('button', { name: 'New Copilot session' }))
    await user.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(host.bridge.createSession).toHaveBeenCalledOnce())
    expect(host.bridge.send).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message to Copilot' })).toBeEnabled())
  })

  it('routes tool permission decisions to the request that raised them', async () => {
    const { host, user } = await connectedApp()
    act(() => host.emit({ type: 'permission', id: 'approval-id', sessionId: 'native-session', kind: 'write', details: 'Update one file' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Copilot permission' })).getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(host.bridge.respond).toHaveBeenCalledWith('approval-id', false)
  })

  it('stays in explicit live-offline mode after authentication fails', async () => {
    const host = mockCopilotBridge()
    vi.mocked(host.bridge.connect).mockResolvedValue({ state: 'auth-required', workingDirectory: 'Q:\\src', error: 'Copilot CLI sign-in is required.' })
    window.copilot = host.bridge
    const user = userEvent.setup()
    render(<App />)
    await user.click(within(screen.getByRole('complementary', { name: 'Task chat' })).getByRole('button', { name: 'Connect Copilot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('sign-in is required')
    expect(screen.getByRole('textbox', { name: 'Message to Copilot' })).toBeDisabled()
    expect(screen.queryByText('LOCAL DEMO')).not.toBeInTheDocument()
    expect(host.bridge.send).not.toHaveBeenCalled()
  })
})