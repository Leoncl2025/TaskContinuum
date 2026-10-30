import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Activity, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, McpAuthRequiredReason, MessageResourceAttachment, ResponsePart, ResponsePartKind, ToolCallCancellationReason, ToolCallCompletedState, ToolCallConfirmationReason, ToolCallContributorKind, ToolCallResponsePart, ToolCallStatus, ToolResultContentType, TurnState } from '@microsoft/agent-host-protocol'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostView } from '../src/shared/agentHost'
import { AgentHostPanel } from '../src/renderer/components/AgentHostPanel'
import { readModelPreference, saveModelPreference } from '../src/renderer/chat/modelPreferences'
import { fixtureTasks as demoTasks } from './task-fixture'
import { modelConfigFixture } from './agent-host-model-fixture'
import { MachineAliasesProvider } from '../src/renderer/MachineAliasesProvider'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { delete window.agentHost; delete window.desktop; delete window.remoteVSCode })

function fixture() {
  const target = { sessionId: 'ahp-session:/original', chatId: 'ahp-chat:/original/main', owner: { clientId: crypto.randomUUID(), machineName: 'Owner-B' } }
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = { target, state: 'connected', protocolVersion: '0.9.0', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Same original Host chat', modifiedAt: '', status: 1, turns: [] } }
  let watchId = ''
  const bridge: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    localCreationHosts: vi.fn(async () => []), localCreations: vi.fn(async () => []),
    createLocal: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    localCreationStatus: vi.fn(async () => { throw new Error('No local creation in this fixture.') }),
    creationWorkers: vi.fn(async () => []), creations: vi.fn(async () => []),
    create: vi.fn(async () => { throw new Error('The chat panel must not create a session.') }),
    creationStatus: vi.fn(async () => { throw new Error('No creation operation in the chat panel.') }),
    bindCreation: vi.fn(async () => { throw new Error('No creation operation in the chat panel.') }),
    abandonCreation: vi.fn(async () => { throw new Error('No creation operation in the chat panel.') }),
    models: vi.fn(async () => [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }]),
    watch: vi.fn(async () => { watchId = crypto.randomUUID(); for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }); return watchId }),
    unwatch: vi.fn(async () => {}), terminal: vi.fn(async () => {}), releaseTerminal: vi.fn(async () => {}),
    send: vi.fn(async () => {}), resolveDelivery: vi.fn(async () => 'not-found' as const), cancel: vi.fn(async () => {}),
    onView: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.agentHost = bridge
  return { target, bridge, view, emit: () => { for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) }) } }
}

it('keeps following after resize-induced scrolling, but preserves deliberate history browsing and cancels pending resize work', async () => {
  const setup = fixture()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  const flush = () => act(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
  const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
  await screen.findByRole('status', { name: 'Connected' })
  const log = screen.getByRole('log')
  let width = 600, height = 500, scrollHeight = 2000
  Object.defineProperties(log, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, get: () => scrollHeight },
  })
  flush()
  log.scrollTop = scrollHeight - height
  fireEvent.scroll(log)
  width = 800
  height = 650
  scrollHeight = 3000
  fireEvent.scroll(log)
  const requested = requestFrame.mock.calls.length
  fireEvent(window, new Event('resize'))
  fireEvent(window, new Event('resize'))
  expect(requestFrame).toHaveBeenCalledTimes(requested + 1)
  flush()
  expect(log.scrollTop).toBe(scrollHeight)
  log.scrollTop = 400
  fireEvent.scroll(log)
  width = 500
  height = 400
  scrollHeight = 4000
  fireEvent(window, new Event('resize'))
  fireEvent.scroll(log)
  flush()
  expect(log.scrollTop).toBe(400)
  act(() => setup.emit())
  expect(log.scrollTop).toBe(400)
  log.scrollTop = scrollHeight - height
  fireEvent.scroll(log)
  scrollHeight = 4200
  act(() => setup.emit())
  expect(log.scrollTop).toBe(scrollHeight)
  fireEvent(window, new Event('resize'))
  const pendingFrame = nextFrame
  rendered.unmount()
  expect(cancelFrame).toHaveBeenCalledWith(pendingFrame)
  expect(frames.size).toBe(0)
  const calls = requestFrame.mock.calls.length
  fireEvent(window, new Event('resize'))
  expect(requestFrame).toHaveBeenCalledTimes(calls)
  expect(setup.bridge.watch).toHaveBeenCalledOnce()
  expect(setup.bridge.send).not.toHaveBeenCalled()
})

function historicalOutput(view: AgentHostView, resource: string, duplicate = false): void {
  const content = { type: 'terminal', resource, title: 'Historical output', result: { preview: 'Preview before loading' } }
  view.chat!.turns = [{
    id: 'previous-turn', state: 'complete', message: { text: 'Prior request', origin: { kind: 'user' } },
    responseParts: [{ kind: 'toolCall', toolCall: { toolCallId: 'previous-tool', toolName: 'terminal', displayName: 'Previous command',
      status: 'completed', content: duplicate ? [content, content] : [content] } }], usage: undefined,
  }] as ChatState['turns']
}

function completedTool(id: string, name = 'Read'): { kind: ResponsePartKind.ToolCall; toolCall: ToolCallCompletedState } {
  return { kind: 'toolCall' as ResponsePartKind.ToolCall, toolCall: {
    toolCallId: id, toolName: name, displayName: name, status: 'completed' as ToolCallStatus.Completed,
    confirmed: 'not-needed' as ToolCallConfirmationReason.NotNeeded, invocationMessage: `Inspect ${id}`,
    success: true, pastTenseMessage: `Inspected ${id}`, content: [{ type: 'text' as ToolResultContentType.Text, text: `Output for ${id}` }],
  } }
}

