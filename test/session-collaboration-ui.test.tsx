import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ChatState, ResponsePartKind, Turn } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostView } from '../src/shared/agentHost'
import type { TaskCollaborationState } from '../src/shared/sessionCollaboration'
import { AgentHostPanel } from '../src/renderer/components/AgentHostPanel'
import { AgentHostSessionsSidebar } from '../src/renderer/components/AgentHostSessionsSidebar'
import { sessionBindingKey } from '../src/renderer/chat/sessionBindings'
import { fixtureTasks } from './task-fixture'

afterEach(() => {
  delete window.agentHost
  delete window.desktop
  delete window.remoteVSCode
})

function createPanelFixture() {
  const ownerId = crypto.randomUUID()
  const target = {
    sessionId: 'copilotcli:/release-session',
    chatId: 'ahp-chat:/release/main',
    owner: { clientId: ownerId, machineName: 'Studio-Main' },
  }
  const siblingTarget = {
    sessionId: 'copilotcli:/repair-session',
    chatId: 'ahp-chat:/repair/main',
    owner: { clientId: ownerId, machineName: 'Studio-Main' },
  }
  const remoteSender = { clientId: crypto.randomUUID(), machineName: 'Worker-B', username: 'bob' }
  const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
  const view: AgentHostView = {
    target,
    state: 'connected',
    protocolVersion: '1.0.0',
    canSend: true,
    readOnly: false,
    terminals: {},
    chat: {
      resource: target.chatId,
      title: 'Release coordination chat',
      modifiedAt: '2026-11-16T03:00:00.000Z',
      status: 1,
      turns: [],
    },
  }
  let watchId = ''
  const bridge: AgentHostBridge = {
    list: vi.fn(async () => ({ sessions: [], warnings: [] })),
    localCreationHosts: vi.fn(async () => []),
    localCreations: vi.fn(async () => []),
    createLocal: vi.fn(async () => { throw new Error('unused') }),
    localCreationStatus: vi.fn(async () => { throw new Error('unused') }),
    creationWorkers: vi.fn(async () => []),
    creations: vi.fn(async () => []),
    create: vi.fn(async () => { throw new Error('unused') }),
    creationStatus: vi.fn(async () => { throw new Error('unused') }),
    bindCreation: vi.fn(async () => { throw new Error('unused') }),
    abandonCreation: vi.fn(async () => { throw new Error('unused') }),
    models: vi.fn(async () => [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }]),
    watch: vi.fn(async () => {
      watchId = crypto.randomUUID()
      for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) })
      return watchId
    }),
    unwatch: vi.fn(async () => {}),
    loadHistory: vi.fn(async () => {}),
    terminal: vi.fn(async () => {}),
    releaseTerminal: vi.fn(async () => {}),
    onHistoryTransfer: vi.fn(() => () => {}),
    send: vi.fn(async () => {}),
    resolveDelivery: vi.fn(async () => 'not-found' as const),
    cancel: vi.fn(async () => {}),
    onView: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  window.agentHost = bridge
  return {
    target,
    siblingTarget,
    remoteSender,
    view,
    bridge,
    emit: () => {
      for (const listener of listeners) listener({ id: watchId, view: structuredClone(view) })
    },
  }
}

