import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VSCodeChatPanel } from '../src/renderer/components/VSCodeChatPanel'
import { demoTasks } from '../src/renderer/data/tasks'
import type { VSCodeChatBridge, VSCodeChatDelivery, VSCodeChatIdentity, VSCodeChatView } from '../src/shared/vscodeChat'
import type { SessionSnapshot } from '../src/shared/sessions'

afterEach(() => { delete window.vscodeChat })
const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }

function fixture() {
  const listeners = new Set<(identity: VSCodeChatIdentity) => void>()
  const bridge: VSCodeChatBridge = {
    read: vi.fn(async (): Promise<SessionSnapshot> => ({ session: { id: 'original', source: 'vscode', title: 'Existing conversation', updatedAt: '2026-09-07T00:00:00Z' }, messages: [{ id: 'answer', role: 'assistant', text: 'Original answer', status: 'complete' }] })),
    open: vi.fn(async () => {}), watch: vi.fn(async () => {}),
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.vscodeChat = bridge
  return { bridge, changed: () => { for (const listener of listeners) listener(identity) } }
}

describe('original VS Code conversation panel', () => {
  it('reads and opens the exact original without exposing a substitute sender', async () => {
    const { bridge, changed } = fixture()
    const user = userEvent.setup()
    const view = render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Original answer')
    expect(bridge.read).toHaveBeenCalledWith(identity)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    expect(bridge.open).toHaveBeenCalledWith(identity)
    act(() => changed())
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2))
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

  it('connects from the desktop, preserves the draft, and enables sending only after the original Agent becomes idle', async () => {
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
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription(offline.bridgeError)
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

  it('keeps sending disabled and retains the draft after a desktop connection failure', async () => {
    const { bridge } = fixture()
    vi.mocked(bridge.read).mockResolvedValue({ session: { id: 'original', source: 'vscode', title: 'Original', updatedAt: '' }, messages: [], canSend: false, connectionState: 'offline' })
    bridge.connect = vi.fn().mockRejectedValue(new Error('VS Code could not open the connection request.'))
    bridge.send = vi.fn()
    const user = userEvent.setup()
    render(<VSCodeChatPanel task={demoTasks[1]} identity={identity} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Original')
    await user.type(screen.getByRole('textbox'), 'Unsent text')
    await user.click(screen.getByRole('button', { name: 'Connect VS Code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not open the connection request')
    expect(screen.getByRole('textbox')).toHaveValue('Unsent text')
    expect(screen.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    expect(bridge.send).not.toHaveBeenCalled()
  })
})