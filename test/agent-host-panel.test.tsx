import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostView } from '../src/shared/agentHost'
import { AgentHostPanel } from '../src/renderer/components/AgentHostPanel'
import { demoTasks } from '../src/renderer/data/tasks'

afterEach(() => { delete window.agentHost; delete window.desktop })

function fixture() {
  const target = { hostId: 'original-host-123', sessionId: 'ahp-session:/original', chatId: 'ahp-chat:/original/main', owner: { clientId: crypto.randomUUID(), machineName: 'Owner-B' } }
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = { target, state: 'connected', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Same original Host chat', modifiedAt: '', status: 1, turns: [] } }
  let watchId = ''
  const bridge: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    watch: vi.fn(async () => { watchId = crypto.randomUUID(); for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }); return watchId }),
    unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onView: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.agentHost = bridge
  return { target, bridge, view, emit: () => { for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }) } }
}

describe('Agent Host chat UI', () => {
  it('shows incremental Markdown, preserves the draft and cancels only the selected active turn', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Same original Host chat')
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Keep my next question')
    setup.view.chat!.activeTurn = { id: 'running-turn', startedAt: '', message: { text: 'Original request', origin: { kind: 'user' as NonNullable<ChatState['activeTurn']>['message']['origin']['kind'] } }, responseParts: [{ kind: 'markdown', id: 'answer', content: '**Live** response' }], usage: undefined } as ChatState['activeTurn']
    setup.view.canSend = false
    act(() => setup.emit())
    expect(await screen.findByText('Live')).toHaveProperty('tagName', 'STRONG')
    expect(screen.getByRole('textbox')).toHaveValue('Keep my next question')
    await user.click(screen.getByRole('button', { name: 'Stop Agent Host response' }))
    expect(setup.bridge.cancel).toHaveBeenCalledExactlyOnceWith(setup.target, 'running-turn')
    setup.view.readOnly = true
    act(() => setup.emit())
    expect(screen.getByRole('button', { name: 'Stop Agent Host response' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await waitFor(() => expect(setup.bridge.watch).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox')).toHaveValue('Keep my next question')
    expect(setup.bridge.send).not.toHaveBeenCalled()
    rendered.unmount()
    await waitFor(() => expect(setup.bridge.unwatch).toHaveBeenCalledTimes(2))
  })

  it('keeps images after interrupted delivery and never resends on reconnect or a late confirmation', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.send).mockRejectedValue(new Error('Delivery outcome unknown.'))
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Same original Host chat')
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], 'Screenshot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => '' } })
    await screen.findByRole('img', { name: file.name })
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery outcome unknown.')
    expect(screen.getByRole('img', { name: file.name })).toBeInTheDocument()
    const command = vi.mocked(setup.bridge.send).mock.calls[0]
    expect(command).toEqual([setup.target, expect.any(String), '', [{ id: expect.any(String), name: file.name, mimeType: file.type, data }]])
    setup.view.state = 'offline'
    setup.view.canSend = false
    setup.view.pendingTurn = { id: command[1], state: 'uncertain' }
    act(() => setup.emit())
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await waitFor(() => expect(setup.bridge.watch).toHaveBeenCalledTimes(2))
    expect(setup.bridge.send).toHaveBeenCalledOnce()
    await user.type(screen.getByRole('textbox'), 'Do not clear this later draft')
    setup.view.chat!.turns = [{ id: command[1], message: { text: '', origin: { kind: 'user' } }, responseParts: [], state: 'complete', usage: undefined }] as ChatState['turns']
    setup.view.pendingTurn = undefined
    setup.view.state = 'connected'
    setup.view.canSend = true
    act(() => setup.emit())
    await waitFor(() => expect(screen.queryByRole('button', { name: `Remove ${file.name}` })).not.toBeInTheDocument())
    expect(screen.getByRole('textbox')).toHaveValue('Do not clear this later draft')
    expect(setup.bridge.send).toHaveBeenCalledOnce()
  })

  it('renders bounded terminal output as inert text and retains exact tool status', async () => {
    const setup = fixture()
    const terminal = 'ahp-terminal:/original-terminal'
    setup.view.chat!.activeTurn = { id: 'turn', startedAt: '', message: { text: 'Run checks', origin: { kind: 'user' } }, responseParts: [{ kind: 'toolCall', toolCall: { toolCallId: 'tool', toolName: 'terminal', displayName: 'Run tests', status: 'running', content: [{ type: 'terminal', resource: terminal, title: 'Tests' }] } }], usage: undefined } as ChatState['activeTurn']
    setup.view.terminals[terminal] = { title: 'Tests', content: [{ type: 'unclassified', value: '\u001b[32mPASS\u001b[0m\n<script>not executable</script>' }], lifecycle: { status: 'running' }, claim: { kind: 'session', session: setup.target.sessionId, chat: setup.target.chatId } } as AgentHostView['terminals'][string]
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const output = await screen.findByLabelText('Tests')
    expect(output).toHaveTextContent('PASS')
    expect(output).toHaveTextContent('<script>not executable</script>')
    expect(output.textContent).not.toContain('\u001b')
    expect(rendered.container.querySelector('script')).toBeNull()
    expect(within(screen.getByRole('log')).getByText('Run tests')).toBeInTheDocument()
  })
})