describe('AgentHostPanel collaboration UI adaptation', () => {
  it('distinguishes human, native agent, unlinked agent, and TC collaboration messages, jumping only to authorized linked sessions', async () => {
    const setup = createPanelFixture()
    const user = userEvent.setup()
    const onSelectLinkedSession = vi.fn()
    const siblingBinding = {
      id: setup.siblingTarget.sessionId,
      title: 'Repair Agent Session',
      owner: setup.siblingTarget.owner,
      agentHost: setup.siblingTarget,
    }
    const turns: Turn[] = [
      {
        id: 'turn-human',
        state: 'complete' as Turn['state'],
        message: { text: 'Hold release until repair finishes.', origin: { kind: MessageKind.User } },
        responseParts: [{ kind: 'markdown' as ResponsePartKind.Markdown, id: 'm-1', content: 'Waiting on repair.' }],
        usage: undefined,
      },
      {
        id: 'turn-native-linked',
        state: 'complete' as Turn['state'],
        message: {
          text: 'Fix verified on branch fix/cache.',
          origin: { kind: MessageKind.Agent },
          _meta: {
            'vscode.chat.delegation': {
              sourceSession: setup.siblingTarget.sessionId,
              sourceChat: setup.siblingTarget.chatId,
              sourceTurnId: 'src-1',
            },
          },
        },
        responseParts: [{
          kind: 'toolCall',
          toolCall: {
            toolCallId: 'tool-send-1',
            toolName: 'send_message',
            displayName: 'Send Message',
            status: 'completed',
            content: [{ type: 'text', text: JSON.stringify({ action: 'queued', messageId: 'm-1', revision: 1 }) }],
          },
        } as Turn['responseParts'][number]],
        usage: undefined,
      },
      {
        id: 'turn-native-unlinked',
        state: 'complete' as Turn['state'],
        message: {
          text: 'Ping from unlinked session.',
          origin: { kind: MessageKind.Agent },
          _meta: {
            'vscode.chat.delegation': {
              sourceSession: 'copilotcli:/unlinked-secret',
              sourceChat: 'ahp-chat:/unlinked-secret/main',
            },
          },
        },
        responseParts: [],
        usage: undefined,
      },
      {
        id: 'turn-tc-collab',
        state: 'complete' as Turn['state'],
        message: {
          text: 'Remote test suite passed on Worker-B.',
          origin: { kind: MessageKind.User },
          _meta: {
            taskcontinuumActor: setup.remoteSender,
            taskcontinuumCollaboration: {
              version: 1,
              taskId: 'T-0002',
              messageId: crypto.randomUUID(),
              senderDevice: setup.remoteSender,
              sourceKind: 'mcp-client',
            },
          },
        },
        responseParts: [],
        usage: undefined,
      },
    ]
    setup.view.chat = {
      ...setup.view.chat!,
      turns,
      queuedMessages: [{
        id: 'pending-q-1',
        message: {
          text: 'Queued follow-up verification',
          origin: { kind: MessageKind.Agent },
          _meta: { 'vscode.chat.delegation': { sourceSession: 'copilotcli:/other' } },
        },
      }],
    } as ChatState

    render(
      <AgentHostPanel
        task={fixtureTasks[1]}
        target={setup.target}
        linkedSessions={[{ taskId: 'T-0002', binding: siblingBinding, label: 'Repair Agent Session' }]}
        onSelectLinkedSession={onSelectLinkedSession}
        onDetach={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await screen.findByText('Hold release until repair finishes.')

    // 1. Human message retains standard user rendering without .message-agent-origin
    const humanCard = document.querySelector('[data-turn-id="turn-human"] .message-user')!
    expect(humanCard).not.toHaveClass('message-agent-origin')
    expect(within(humanCard as HTMLElement).getByText('User')).toBeInTheDocument()

    // 2. Linked native agent message renders .message-agent-origin and clickable jump link
    const linkedCard = document.querySelector('[data-turn-id="turn-native-linked"] .message-user')!
    expect(linkedCard).toHaveClass('message-agent-origin')
    const jumpButton = within(linkedCard as HTMLElement).getByRole('button', { name: /Sent from Repair Agent Session/ })
    await user.click(jumpButton)
    expect(onSelectLinkedSession).toHaveBeenCalledExactlyOnceWith('T-0002', siblingBinding)

    // Collaboration tool call shows concise outcome summary
    expect(screen.getByText('Queued in target session')).toBeInTheDocument()

    // 3. Unlinked native agent message shows generic non-clickable label and never auto-opens
    const unlinkedCard = document.querySelector('[data-turn-id="turn-native-unlinked"] .message-user')!
    expect(within(unlinkedCard as HTMLElement).getByText('Sent from another chat')).toBeInTheDocument()
    expect(within(unlinkedCard as HTMLElement).queryByRole('button')).not.toBeInTheDocument()

    // 4. TC Collaboration MCP message shows Agent collaboration + sender machine, not human 'bob'
    const collabCard = document.querySelector('[data-turn-id="turn-tc-collab"] .message-user')!
    expect(collabCard).toHaveClass('message-agent-origin')
    expect(within(collabCard as HTMLElement).getByText('Agent collaboration')).toBeInTheDocument()
    expect(within(collabCard as HTMLElement).getByText('Worker-B')).toBeInTheDocument()
    expect(within(collabCard as HTMLElement).getByText('Sent via Task Continuum collaboration · T-0002')).toBeInTheDocument()

    // 5. Pending queued message strip is rendered distinctly from completed turns
    const pendingRegion = screen.getByRole('region', { name: 'Pending session messages' })
    expect(within(pendingRegion).getByText('Queued for next turn')).toBeInTheDocument()
    expect(within(pendingRegion).getByText('Queued follow-up verification')).toBeInTheDocument()
  })

  it('preserves scroll position and shows a non-intrusive pill when background collaboration arrives while reading history', async () => {
    const setup = createPanelFixture()
    setup.view.chat!.turns = [{
      id: 'initial-turn',
      state: 'complete' as Turn['state'],
      message: { text: 'Initial message', origin: { kind: MessageKind.User } },
      responseParts: [],
      usage: undefined,
    }]
    render(<AgentHostPanel task={fixtureTasks[1]} target={setup.target} onDetach={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Initial message')

    const log = screen.getByRole('log')
    let scrollHeight = 2400
    Object.defineProperties(log, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    })
    await act(async () => {
      fireEvent(window, new Event('resize'))
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
    })
    log.scrollTop = 300
    fireEvent.scroll(log)
    expect(screen.queryByRole('button', { name: /New activity below/ })).not.toBeInTheDocument()

    // Background collaboration turn arrives while user is scrolled up at 300px:
    scrollHeight = 3000
    act(() => {
      setup.view.chat!.turns = [
        ...setup.view.chat!.turns,
        {
          id: 'collab-arrival',
          state: 'complete' as Turn['state'],
          message: { text: 'Background update from peer', origin: { kind: MessageKind.Agent } },
          responseParts: [],
          usage: undefined,
        },
      ]
      setup.emit()
    })
    expect(log.scrollTop).toBe(300)
    const pill = await screen.findByRole('button', { name: /New activity below/ })
    fireEvent.click(pill)
    expect(log.scrollTop).toBe(3000)
    expect(screen.queryByRole('button', { name: /New activity below/ })).not.toBeInTheDocument()
  })
})

describe('AgentHostSessionsSidebar per-task collaboration controls', () => {
  it('exposes enable, pause, resume, and quota reset controls when supported by the desktop bridge', async () => {
    const setup = createPanelFixture()
    const user = userEvent.setup()
    let state: TaskCollaborationState = {
      taskId: 'T-0002',
      enabled: false,
      paused: false,
      queuedCount: 0,
      sentCount: 0,
      maxSentMessages: 32,
    }
    setup.bridge.collaborationPolicy = vi.fn(async () => ({ ...state }))
    setup.bridge.setCollaborationPolicy = vi.fn(async (_taskId, update) => {
      state = {
        ...state,
        enabled: update.enabled ?? state.enabled,
        paused: update.enabled === false ? false : (update.paused ?? state.paused),
        sentCount: update.resetBudget ? 0 : state.sentCount,
      }
      return { ...state }
    })

    const linked = {
      id: setup.target.sessionId,
      title: 'Release coordination chat',
      owner: setup.target.owner,
      agentHost: setup.target,
    }
    render(
      <AgentHostSessionsSidebar
        taskId="T-0002"
        taskTitle="Coordinate release"
        taskReady
        bindings={{ 'T-0002': [linked] }}
        activeKey={sessionBindingKey(linked)}
        onLink={vi.fn()}
        onDevices={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const section = await screen.findByRole('region', { name: 'Task session collaboration' })
    expect(within(section).getByText('Off')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Enable collaboration' }))
    expect(within(section).getByText('Enabled · 0/32 sent')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Pause collaboration' }))
    expect(within(section).getByText('Paused')).toBeInTheDocument()

    state.sentCount = 5
    await user.click(within(section).getByRole('button', { name: 'Resume collaboration' }))
    expect(within(section).getByText('Enabled · 5/32 sent')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Reset quota' }))
    expect(within(section).getByText('Enabled · 0/32 sent')).toBeInTheDocument()
  })
})
