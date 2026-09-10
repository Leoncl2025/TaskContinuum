import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VSCodeChatPanel } from '../src/renderer/components/VSCodeChatPanel'
import { demoTasks } from '../src/renderer/data/tasks'
import type { VSCodeChatBridge, VSCodeChatDelivery, VSCodeChatView } from '../src/shared/vscodeChat'
import type { SessionSnapshot } from '../src/shared/sessions'
import type { VSCodeChatTarget } from '../src/shared/remoteVSCode'

afterEach(() => { delete window.vscodeChat })
const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }

function fixture() {
  const listeners = new Set<(identity: VSCodeChatTarget) => void>()
  const bridge: VSCodeChatBridge = {
    read: vi.fn(async (): Promise<SessionSnapshot> => ({ session: { id: 'original', source: 'vscode', title: 'Existing conversation', updatedAt: '2026-09-07T00:00:00Z' }, messages: [{ id: 'answer', role: 'assistant', text: 'Original answer', status: 'complete' }] })),
    open: vi.fn(async () => {}), watch: vi.fn(async () => {}),
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.vscodeChat = bridge
  return { bridge, changed: (target: VSCodeChatTarget = identity) => { for (const listener of listeners) listener(target) } }
}

describe('original VS Code conversation panel', () => {
  it.each([
    { remote: false, connectionState: 'connected' as const },
    { remote: true, connectionState: 'connected' as const },
    { remote: false, connectionState: 'offline' as const },
    { remote: true, connectionState: 'offline' as const },
  ])('submits with one Send action when remote=$remote and state=$connectionState', async ({ remote, connectionState }) => {
    const { bridge } = fixture()
    const target = { ...identity, ...(remote ? { remoteMachineName: 'Machine-B' } : {}) }
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'One action', updatedAt: '' }, messages: [], connectionState, canSend: false, sessionOpen: false, canPrepareSend: connectionState === 'connected', canOpenRemote: true })
    bridge.connect = vi.fn(async () => {})
    bridge.send = vi.fn(async (_target, id, text): Promise<VSCodeChatDelivery> => ({ id, text, nativeSessionId: identity.nativeSessionId, state: 'pending', createdAt: new Date().toISOString(), participant: { username: 'Alice', machineName: 'A' }, execution: { agentName: 'GitHub Copilot', machineName: 'B' } }))
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('One action')
    await user.type(screen.getByRole('textbox'), 'Prepare and send')
    const send = screen.getByRole('button', { name: 'Send to original VS Code session' })
    expect(send).toBeEnabled()
    expect(screen.queryByText('The original conversation is not ready for sending.')).not.toBeInTheDocument()
    await user.dblClick(send)
    expect(bridge.send).toHaveBeenCalledExactlyOnceWith(target, expect.any(String), 'Prepare and send')
    expect(bridge.connect).not.toHaveBeenCalled()
    expect(bridge.open).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('explicitly opens the remote original, refreshes readiness and keeps the draft without sending', async () => {
    const { bridge, changed } = fixture()
    const target = { ...identity, remoteMachineName: 'Machine-B' }
    const snapshot: VSCodeChatView = { session: { id: 'original', source: 'vscode', title: 'On B', updatedAt: '' }, messages: [], connectionState: 'connected', canSend: false, canOpenRemote: true, sessionOpen: false }
    vi.mocked(bridge.read).mockResolvedValue(snapshot)
    bridge.send = vi.fn()
    vi.mocked(bridge.open).mockImplementation(async () => { vi.mocked(bridge.read).mockResolvedValue({ ...snapshot, sessionOpen: true, canSend: true }) })
    render(<VSCodeChatPanel task={demoTasks[1]} identity={target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const user = userEvent.setup()
    await screen.findByText('On B')
    expect(screen.getByText('Session not open')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect SSH' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), 'Retain this draft')
    expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    expect(bridge.open).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Open session on Machine-B' }))
    expect(bridge.open).toHaveBeenCalledExactlyOnceWith(target)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveValue('Retain this draft')
    expect(bridge.send).not.toHaveBeenCalled()
    expect(screen.queryByText('Session not open')).not.toBeInTheDocument()
    vi.mocked(bridge.read).mockResolvedValue({ ...snapshot, canOpenRemote: false })
    act(() => changed(target))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open session on Machine-B' })).toBeDisabled())
    vi.mocked(bridge.read).mockResolvedValue({ ...snapshot, connectionState: 'offline' })
    act(() => changed(target))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open session on Machine-B' })).toBeDisabled())
  })

  it('reads and opens the exact original without exposing a substitute sender', async () => {
    const { bridge, changed } = fixture()
    const user = userEvent.setup()
    const view = render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Original answer')
    expect(bridge.read).toHaveBeenCalledWith(identity)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    expect(bridge.open).toHaveBeenCalledWith(identity)
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2))
    act(() => changed())
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(3))
    view.unmount()
    expect(bridge.watch).toHaveBeenLastCalledWith(null)
  })

  it('preserves the link and shows an opening failure instead of starting another conversation', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.open).mockRejectedValue(new Error('Start the local bridge in the matching VS Code window.'))
    const detach = vi.fn()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={detach} onClose={vi.fn()} />)
    await screen.findByText('Original answer')
    await userEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('matching VS Code window')
    expect(detach).not.toHaveBeenCalled()
    expect(screen.getByText('Original answer')).toBeInTheDocument()
  })

  it('sends to the original identity with the username and actual Agent machine displayed separately', async () => {
    const { bridge } = fixture()
    const participant = { username: 'Alice', machineName: 'Machine A' }
    const execution = { agentName: 'GitHub Copilot', machineName: 'Machine B' }
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'Existing conversation', updatedAt: '' }, participant, execution, canSend: true, deliveries: [], messages: [
      { id: 'old-user', role: 'user', text: 'Previous question', status: 'complete', author: { name: 'Bob' } },
      { id: 'answer', role: 'assistant', text: 'Original answer', status: 'complete', author: { name: 'GitHub Copilot', machineName: 'Machine B' } },
    ] } satisfies VSCodeChatView)
    bridge.send = vi.fn(async (_identity, id, text): Promise<VSCodeChatDelivery> => ({ id, text, nativeSessionId: 'original', participant, execution, createdAt: new Date().toISOString(), state: 'pending' }))
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Bob')
    expect(screen.getAllByText('GitHub Copilot @ Machine B')).toHaveLength(2)
    await user.type(screen.getByRole('textbox', { name: 'Message original VS Code Agent' }), 'Continue on B')
    await user.click(screen.getByRole('button', { name: 'Send to original VS Code session' }))
    expect(bridge.send).toHaveBeenCalledWith(identity, expect.any(String), 'Continue on B')
    await screen.findByText('Delivering to the original VS Code session')
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    expect(screen.getAllByText('Alice')).toHaveLength(2)
  })

  it('retains the draft and reuses the same message ID after a lost acknowledgement', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'Original', updatedAt: '' }, messages: [], canSend: true })
    bridge.send = vi.fn().mockRejectedValue(new Error('Acknowledgement lost'))
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Original')
    await user.type(screen.getByRole('textbox'), 'Send once')
    await user.click(screen.getByRole('button', { name: 'Send to original VS Code session' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox')).toHaveValue('Send once')
    await user.click(screen.getByRole('button', { name: 'Send to original VS Code session' }))
    expect(vi.mocked(bridge.send).mock.calls[0]).toEqual(vi.mocked(bridge.send).mock.calls[1])
  })

  it('shows last-recorded user and Agent machine while offline without enabling sending', async () => {
    const { bridge } = fixture()
    const delivery: VSCodeChatDelivery = { id: crypto.randomUUID(), nativeSessionId: 'original', text: 'Earlier submission', createdAt: new Date().toISOString(), state: 'submitted', nativeRequestId: 'request-one', participant: { username: 'Alice', machineName: 'Machine A' }, execution: { agentName: 'GitHub Copilot', machineName: 'Machine B' } }
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'Original', updatedAt: '' }, messages: [], canSend: false, deliveries: [delivery] })
    bridge.send = vi.fn()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('GitHub Copilot @ Machine B (last recorded)')
    expect(screen.getByText('Alice (offline)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
  })

  it('retains optional connection controls and blocks the original Agent while it is busy', async () => {
    const { bridge, changed } = fixture()
    const session = { id: 'original', source: 'vscode' as const, title: 'Original', updatedAt: '' }
    const offline: VSCodeChatView = { session, messages: [], canSend: false, connectionState: 'offline', bridgeError: 'The source VS Code workspace is not connected.' }
    vi.mocked(bridge.read).mockResolvedValue(offline)
    bridge.connect = vi.fn(async () => {})
    bridge.send = vi.fn()
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Not connected')
    const input = screen.getByRole('textbox', { name: 'Message original VS Code Agent' })
    const send = screen.getByRole('button', { name: 'Send to original VS Code session' })
    await user.type(input, 'Keep this draft')
    expect(send).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Connect VS Code' }))
    expect(bridge.connect).toHaveBeenCalledExactlyOnceWith(identity)
    expect(bridge.send).not.toHaveBeenCalled()
    expect(input).toHaveValue('Keep this draft')
    const connected: VSCodeChatView = { session, messages: [], connectionState: 'connected', canSend: false, responding: true, participant: { username: 'Alice', machineName: 'Machine A' }, execution: { agentName: 'GitHub Copilot', machineName: 'Machine A' } }
    vi.mocked(bridge.read).mockResolvedValue(connected)
    act(() => changed())
    await screen.findByText('Agent responding')
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('The original Agent is still responding. Waiting for its saved idle state.')
    expect(screen.queryByRole('button', { name: 'Connect VS Code' })).not.toBeInTheDocument()
    vi.mocked(bridge.read).mockResolvedValue({ ...connected, responding: false, canSend: true })
    act(() => changed())
    await waitFor(() => expect(send).toBeEnabled())
    expect(input).toHaveValue('Keep this draft')
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('retains the draft after automatic preparation fails and never retries it in the background', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'Original', updatedAt: '' }, messages: [], canSend: false, connectionState: 'offline' })
    bridge.connect = vi.fn(async () => {})
    bridge.send = vi.fn().mockRejectedValue(new Error('VS Code could not open the connection request.'))
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Original')
    await user.type(screen.getByRole('textbox'), 'Unsent text')
    await user.click(screen.getByRole('button', { name: 'Send to original VS Code session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not open the connection request')
    expect(screen.getByRole('textbox')).toHaveValue('Unsent text')
    expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeEnabled()
    expect(bridge.send).toHaveBeenCalledOnce()
    expect(bridge.connect).not.toHaveBeenCalled()
  })

  it('routes remote reads and sends with the execution machine and never opens a local substitute', async () => {
    const { bridge, changed } = fixture()
    const target = { ...identity, remoteMachineName: 'Machine-B' }
    vi.mocked(bridge.read).mockRejectedValue(new Error('Import a private invitation first.'))
    bridge.connect = vi.fn(async () => {})
    const participant = { username: 'Alice', machineName: 'Machine-A' }
    const execution = { agentName: 'GitHub Copilot', machineName: 'Machine-B' }
    bridge.send = vi.fn(async (_target, id, text): Promise<VSCodeChatDelivery> => ({ id, text, nativeSessionId: identity.nativeSessionId, state: 'pending', createdAt: new Date().toISOString(), participant, execution }))
    render(<VSCodeChatPanel task={demoTasks[1]} identity={target} onDetach={vi.fn()} onClose={vi.fn()} onRemoteAccess={vi.fn()} onRemoteConnections={vi.fn()} />)
    await screen.findByRole('alert')
    expect(bridge.read).toHaveBeenCalledWith(target)
    expect(bridge.watch).toHaveBeenCalledWith(target)
    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share original conversation remotely' })).not.toBeInTheDocument()
    const calls = vi.mocked(bridge.read).mock.calls.length
    act(() => changed())
    expect(bridge.read).toHaveBeenCalledTimes(calls)
    const snapshot: VSCodeChatView = { session: { id: 'original', title: 'Original on B', source: 'vscode', updatedAt: '' }, messages: [], canSend: true, connectionState: 'connected', participant, execution }
    vi.mocked(bridge.read).mockResolvedValue(snapshot)
    await userEvent.click(screen.getByRole('button', { name: 'Connect SSH' }))
    expect(bridge.connect).toHaveBeenCalledWith(target)
    await screen.findByText('Original on B')
    await userEvent.type(screen.getByRole('textbox'), 'Continue remotely')
    await userEvent.click(screen.getByRole('button', { name: 'Send to original VS Code session' }))
    expect(bridge.send).toHaveBeenCalledWith(target, expect.any(String), 'Continue remotely')
    expect(bridge.open).not.toHaveBeenCalled()
  })
})