// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ChatToolCallCompleteAction, SessionActiveClientSetAction } from '@microsoft/agent-host-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { canonicalPolicyRoot } from '../src/main/linkedSessionPolicy'
import { TaskContinuumAgentHostTools } from '../src/main/taskContinuumAgentHostTools'
import type { SessionCollaborationApi } from '../src/shared/sessionCollaboration'
import { startAgentHostFixture } from './agent-host-fixture'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup({ protocolVersion = '1.0.0', native = true } = {}) {
  const directory = resolve('.runtime', `native-tools-${randomUUID()}`)
  const workspace = join(directory, 'workspace')
  const otherWorkspace = join(directory, 'other')
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(otherWorkspace, { recursive: true })])
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = await startAgentHostFixture(undefined, protocolVersion)
  cleanup.push(() => host.close())
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Local' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal), native)
  cleanup.push(() => connection.close())
  const listSessions = vi.fn<SessionCollaborationApi['listSessions']>().mockResolvedValue({
    collaboration: { queuedCount: 0 }, sessions: [],
  })
  const api = vi.fn(() => ({
    collaboration: { listSessions, readContext: vi.fn(), sendMessage: vi.fn(), messageStatus: vi.fn() },
  }))
  const tools = new TaskContinuumAgentHostTools(api)
  const authorize = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const attach = (root = workspace) => {
    const detach = tools.attach(root, connection, authorize)
    cleanup.push(detach)
    return detach
  }
  const registrations = () => (host.dispatches as SessionActiveClientSetAction[]).filter((action) => action.type === 'session/activeClientSet')
  const removals = () => host.dispatchChannels.filter(({ type }) => type === 'session/activeClientRemoved')
  const completions = () => (host.dispatches as ChatToolCallCompleteAction[]).filter((action) => action.type === 'chat/toolCallComplete')
  const start = (actor?: { clientId: string }, turnId = randomUUID()) => {
    host.action({
      type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
      message: { text: 'List my linked sessions', origin: { kind: 'user' }, ...(actor ? { _meta: { taskcontinuumActor: actor } } : {}) },
    })
    return turnId
  }
  const request = (turnId: string, override: {
    chat?: string; clientId?: string; contributorClientId?: string; toolCallId?: string;
    toolInput?: string; kind?: 'toolConfirmation'; toolName?: string
  } = {}) => {
    const clientId = override.clientId ?? registrations().at(-1)?.activeClient.clientId
    const id = override.toolCallId ?? randomUUID()
    return {
      type: 'session/inputNeededSet',
      request: {
        kind: override.kind ?? 'toolClientExecution', id, turnId, clientId, chat: override.chat ?? host.chatId,
        toolCall: {
          status: override.kind ? 'pending-confirmation' : 'running', toolCallId: id,
          toolName: override.toolName ?? 'taskcontinuum_collaboration_list_sessions',
          toolInput: override.toolInput ?? JSON.stringify({ query: 'Builder' }),
          contributor: { kind: 'client', clientId: override.contributorClientId ?? clientId },
        },
      },
    }
  }
  return { workspace, otherWorkspace, host, target, connection, authorize, attach, listSessions, api, registrations, removals, completions, start, request }
}