function runningTool(id: string): ToolCallResponsePart {
  return { kind: 'toolCall' as ResponsePartKind.ToolCall, toolCall: {
    toolCallId: id, toolName: 'shell', displayName: 'Run checks', status: 'running' as ToolCallStatus.Running,
    confirmed: 'not-needed' as ToolCallConfirmationReason.NotNeeded, invocationMessage: 'Run targeted tests',
  } }
}

function responseHistory(view: AgentHostView, parts: ResponsePart[]): void {
  view.chat!.turns = [{
    id: 'activity-turn', state: 'complete' as TurnState.Complete, message: { text: 'Review the workspace', origin: { kind: MessageKind.User } },
    responseParts: parts, usage: undefined,
  }]
}

describe('Compact chat activity', () => {
  it('collapses a long tool burst to one row while keeping reasoning and the answer readable', async () => {
    const setup = fixture()
    const tools = Array.from({ length: 40 }, (_, index) => completedTool(`read-${index}`))
    responseHistory(setup.view, [
      { kind: 'reasoning' as ResponsePartKind.Reasoning, id: 'reasoning', content: 'Inspection reasoning' },
      { kind: 'markdown' as ResponsePartKind.Markdown, id: 'intro', content: 'I will inspect the relevant files.' },
      ...tools,
      { kind: 'markdown' as ResponsePartKind.Markdown, id: 'answer', content: '## Result\n\nThe answer stays in the conversation.' },
    ])
    const user = userEvent.setup()
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const summary = await screen.findByLabelText('40 tool calls, completed')
    const group = summary.closest('details')!
    expect(group).not.toHaveAttribute('open')
    expect(summary).toHaveTextContent('Read (40)')
    expect(screen.getByText('I will inspect the relevant files.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Result' })).toBeVisible()
    expect(screen.getByText('Inspection reasoning')).not.toBeVisible()
    expect(rendered.container.querySelectorAll('.ahp-tool-entry')).toHaveLength(0)
    expect(setup.bridge.terminal).not.toHaveBeenCalled()
    await user.click(summary)
    expect(group).toHaveAttribute('open')
    expect(rendered.container.querySelectorAll('.ahp-tool-entry')).toHaveLength(40)
    expect(screen.queryByText('Output for read-0')).not.toBeInTheDocument()
    await user.click(within(group).getAllByText('Read', { exact: true })[0])
    expect(screen.getByText('Output for read-0')).toBeVisible()
    await user.click(summary)
    expect(rendered.container.querySelectorAll('.ahp-tool-entry')).toHaveLength(0)
    expect(screen.getByText('The answer stays in the conversation.')).toBeVisible()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('does not group across text, reasoning, system notifications or input requests', async () => {
    const setup = fixture()
    responseHistory(setup.view, [
      completedTool('first'), completedTool('second'),
      { kind: 'markdown' as ResponsePartKind.Markdown, id: 'update', content: 'Found the relevant implementation.' },
      completedTool('third', 'Search'), completedTool('fourth', 'Search'),
      { kind: 'systemNotification' as ResponsePartKind.SystemNotification, content: 'Owner notification' },
      { kind: 'inputRequest' as ResponsePartKind.InputRequest, request: { id: 'question', message: 'Choose the deployment target.' } },
      { kind: 'reasoning' as ResponsePartKind.Reasoning, id: 'next-reasoning', content: 'Further reasoning' },
      { kind: 'error' as ResponsePartKind.Error, error: { errorType: 'test-error', message: 'The turn could not continue.' } },
      { kind: 'markdown' as ResponsePartKind.Markdown, id: 'answer', content: 'Final recommendation.' },
    ])
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Final recommendation.')
    const body = rendered.container.querySelector('.message-assistant')!
    expect([...body.children].map((element) => element.textContent)).toEqual([
      'Copilot @ Owner-B', '2 tool callsRead (2)', 'Found the relevant implementation.',
      '2 tool callsSearch (2)', 'Owner notification',
      'Input required on Owner-BChoose the deployment target.', 'ReasoningFurther reasoning',
      'The turn could not continue.', 'Final recommendation.',
    ])
    expect(screen.getByText('Choose the deployment target.')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('The turn could not continue.')
  })

  const attentionTools: [string, ToolCallResponsePart['toolCall'], string][] = [
    ['failure', { ...completedTool('attention', 'Run checks').toolCall, success: false, error: { message: 'Tests failed.' } }, 'Tests failed.'],
    ['failure without details', { ...completedTool('attention', 'Run checks').toolCall, success: false }, 'The tool reported a failure. Review its output for details.'],
    ['error despite success flag', { ...completedTool('attention', 'Run checks').toolCall, error: { message: 'Owner reported an error.' } }, 'Owner reported an error.'],
    ['approval', { toolCallId: 'attention', toolName: 'shell', displayName: 'Run checks', status: 'pending-confirmation' as ToolCallStatus.PendingConfirmation, invocationMessage: 'Run the checks' }, 'Awaiting confirmation on Owner-B'],
    ['result approval', { ...completedTool('attention', 'Run checks').toolCall, status: 'pending-result-confirmation' as ToolCallStatus.PendingResultConfirmation }, 'Awaiting confirmation on Owner-B'],
    ['authentication', {
      toolCallId: 'attention', toolName: 'shell', displayName: 'Run checks', status: 'auth-required' as ToolCallStatus.AuthRequired,
      confirmed: 'not-needed' as ToolCallConfirmationReason.NotNeeded, invocationMessage: 'Run the checks',
      contributor: { kind: 'mcp' as ToolCallContributorKind.MCP, customizationId: 'test-service' },
      auth: { reason: 'insufficient-scope' as McpAuthRequiredReason.InsufficientScope, resource: { resource: 'https://example.invalid', authorization_servers: ['https://example.invalid'] } },
    }, 'Authentication required on Owner-B'],
    ['cancellation', { toolCallId: 'attention', toolName: 'shell', displayName: 'Run checks', status: 'cancelled' as ToolCallStatus.Cancelled, invocationMessage: 'Run the checks', reason: 'denied' as ToolCallCancellationReason.Denied, reasonMessage: 'The owner declined this command.' }, 'The owner declined this command.'],
  ]
  it.each(attentionTools)('keeps %s outside collapsed groups, with its notice visible even when details close', async (_name, toolCall, notice) => {
    const setup = fixture()
    responseHistory(setup.view, [
      completedTool('first'), completedTool('second'),
      { kind: 'toolCall' as ResponsePartKind.ToolCall, toolCall },
      completedTool('third'), completedTool('fourth'),
    ])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const title = await screen.findByText('Run checks', { exact: true })
    expect(screen.getAllByLabelText('2 tool calls, completed')).toHaveLength(2)
    expect(title.closest('.ahp-activity')).toBeNull()
    expect(screen.getByText(notice)).toBeVisible()
    await user.click(title)
    expect(screen.getByText(notice)).toBeVisible()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('updates live group summaries without overriding the user expansion choice', async () => {
    const setup = fixture()
    setup.view.chat!.activeTurn = {
      id: 'live', startedAt: '', message: { text: 'Review', origin: { kind: MessageKind.User } },
      responseParts: [completedTool('first'), runningTool('running')], usage: undefined,
    }
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const summary = await screen.findByLabelText('2 tool calls, 1 running')
    expect(summary).toHaveTextContent('Running: Run targeted tests')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    await user.click(summary)
    await user.click(screen.getByText('Read', { exact: true }))
    expect(screen.getByText('Output for first')).toBeVisible()
    act(() => {
      setup.view.chat!.activeTurn!.responseParts.push(completedTool('third', 'Search'))
      setup.emit()
    })
    expect(screen.getByLabelText('3 tool calls, 1 running').closest('details')).toHaveAttribute('open')
    expect(screen.getByText('Output for first')).toBeVisible()
    await user.click(summary)
    act(() => {
      setup.view.chat!.activeTurn!.responseParts[1] = completedTool('running', 'Run checks')
      setup.emit()
    })
    expect(screen.getByLabelText('3 tool calls, completed').closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByText('Output for first')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Agent Host response' })).toBeEnabled()
  })

  it('surfaces a running tool failure immediately even if its group is collapsed', async () => {
    const setup = fixture()
    responseHistory(setup.view, [completedTool('first'), runningTool('second')])
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByLabelText('2 tool calls, 1 running')
    const failed = completedTool('second', 'Run checks')
    failed.toolCall.success = false
    failed.toolCall.error = { message: 'Permission was revoked.' }
    act(() => {
      setup.view.chat!.turns[0].responseParts[1] = failed
      setup.emit()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Permission was revoked.')
    expect(screen.getByText('Run checks', { exact: true }).closest('details')).toHaveAttribute('open')
    expect(screen.queryByLabelText('2 tool calls, 1 running')).not.toBeInTheDocument()
  })

  it('loads grouped terminal output only after both disclosures open and releases it when the group closes', async () => {
    const setup = fixture()
    const command = completedTool('command', 'Run checks')
    const resource = 'ahp-terminal:/grouped-command'
    command.toolCall.content = [{ type: 'terminal' as ToolResultContentType.Terminal, resource, title: 'Grouped output', result: { preview: 'Command preview' } }]
    responseHistory(setup.view, [completedTool('first'), command])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const summary = await screen.findByLabelText('2 tool calls, completed')
    expect(setup.bridge.terminal).not.toHaveBeenCalled()
    await user.click(summary)
    expect(setup.bridge.terminal).not.toHaveBeenCalled()
    await user.click(screen.getByText('Run checks', { exact: true }))
    await waitFor(() => expect(setup.bridge.terminal).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('Grouped output on Owner-B')).toHaveTextContent('Command preview')
    await user.click(summary)
    await waitFor(() => expect(setup.bridge.releaseTerminal).toHaveBeenCalledExactlyOnceWith(expect.any(String), resource, vi.mocked(setup.bridge.terminal).mock.calls[0][2]))
    act(() => setup.emit())
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    await user.click(summary)
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    expect(screen.queryByLabelText('Grouped output on Owner-B')).not.toBeInTheDocument()
  })
})

describe('Agent Host chat UI', () => {
  it('pastes and sends exactly 12,000 characters without truncation', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agent Host model' }), await screen.findByRole('option', { name: 'GPT-6' }))
    const input = screen.getByRole('textbox', { name: 'Message Agent Host' })
    expect(input).toHaveAttribute('maxlength', '12000')
    const text = '\u4e2d'.repeat(12000)
    await user.click(input)
    await user.paste(text)
    expect(input).toHaveValue(text)
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), text, undefined, { id: 'gpt-6' })
    expect(setup.bridge.create).not.toHaveBeenCalled()
  })

  it('focuses only the activated composer, retaining its caret without stealing streaming or dialog focus', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    const props = { task: demoTasks[1], target: setup.target, onDetach: vi.fn(), onClose: vi.fn() }
    const panel = (active: boolean, modal = false) => <>
      <input aria-label="Outside search" />
      {modal && <dialog open aria-label="Blocking dialog"><input aria-label="Dialog input" /></dialog>}
      <AgentHostPanel {...props} active={active} />
    </>
    const mounted = render(panel(false))
    const search = screen.getByRole('textbox', { name: 'Outside search' })
    search.focus()
    await screen.findByRole('status', { name: 'Connected' })
    expect(search).toHaveFocus()
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message Agent Host' })
    mounted.rerender(panel(true))
    expect(composer).toHaveFocus()
    await user.keyboard('Keep this draft')
    composer.setSelectionRange(5, 5)
    search.focus()
    act(() => setup.emit())
    expect(search).toHaveFocus()
    mounted.rerender(panel(false))
    mounted.rerender(panel(true))
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue('Keep this draft')
    expect(composer.selectionStart).toBe(5)
    expect(composer.selectionEnd).toBe(5)

    mounted.rerender(panel(false, true))
    const dialogInput = screen.getByRole('textbox', { name: 'Dialog input' })
    dialogInput.focus()
    mounted.rerender(panel(true, true))
    expect(dialogInput).toHaveFocus()
    act(() => setup.emit())
    expect(dialogInput).toHaveFocus()
    mounted.rerender(panel(true))
    search.focus()
    act(() => setup.emit())
    expect(search).toHaveFocus()
    expect(setup.bridge.send).not.toHaveBeenCalled()
    expect(setup.bridge.create).not.toHaveBeenCalled()
    expect(setup.bridge.watch).toHaveBeenCalledOnce()
  })

  it('shows a resource-backed screenshot from the Host instead of silently dropping it', async () => {
    const setup = fixture()
    setup.view.chat!.turns = [{
      id: 'sent-screenshot', state: 'complete' as TurnState.Complete,
      message: { text: 'Can you see this screenshot?', origin: { kind: MessageKind.User }, attachments: [{
        type: 'resource' as MessageResourceAttachment['type'], displayKind: 'image', label: 'Screenshot.png',
        uri: 'file:///C:/Users/owner/AppData/Roaming/Code/agentSessionData/original/attachments/Screenshot.png',
      }], _meta: { taskcontinuumActor: { clientId: 'sender', machineName: 'Sending-computer' } } },
      responseParts: [], usage: undefined,
    }]
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Can you see this screenshot?')
    const cards = within(screen.getByRole('log')).queryAllByRole('link', { name: 'Preview Screenshot.png' })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveAttribute('href', setup.view.chat!.turns[0].message.attachments![0].type === 'resource'
      ? setup.view.chat!.turns[0].message.attachments![0].uri : '')
    expect(setup.bridge.send).not.toHaveBeenCalled()
    expect(setup.bridge.create).not.toHaveBeenCalled()
  })

  it.each(['0.9.0', '0.10.0', '1.0.0', undefined] as const)('shows the actual negotiated protocol in chat details (%s)', async (version) => {
    const setup = fixture()
    setup.view.protocolVersion = version
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Connected', { exact: true })
    await user.click(screen.getByRole('button', { name: 'Chat details' }))
    expect(within(screen.getByRole('dialog', { name: 'Chat details' })).getByText(version ? `AHP ${version}` : 'Not negotiated')).toBeInTheDocument()
    expect(setup.bridge.create).not.toHaveBeenCalled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('moves only the active header into its titlebar slot without restarting the conversation', async () => {
    const setup = fixture()
    const onDevices = vi.fn()
    const user = userEvent.setup()
    function DockedPanel({ active }: { active: boolean }) {
      const [slot, setSlot] = useState<HTMLDivElement | null>(null)
      return <>
        <div ref={setSlot} aria-label="Titlebar slot" />
        <AgentHostPanel task={demoTasks[1]} target={setup.target} headerTarget={slot} active={active}
          onDevices={onDevices} onDetach={vi.fn()} onClose={vi.fn()} />
      </>
    }
    const mounted = render(<DockedPanel active />)
    const slot = screen.getByLabelText('Titlebar slot')
    await within(slot).findByText('Connected')
    const panel = screen.getByRole('complementary', { name: 'Agent Host task chat' })
    expect(within(panel).queryByLabelText('Chat header')).not.toBeInTheDocument()
    await user.type(within(panel).getByRole('textbox'), 'Keep my draft')
    await user.click(within(slot).getByRole('button', { name: 'Chat details' }))
    const details = screen.getByRole('dialog', { name: 'Chat details' })
    expect(within(details).getByText(setup.target.sessionId)).toBeInTheDocument()
    await user.click(within(details).getByRole('button', { name: 'Manage devices' }))
    expect(onDevices).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    mounted.rerender(<DockedPanel active={false} />)
    expect(within(slot).queryByLabelText('Chat header')).not.toBeInTheDocument()
    mounted.rerender(<DockedPanel active />)
    expect(within(slot).getAllByLabelText('Chat header')).toHaveLength(1)
    expect(within(panel).getByRole('textbox')).toHaveValue('Keep my draft')
    expect(setup.bridge.watch).toHaveBeenCalledOnce()
    expect(setup.bridge.models).toHaveBeenCalledOnce()
    expect(setup.bridge.unwatch).not.toHaveBeenCalled()
    expect(setup.bridge.create).not.toHaveBeenCalled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('keeps a compact header and exposes full identities without reconnecting or losing the draft', async () => {
    const setup = fixture()
    const onDevices = vi.fn()
    const onDetach = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDevices={onDevices} onDetach={onDetach} onClose={onClose} />)
    const header = screen.getByLabelText('Chat header')
    expect(await within(header).findByText('Same original Host chat')).toHaveAttribute('title', 'Same original Host chat')
    expect(within(header).getByRole('status')).toHaveTextContent('Connected')
    expect(within(header).getByText('Copilot @ Owner-B')).toBeInTheDocument()
    expect(screen.queryByText(setup.target.sessionId, { exact: true })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Keep this draft')
    const trigger = within(header).getByRole('button', { name: 'Chat details' })
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const details = screen.getByRole('dialog', { name: 'Chat details' })
    for (const value of [setup.target.sessionId, setup.target.chatId, setup.target.owner.clientId, demoTasks[1].id, 'AHP 0.9.0']) {
      expect(within(details).getByText(value, { exact: true })).toBeInTheDocument()
    }
    fireEvent(details, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Chat details' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep this draft')
    expect(setup.bridge.watch).toHaveBeenCalledOnce()
    expect(setup.bridge.send).not.toHaveBeenCalled()
    await user.click(within(header).getByRole('button', { name: 'Manage devices' }))
    await user.click(within(header).getByRole('button', { name: 'Detach conversation' }))
    await user.click(within(header).getByRole('button', { name: 'Hide chat panel' }))
    expect(onDevices).toHaveBeenCalledOnce()
    expect(onDetach).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps offline and read-only states visible without opening details', async () => {
    const setup = fixture()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const header = screen.getByLabelText('Chat header')
    await within(header).findByText('Connected')
    setup.view.state = 'offline'
    setup.view.readOnly = true
    setup.view.canSend = false
    act(() => setup.emit())
    expect(within(header).getByRole('status')).toHaveTextContent('Offline history')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    setup.view.state = 'connected'
    act(() => setup.emit())
    expect(within(header).getByRole('status')).toHaveTextContent('Read only')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes details when a panel becomes inactive or changes conversation', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    const props = { task: demoTasks[1], target: setup.target, onDetach: vi.fn(), onClose: vi.fn() }
    const panel = render(<AgentHostPanel {...props} />)
    await user.click(screen.getByRole('button', { name: 'Chat details' }))
    expect(screen.getByRole('dialog', { name: 'Chat details' })).toBeInTheDocument()
    panel.rerender(<AgentHostPanel {...props} active={false} />)
    expect(screen.queryByRole('dialog', { name: 'Chat details' })).not.toBeInTheDocument()
    panel.rerender(<AgentHostPanel {...props} target={{ ...setup.target, chatId: 'ahp-chat:/other' }} />)
    expect(screen.queryByRole('dialog', { name: 'Chat details' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat details' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('exposes workspace context without task-only header actions', async () => {
    const setup = fixture()
    const user = userEvent.setup()
    render(<AgentHostPanel workspace={{ id: 'workspace', name: 'Planning workspace' }} target={setup.target} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Chat details' }))
    const details = screen.getByRole('dialog', { name: 'Chat details' })
    expect(within(details).getByText('Workspace', { exact: true })).toBeInTheDocument()
    expect(within(details).getByText('Planning workspace')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Detach conversation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide chat panel' })).not.toBeInTheDocument()
    await user.click(within(details).getByRole('button', { name: 'Close Chat details' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('settles an in-flight send while a different session is visible without replaying it', async () => {
    const { target, bridge } = fixture()
    let complete!: () => void
    vi.mocked(bridge.send).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
    const user = userEvent.setup()
    const panel = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><AgentHostPanel task={demoTasks[1]} target={target} active={visible} onClose={vi.fn()} onDetach={vi.fn()} /></Activity>
    const view = render(panel(true))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agent Host model' }), await screen.findByRole('option', { name: 'GPT-6' }))
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Sent before switching')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    await waitFor(() => expect(bridge.send).toHaveBeenCalledOnce())
    view.rerender(panel(false))
    await act(async () => complete())
    view.rerender(panel(true))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue(''))
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Next draft')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled())
    expect(bridge.send).toHaveBeenCalledOnce()
    expect(bridge.cancel).not.toHaveBeenCalled()
  })

  it('updates aliases during streaming without restarting watches or changing drafts, models, or protocol targets', async () => {
    const setup = fixture()
    const git = gitSyncUiFixture()
    window.remoteVSCode = git.remote
    const senderId = crypto.randomUUID()
    git.setStatus({ ...git.getStatus(), machineAliases: { [setup.target.owner.clientId]: 'Office' } })
    const user = userEvent.setup()
    render(<MachineAliasesProvider workspaceId="workspace"><AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} /></MachineAliasesProvider>)
    await screen.findByText('Copilot @ Office (Owner-B)')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), await screen.findByRole('option', { name: 'GPT-6' }))
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Keep my next question')
    const terminal = 'ahp-terminal:/streaming'
    setup.view.chat!.activeTurn = {
      id: 'streaming-turn', startedAt: '', message: { text: 'Original request', origin: { kind: 'user' }, _meta: { taskcontinuumActor: { clientId: senderId, username: 'Alice', machineName: 'Sender-A' } } },
      responseParts: [
        { kind: 'markdown', id: 'stream', content: 'Streaming answer' },
        { kind: 'toolCall', toolCall: { toolCallId: 'terminal-tool', toolName: 'terminal', displayName: 'Live checks', status: 'running', content: [{ type: 'terminal', resource: terminal, title: 'Checks', result: { preview: 'Still running' } }] } },
      ], usage: undefined,
    } as ChatState['activeTurn']
    act(() => setup.emit())
    expect(await screen.findByLabelText('Checks on Office (Owner-B)')).toHaveTextContent('Still running')
    await waitFor(() => expect(setup.bridge.terminal).toHaveBeenCalledOnce())
    const terminalRequest = vi.mocked(setup.bridge.terminal).mock.calls[0]
    git.setStatus({ ...git.getStatus(), machineAliases: { [setup.target.owner.clientId]: 'Build station', [senderId]: 'Portable' } })
    await act(async () => git.notify())
    expect(screen.getAllByText('Copilot @ Build station (Owner-B)')).toHaveLength(2)
    expect(screen.getByLabelText('Checks on Build station (Owner-B)')).toHaveTextContent('Still running')
    expect(within(screen.getByRole('log')).getByText('Portable (Sender-A)')).toBeInTheDocument()
    expect(screen.getByText('Streaming answer')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Keep my next question')
    expect(screen.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('gpt-6')
    expect(readModelPreference(setup.target.owner.clientId, 'copilotcli')).toEqual({ model: { id: 'gpt-6' } })
    expect(setup.bridge.watch).toHaveBeenCalledExactlyOnceWith(setup.target)
    expect(setup.bridge.models).toHaveBeenCalledExactlyOnceWith(setup.target)
    expect(setup.bridge.unwatch).not.toHaveBeenCalled()
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    expect(setup.bridge.releaseTerminal).not.toHaveBeenCalled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Stop Agent Host response' }))
    expect(setup.bridge.cancel).toHaveBeenCalledExactlyOnceWith(setup.target, 'streaming-turn')
    git.setStatus({ ...git.getStatus(), machineAliases: {} })
    await act(async () => git.notify())
    expect(screen.getAllByText('Copilot @ Owner-B')).toHaveLength(2)
    expect(screen.getByLabelText('Checks on Owner-B')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Keep my next question')
    expect(setup.bridge.watch).toHaveBeenCalledOnce()
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    expect(setup.bridge.releaseTerminal).not.toHaveBeenCalled()
    await user.click(screen.getByText('Live checks'))
    await waitFor(() => expect(setup.bridge.releaseTerminal).toHaveBeenCalledExactlyOnceWith(...terminalRequest))
    setup.view.chat!.activeTurn = undefined
    act(() => setup.emit())
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(setup.target, expect.any(String), 'Keep my next question', undefined, { id: 'gpt-6' })
    expect(setup.target.owner.machineName).toBe('Owner-B')
    expect(setup.bridge.create).not.toHaveBeenCalled()
    expect(setup.bridge.createLocal).not.toHaveBeenCalled()
  })

  it('remembers the explicit model and options when reopening another task chat on the same owner', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }])
    const user = userEvent.setup()
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), await screen.findByRole('option', { name: 'GPT-6' }))
    expect(screen.queryByRole('combobox', { name: 'Thinking Level' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Model options' })).toHaveTextContent('Medium · 272K')
    await user.click(screen.getByRole('button', { name: 'Model options' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Context Size' }), screen.getByRole('option', { name: '872K' }))
    rendered.unmount()
    const target = { ...setup.target, sessionId: 'ahp-session:/another', chatId: 'ahp-chat:/another/main' }
    setup.view.target = target
    setup.view.chat!.resource = target.chatId
    render(<AgentHostPanel task={demoTasks[2]} target={target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Model options' }))
    await screen.findByRole('combobox', { name: 'Thinking Level' })
    expect(screen.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('gpt-6')
    expect(screen.getByRole('combobox', { name: 'Thinking Level' })).toHaveDisplayValue('Max')
    expect(screen.getByRole('combobox', { name: 'Context Size' })).toHaveDisplayValue('872K')
    expect(screen.queryByText('Choose a model below to enable sending.')).not.toBeInTheDocument()
    expect(setup.bridge.send).not.toHaveBeenCalled()
    expect(setup.bridge.create).not.toHaveBeenCalled()
    expect(setup.bridge.createLocal).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox'), 'Use the remembered choice')
    await user.click(screen.getByRole('button', { name: 'Send to Agent Host' }))
    expect(setup.bridge.send).toHaveBeenCalledExactlyOnceWith(target, expect.any(String), 'Use the remembered choice', undefined, { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000 } })
  })

  it.each(['owner', 'provider'])('does not borrow another %s preference, even for the same model ID', async (scope) => {
    const setup = fixture()
    saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'gpt-6' })
    if (scope === 'owner') setup.target.owner.clientId = crypto.randomUUID()
    else vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'another-provider' }])
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('')
    expect(screen.getByText('Choose a model below to enable sending.')).toBeInTheDocument()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('keeps an unavailable saved model until it returns instead of falling back or auto-sending', async () => {
    const setup = fixture()
    saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'saved-model' })
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'saved-model (unavailable)' })
    expect(screen.getByRole('combobox')).toHaveValue('saved-model')
    await user.type(screen.getByRole('textbox'), 'Wait for my model')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'saved-model', name: 'Saved model', provider: 'copilotcli' }])
    await user.click(screen.getByRole('button', { name: 'Retry loading models' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveValue('Wait for my model')
    expect(readModelPreference(setup.target.owner.clientId, 'copilotcli')).toEqual({ model: { id: 'saved-model' } })
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('validates restored options against the current schema and remembers an explicit reset', async () => {
    const setup = fixture()
    saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'gpt-6', config: { thinkingLevel: 'max' } })
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: {
      type: 'object', properties: { thinkingLevel: { type: 'string', title: 'Thinking Level', enum: ['low'], default: 'low' } },
    } }])
    const user = userEvent.setup()
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported value')
    await user.type(screen.getByRole('textbox'), 'Keep this draft')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Model options' }))
    await user.click(screen.getByRole('button', { name: 'Reset model options to defaults' }))
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled()
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
    rendered.unmount()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Model options' }))
    expect(await screen.findByRole('combobox', { name: 'Thinking Level' })).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('gpt-6')
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('clears a remembered choice explicitly and does not restore it on reconnect or reopen', async () => {
    const setup = fixture()
    saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'gpt-6' })
    const user = userEvent.setup()
    const rendered = render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), '')
    expect(readModelPreference(setup.target.owner.clientId, 'copilotcli')).toEqual({})
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.getByRole('combobox')).toHaveValue('')
    rendered.unmount()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('reports invalid saved data and replaces it only after an explicit choice', async () => {
    const setup = fixture()
    const stored = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{')
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('saved model preference is invalid')
    expect(screen.getByRole('combobox')).toHaveValue('')
    stored.mockRestore()
    await user.selectOptions(screen.getByRole('combobox'), 'gpt-6')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readModelPreference(setup.target.owner.clientId, 'copilotcli')).toEqual({ model: { id: 'gpt-6' } })
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('reports a save failure while allowing the current explicit selection and a later retry', async () => {
    const setup = fixture()
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox'), await screen.findByRole('option', { name: 'GPT-6' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(screen.getByRole('combobox')).toHaveValue('gpt-6')
    await user.type(screen.getByRole('textbox'), 'Only send when I ask')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled()
    save.mockRestore()
    await user.selectOptions(screen.getByRole('combobox'), 'gpt-6')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readModelPreference(setup.target.owner.clientId, 'copilotcli')).toEqual({ model: { id: 'gpt-6' } })
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('renders Host config options, preserves typed values on reconnect, and sends them explicitly', async () => {
    const setup = fixture()
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }])
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'GPT-6' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), 'gpt-6')
    await user.click(screen.getByRole('button', { name: 'Model options' }))
    expect(screen.getByRole('combobox', { name: 'Thinking Level' })).toHaveDisplayValue('Default (Medium)')
    expect(screen.getByRole('combobox', { name: 'Context Size' })).toHaveDisplayValue('Default (272K)')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Context Size' }), screen.getByRole('option', { name: '872K' }))
    await user.click(screen.getByRole('button', { name: 'Reconnect Agent Host' }))
    await user.click(await screen.findByRole('button', { name: 'Model options' }))
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
    await user.click(screen.getByRole('button', { name: 'Model options' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    await user.selectOptions(picker, 'other')
    expect(screen.queryByRole('combobox', { name: 'Thinking Level' })).not.toBeInTheDocument()
    await user.selectOptions(picker, 'gpt-6')
    await user.click(screen.getByRole('button', { name: 'Model options' }))
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
    await user.click(screen.getByRole('button', { name: 'Model options' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Thinking Level' }), screen.getByRole('option', { name: 'Max' }))
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: { type: 'object', properties: { thinkingLevel: { type: 'string', title: 'Thinking Level', enum: ['low'], default: 'low' } } } }])
    await user.click(screen.getByRole('button', { name: 'Retry loading models' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported value')
    await user.type(screen.getByRole('textbox'), 'Do not silently change config')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Model options' }))
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
    saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'changed-in-another-chat' })
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

  it.each([false, true])('recovers model loading without losing or auto-sending the draft (saved choice: %s)', async (remembered) => {
    const setup = fixture()
    if (remembered) saveModelPreference(setup.target.owner.clientId, 'copilotcli', { id: 'gpt-6' })
    vi.mocked(setup.bridge.models).mockRejectedValue(new Error('The owner model catalog is unavailable.'))
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const alert = await screen.findByRole('alert')
    expect(alert.closest('form')).toBe(screen.getByRole('textbox').closest('form'))
    expect(screen.getByRole('option', { name: 'Models unavailable' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), 'Keep the draft while retrying')
    vi.mocked(setup.bridge.models).mockResolvedValue([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }])
    await user.click(screen.getByRole('button', { name: 'Retry loading models' }))
    await screen.findByRole('option', { name: 'GPT-6' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Keep the draft while retrying')
    expect(setup.bridge.send).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toHaveValue(remembered ? 'gpt-6' : '')
    if (!remembered) await user.selectOptions(screen.getByRole('combobox'), 'gpt-6')
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
    const output = await screen.findByLabelText('Tests on Owner-B')
    expect(output).toHaveTextContent('PASS')
    expect(output).toHaveTextContent('<script>not executable</script>')
    expect(output.textContent).not.toContain('\u001b')
    expect(rendered.container.querySelector('script')).toBeNull()
    expect(within(screen.getByRole('log')).getByText('Run tests')).toBeInTheDocument()
  })

  it('loads historical output only when expanded, deduplicates repeated resources and releases on collapse', async () => {
    const setup = fixture()
    const resource = 'ahp-terminal:/previous-command'
    historicalOutput(setup.view, resource, true)
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Previous command')
    expect(setup.bridge.terminal).not.toHaveBeenCalled()
    await user.click(screen.getByText('Previous command'))
    await waitFor(() => expect(setup.bridge.terminal).toHaveBeenCalledOnce())
    expect(setup.bridge.terminal).toHaveBeenCalledWith(expect.any(String), resource, expect.any(String))
    setup.view.terminals[resource] = { title: 'Historical output', content: [{ type: 'unclassified', value: 'Full output <script>inert</script>' }],
      lifecycle: { status: 'exited' }, claim: { kind: 'session', session: setup.target.sessionId, chat: setup.target.chatId } } as AgentHostView['terminals'][string]
    act(() => setup.emit())
    await waitFor(() => expect(screen.getAllByLabelText('Historical output on Owner-B')).toHaveLength(2))
    expect(screen.getAllByLabelText('Historical output on Owner-B')[0]).toHaveTextContent('Full output <script>inert</script>')
    expect(document.querySelector('script')).toBeNull()
    await user.click(screen.getByText('Previous command'))
    await waitFor(() => expect(setup.bridge.releaseTerminal).toHaveBeenCalledOnce())
    expect(setup.bridge.releaseTerminal).toHaveBeenCalledWith(expect.any(String), resource, vi.mocked(setup.bridge.terminal).mock.calls[0][2])
  })

  it('shows the preview and a failed state until the user explicitly retries the terminal', async () => {
    const setup = fixture()
    const resource = 'ahp-terminal:/failed-command'
    historicalOutput(setup.view, resource)
    vi.mocked(setup.bridge.terminal).mockRejectedValueOnce(new Error('The owner Host could not load this terminal output. Retry manually.'))
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByText('Previous command'))
    await screen.findByRole('alert', { name: '' })
    expect(screen.getByLabelText('Historical output on Owner-B')).toHaveTextContent('Preview before loading')
    expect(screen.getByText('Preview only - full terminal output has not loaded.')).toBeInTheDocument()
    act(() => { setup.emit(); setup.emit() })
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Retry terminal output' }))
    await waitFor(() => expect(setup.bridge.terminal).toHaveBeenCalledTimes(2))
    expect(setup.bridge.terminal).toHaveBeenLastCalledWith(expect.any(String), resource, vi.mocked(setup.bridge.terminal).mock.calls[0][2], true)
    setup.view.terminals[resource] = { title: 'Historical output', content: [{ type: 'unclassified', value: 'Loaded on retry' }],
      lifecycle: { status: 'exited' }, claim: { kind: 'session', session: setup.target.sessionId, chat: setup.target.chatId } } as AgentHostView['terminals'][string]
    act(() => setup.emit())
    await waitFor(() => expect(screen.getByLabelText('Historical output on Owner-B')).toHaveTextContent('Loaded on retry'))
    expect(screen.queryByText('Preview only - full terminal output has not loaded.')).not.toBeInTheDocument()
  })

  it('does not automatically retry historical output after reconnect', async () => {
    const setup = fixture()
    const resource = 'ahp-terminal:/reconnect-command'
    historicalOutput(setup.view, resource)
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.click(await screen.findByText('Previous command'))
    await waitFor(() => expect(setup.bridge.terminal).toHaveBeenCalledOnce())
    setup.view.terminals[resource] = { title: 'Historical output', content: [{ type: 'unclassified', value: 'Old output' }],
      lifecycle: { status: 'exited' }, claim: { kind: 'session', session: setup.target.sessionId, chat: setup.target.chatId } } as AgentHostView['terminals'][string]
    act(() => setup.emit())
    act(() => {
      setup.view.state = 'offline'
      setup.view.terminals = {}
      setup.emit()
    })
    act(() => { setup.view.state = 'connected'; setup.emit() })
    expect(setup.bridge.terminal).toHaveBeenCalledOnce()
    await screen.findByText('Terminal output was not restored after reconnect.')
    await user.click(screen.getByRole('button', { name: 'Retry terminal output' }))
    expect(setup.bridge.terminal).toHaveBeenLastCalledWith(expect.any(String), resource, expect.any(String), true)
  })

  it('keeps an uncertain draft blocked until an explicit original-chat review and acknowledgement', async () => {
    const setup = fixture()
    const turnId = crypto.randomUUID()
    setup.view.pendingTurn = { id: turnId, state: 'uncertain' }
    setup.view.canSend = false
    vi.mocked(setup.bridge.resolveDelivery).mockImplementation(async (_target, _id, action) => action === 'abandon' ? 'abandoned' : 'not-found')
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('combobox', { name: 'Agent Host model' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Message Agent Host' }), 'Keep this new draft')
    expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Abandon this attempt and unlock sending' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check original chat for this turn' }))
    await waitFor(() => expect(setup.bridge.resolveDelivery).toHaveBeenCalledExactlyOnceWith(setup.target, turnId, 'check', undefined))
    expect(await screen.findByText(/This turn is not in the current Host snapshot/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abandon this attempt and unlock sending' })).toBeDisabled()
    expect(setup.bridge.send).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /I checked the original chat/ }))
    await user.click(screen.getByRole('button', { name: 'Abandon this attempt and unlock sending' }))
    await waitFor(() => expect(setup.bridge.resolveDelivery).toHaveBeenLastCalledWith(setup.target, turnId, 'abandon', true))
    expect(screen.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep this new draft')
    expect(setup.bridge.send).not.toHaveBeenCalled()
    act(() => { setup.view.pendingTurn = undefined; setup.view.canSend = true; setup.emit() })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent Host model' }), screen.getByRole('option', { name: 'GPT-6' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled())
  })

  it('does not offer abandonment after a failed review, or while the original Host is offline', async () => {
    const setup = fixture()
    setup.view.pendingTurn = { id: crypto.randomUUID(), state: 'uncertain' }
    setup.view.canSend = false
    setup.view.state = 'offline'
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    const check = screen.getByRole('button', { name: 'Check original chat for this turn' })
    expect(check).toBeDisabled()
    expect(setup.bridge.resolveDelivery).not.toHaveBeenCalled()
    act(() => { setup.view.state = 'connected'; setup.emit() })
    vi.mocked(setup.bridge.resolveDelivery).mockRejectedValueOnce(new Error('The original Host is unavailable.'))
    await user.click(check)
    await screen.findByRole('alert', { name: '' })
    expect(screen.getByText('The original Host is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abandon this attempt and unlock sending' })).not.toBeInTheDocument()
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })

  it('automatically clears the warning after verifying that the original chat contains the turn', async () => {
    const setup = fixture()
    setup.view.pendingTurn = { id: crypto.randomUUID(), state: 'uncertain' }
    setup.view.canSend = false
    vi.mocked(setup.bridge.resolveDelivery).mockResolvedValueOnce('confirmed')
    const user = userEvent.setup()
    render(<AgentHostPanel task={demoTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Check original chat for this turn' }))
    await waitFor(() => expect(setup.bridge.resolveDelivery).toHaveBeenCalledOnce())
    expect(screen.queryByRole('checkbox', { name: /I checked the original chat/ })).not.toBeInTheDocument()
    act(() => { setup.view.pendingTurn = undefined; setup.view.canSend = true; setup.emit() })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Resolve uncertain delivery' })).not.toBeInTheDocument())
    expect(setup.bridge.send).not.toHaveBeenCalled()
  })
})