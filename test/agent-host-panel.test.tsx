import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '@microsoft/agent-host-protocol'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostView } from '../src/shared/agentHost'
import { AgentHostPanel } from '../src/renderer/components/AgentHostPanel'
import { fixtureTasks as demoTasks } from './task-fixture'
import { modelConfigFixture } from './agent-host-model-fixture'

afterEach(() => { delete window.agentHost; delete window.desktop })

function fixture() {
  const target = { hostId: 'original-host-123', sessionId: 'ahp-session:/original', chatId: 'ahp-chat:/original/main', owner: { clientId: crypto.randomUUID(), machineName: 'Owner-B' } }
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = { target, state: 'connected', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Same original Host chat', modifiedAt: '', status: 1, turns: [] } }
  let watchId = ''
  const bridge: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []),
    create: vi.fn(async () => { throw new Error('The chat panel must not create a session.') }),
    creationStatus: vi.fn(async () => { throw new Error('No creation operation in the chat panel.') }),
    bindCreation: vi.fn(async () => { throw new Error('No creation operation in the chat panel.') }),
    models: vi.fn(async () => [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }]),
    watch: vi.fn(async () => { watchId = crypto.randomUUID(); for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }); return watchId }),
    unwatch: vi.fn(async () => {}), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    onView: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.agentHost = bridge
  return { target, bridge, view, emit: () => { for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }) } }
}

describe('Agent Host chat UI', () => {
  it('renders Host config options, preserves typed values on reconnect, and sends them explicitly', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), 'gpt-6')
    expect(screen.getByRole('combobox', { name: 'Thinking Level' })).toHaveDisplayValue('Default (Medium)')
    expect(screen.getByRole('combobox', { name: 'Context Size' })).toHaveDisplayValue('Default (272K)')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Context Size' }), screen.getByRole('option', { name: '872K' }))
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await screen.findByRole('combobox', { name: 'Thinking Level' })
    expect(screen.getByRole('combobox', { name: 'Thinking Level' })).toHaveDisplayValue('Max')
    await user.type(screen.getByRole('textbox'), 'Use model config')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), 'Use model config', undefined, { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000 } })
  })

  it('clears config on model change and restores Host defaults without copying native config', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }, { id: 'other', name: 'Other model', provider: 'copilotcli' }])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    const picker = screen.getByRole('combobox', { name: 'Agent Host model' })
    await user.selectOptions(picker, 'gpt-6')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    await user.selectOptions(picker, 'other')
    expect(screen.queryByRole('combobox', { name: 'Thinking Level' })).not.toBeInTheDocument()
    await user.selectOptions(picker, 'gpt-6')
    expect(screen.getByRole('combobox', { name: 'Thinking Level' })).toHaveDisplayValue('Default (Medium)')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Context Size' }), screen.getByRole('option', { name: '872K' }))
    await user.click(screen.getByRole('button', { name: 'Reset model options to defaults' }))
    await user.type(screen.getByRole('textbox'), 'Use defaults')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), 'Use defaults', undefined, { id: 'gpt-6' })
  })

  it('blocks a config value invalidated by a catalog refresh until the user resets it', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), 'gpt-6')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: { type: 'object', properties: { thinkingLevel: { type: 'string', title: 'Thinking Level', enum: ['low'], default: 'low' } } } }])
    await user.click(screen.getByRole('button', { name: 'Retry loading models' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported value')
    await user.type(screen.getByRole('textbox'), 'Do not silently change config')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reset model options to defaults' }))
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('requires an explicit model and keeps it across native updates and reconnects', async () => {
    const setup = fixture()
    setup.view.chat!.draft = { text: '', origin: { kind: MessageKind.User }, model: { id: 'owner-model' } }
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.getByRole('combobox').closest('form')).toBe(screen.getByRole('textbox').closest('form'))
    expect(screen.getByText('Choose a model below to enable sending.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), 'Use the selected model')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), 'gpt-6')
    act(() => setup.emit())
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await waitFor(() => expect(setup.bridge.models).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled())
    expect(screen.getByRole('combobox')).toHaveValue('gpt-6')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), 'Use the selected model', undefined, { id: 'gpt-6' })
  })

  it('surfaces catalog failures and refuses to use a historical model', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockRejectedValue(new Error('Update the owner device.'))
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Update the owner device.')
    await user.type(screen.getByRole('textbox'), 'No silent fallback')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('recovers model loading beside the composer without losing or automatically sending the draft', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockRejectedValueOnce(new Error('The owner model catalog is unavailable.'))
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert.closest('form')).toBe(screen.getByRole('textbox').closest('form'))
    expect(screen.getByRole('option', { name: 'Models unavailable' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), 'Keep the draft while retrying')
    await user.click(screen.getByRole('button', { name: 'Retry loading models' }))
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Keep the draft while retrying')
    expect(setup.bridge.send).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByRole('combobox'), 'gpt-6')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), 'Keep the draft while retrying', undefined, { id: 'gpt-6' })
  })

  it('blocks a selection removed from the catalog instead of switching to another model', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    await user.selectOptions(screen.getByRole('combobox'), 'gpt-6')
    await user.type(screen.getByRole('textbox'), 'Keep this unsent prompt')
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await screen.findByRole('option', { name: 'Owner model' })
    expect(screen.getByRole('combobox')).toHaveValue('gpt-6')
    expect(screen.getByRole('option', { name: 'gpt-6 (unavailable)' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(screen.getByRole('textbox')).toHaveValue('Keep this unsent prompt')
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), await screen.findByRole('option', { name: 'GPT-6' }))
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], 'Screenshot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => '' } })
    await screen.findByRole('img', { name: file.name })
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Delivery outcome unknown.')
    expect(screen.getByRole('img', { name: file.name })).toBeInTheDocument()
    const command = vi.mocked(setup.bridge.send).mock.calls[0]
    expect(command).toEqual([setup.target, expect.any(String), '', [{ id: expect.any(String), name: file.name, mimeType: file.type, data }], { id: 'gpt-6' }])
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