describe('TaskContinuum native Agent Host tools', () => {
  it('joins a watched session once and completes only live calls addressed to its own client', async () => {
    const f = await setup()
    const detach = f.attach()
    const detachOtherView = f.attach()
    await f.connection.open()
    await vi.waitFor(() => expect(f.registrations()).toHaveLength(1))
    expect(f.registrations()[0].activeClient).toMatchObject({
      displayName: 'TaskContinuum',
      tools: [
        { name: 'taskcontinuum_collaboration_list_sessions' },
        { name: 'taskcontinuum_collaboration_read_context' },
        { name: 'taskcontinuum_collaboration_send_message', annotations: { readOnlyHint: false } },
        { name: 'taskcontinuum_collaboration_message_status' },
      ],
    })
    detach()
    const turnId = f.start()
    f.host.sessionAction(f.request(turnId, { kind: 'toolConfirmation' }))
    f.host.sessionAction(f.request(turnId, { contributorClientId: 'another-client' }))
    const call = f.request(turnId)
    f.host.sessionAction(call)
    f.host.sessionAction(call)
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(f.listSessions).toHaveBeenCalledExactlyOnceWith({ query: 'Builder' })
    expect(f.api).toHaveBeenCalledExactlyOnceWith(await canonicalPolicyRoot(f.workspace), f.target, expect.any(Function))
    expect(f.completions()[0]).toMatchObject({
      turnId, toolCallId: call.request.toolCall.toolCallId,
      result: { success: true, structuredContent: { result: { sessions: [] } } },
    })
    expect(f.removals()).toHaveLength(0)
    detachOtherView()
    await vi.waitFor(() => expect(f.removals()).toHaveLength(1))
  })

  it('fails closed for unlinked sibling chats, other workspaces, remote turns and caller-supplied scope', async () => {
    const f = await setup()
    f.attach()
    await f.connection.open()
    await vi.waitFor(() => expect(f.registrations()).toHaveLength(1))
    const turnId = f.start()
    f.host.sessionAction(f.request(turnId, { chat: 'ahp-chat:/private-other' }))
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(f.host.dispatchChannels.at(-1)).toEqual({ type: 'chat/toolCallComplete', channel: 'ahp-chat:/private-other' })
    expect(f.completions()[0].result).toMatchObject({ success: false, error: { code: 'ACCESS_DENIED' } })
    f.host.sessionAction(f.request(turnId, { toolInput: JSON.stringify({ workspace: f.otherWorkspace }) }))
    await vi.waitFor(() => expect(f.completions()).toHaveLength(2))
    expect(f.completions()[1].result).toMatchObject({ success: false, error: { code: 'INVALID_REQUEST' } })
    const detachAmbiguous = f.attach(f.otherWorkspace)
    f.host.sessionAction(f.request(turnId))
    await vi.waitFor(() => expect(f.completions()).toHaveLength(3))
    expect(f.completions()[2].result).toMatchObject({ success: false, error: { code: 'ACCESS_DENIED' } })
    detachAmbiguous()
    f.host.action({ type: 'chat/turnComplete', turnId, duration: 1 })
    const remoteTurn = f.start({ clientId: randomUUID() })
    f.host.sessionAction(f.request(remoteTurn))
    await vi.waitFor(() => expect(f.completions()).toHaveLength(4))
    expect(f.completions()[3].result).toMatchObject({ success: false, error: { code: 'UNAVAILABLE', message: expect.stringContaining('No live TaskContinuum connection') } })
    expect(f.listSessions).not.toHaveBeenCalled()
  })

  it('does not disclose results after revoke and re-registers on transport replacement without carrying over old calls', async () => {
    const f = await setup()
    f.attach()
    let finish!: (result: Awaited<ReturnType<SessionCollaborationApi['listSessions']>>) => void
    f.listSessions.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await f.connection.open()
    await vi.waitFor(() => expect(f.registrations()).toHaveLength(1))
    const turnId = f.start()
    const stale = f.request(turnId)
    f.host.sessionAction(stale)
    await vi.waitFor(() => expect(f.listSessions).toHaveBeenCalledTimes(1))
    f.authorize.mockRejectedValue(new Error('Revoked'))
    finish({ collaboration: { queuedCount: 0 }, sessions: [] })
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1))
    expect(f.completions()[0].result).toMatchObject({ success: false, structuredContent: { error: { code: 'ACCESS_DENIED' } } })
    expect(f.completions()[0].result.structuredContent).not.toHaveProperty('result')
    f.host.drop()
    await vi.waitFor(() => expect(f.connection.state).toBe('offline'))
    f.authorize.mockResolvedValue(undefined)
    await f.connection.open()
    await vi.waitFor(() => expect(f.registrations()).toHaveLength(2))
    expect(f.registrations()[1].activeClient.clientId).not.toBe(f.registrations()[0].activeClient.clientId)
    f.host.sessionAction(stale)
    f.host.sessionAction(f.request(turnId))
    await vi.waitFor(() => expect(f.completions()).toHaveLength(2))
    expect(f.listSessions).toHaveBeenCalledTimes(2)
    expect(f.completions()[1].result.success).toBe(true)
  })

  it.each([{ native: false }, { protocolVersion: '0.9.0' }])('keeps chat available without registering through %o', async (options) => {
    const f = await setup(options)
    f.attach()
    await f.connection.open()
    expect(f.connection.state).toBe('connected')
    expect(f.registrations()).toHaveLength(0)
  })
})
