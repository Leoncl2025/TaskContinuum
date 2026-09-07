import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk'
import { CopilotService } from '../src/main/copilotService'
import type { CopilotRuntime, RuntimeSession } from '../src/main/copilotService'
import type { CopilotEvent } from '../src/shared/sessions'

afterEach(() => { vi.useRealTimers() })

function event(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data } as SessionEvent
}

function fixture(requestTimeout?: number) {
  const listeners = new Set<(event: SessionEvent) => void>()
  const handle: RuntimeSession = {
    sessionId: 'existing-session',
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    send: vi.fn(async () => 'message-id'), abort: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
    getEvents: vi.fn(async () => [event('user.message', { content: 'Original question' }), event('assistant.message', { messageId: 'previous', content: 'Original answer' })]),
  }
  let configuration: SessionConfig | undefined
  const client: CopilotRuntime = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, login: 'local-user' })),
    getStatus: vi.fn(async () => ({ version: 'test-runtime', protocolVersion: 1 })),
    listModels: vi.fn(async () => [{ id: 'test-model', name: 'Test model' }]),
    listSessions: vi.fn(async () => [{ sessionId: handle.sessionId, isRemote: false, summary: 'Existing work', startTime: new Date(), modifiedTime: new Date() }]),
    createSession: vi.fn(async (options) => { configuration = options; return handle }),
    resumeSession: vi.fn(async (_id, options) => { configuration = options; return handle }),
  }
  const service = new CopilotService({ createClient: () => client, requestTimeout })
  const events: CopilotEvent[] = []
  service.onEvent((value) => events.push(value))
  return { client, handle, service, events, configuration: () => configuration!, emit: (value: SessionEvent) => { for (const listener of listeners) listener(value) }, listeners }
}

describe('local Copilot session host', () => {
  it('connects once and reports actual authentication', async () => {
    const host = fixture()
    await Promise.all([host.service.connect(), host.service.connect()])
    expect(host.client.start).toHaveBeenCalledTimes(1)
    expect(host.service.getStatus()).toMatchObject({ state: 'ready', login: 'local-user', version: 'test-runtime' })
    await host.service.disconnect()
    expect(host.client.stop).toHaveBeenCalledOnce()
  })

  it('does not invent a usable session when sign-in is missing', async () => {
    const host = fixture()
    vi.mocked(host.client.getAuthStatus).mockResolvedValue({ isAuthenticated: false })
    expect((await host.service.connect()).state).toBe('auth-required')
    await expect(host.service.resumeSession('missing')).rejects.toThrow('authenticated')
    await host.service.disconnect()
  })

  it('resumes the original ID and restores its actual messages without replaying pending tools', async () => {
    const host = fixture()
    await host.service.connect()
    const snapshot = await host.service.resumeSession('existing-session')
    expect(snapshot.session.id).toBe('existing-session')
    expect(snapshot.messages.map((message) => message.text)).toEqual(['Original question', 'Original answer'])
    expect(host.client.resumeSession).toHaveBeenCalledWith('existing-session', expect.objectContaining({ continuePendingWork: false, streaming: true }))
    await expect(host.service.resumeSession('../unknown')).rejects.toThrow('not found')
    await host.service.disconnect()
  })

  it('recreates only an explicitly empty Host-owned session missing from native persistence', async () => {
    const host = fixture()
    await host.service.connect()
    vi.mocked(host.client.resumeSession).mockRejectedValue(new Error('Failed to load session events: Session not found: existing-session'))
    vi.mocked(host.handle.getEvents).mockResolvedValue([])
    const restored = await host.service.restoreOwnedSession('existing-session', { workingDirectory: tmpdir() }, true)
    expect(restored.session.id).toBe('existing-session')
    expect(host.client.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing-session', streaming: true }))
    await host.service.disconnect()
  })

  it('never recreates missing sessions with known work or on unrelated restore failures', async () => {
    const host = fixture()
    await host.service.connect()
    vi.mocked(host.client.resumeSession).mockRejectedValueOnce(new Error('Session not found: existing-session')).mockRejectedValueOnce(new Error('Permission denied'))
    await expect(host.service.restoreOwnedSession('existing-session', { workingDirectory: tmpdir() }, false)).rejects.toThrow('Session not found')
    await expect(host.service.restoreOwnedSession('existing-session', { workingDirectory: tmpdir() }, true)).rejects.toThrow('Permission denied')
    expect(host.client.createSession).not.toHaveBeenCalled()
    await host.service.disconnect()
  })

  it('streams once, rejects concurrent sends, and cleans up on idle', async () => {
    const host = fixture()
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'request-one', message: 'Continue' })
    expect(() => host.service.send({ sessionId: 'existing-session', requestId: 'request-two', message: 'Duplicate' })).toThrow('active request')
    host.emit(event('assistant.message_delta', { messageId: 'answer', deltaContent: 'Real output' }))
    host.emit(event('assistant.message', { messageId: 'answer', content: 'Real output' }))
    host.emit(event('session.idle'))
    await run
    expect(host.events.filter((value) => value.type === 'delta')).toHaveLength(1)
    expect(host.events.at(-1)).toMatchObject({ type: 'complete', requestId: 'request-one' })
    expect(host.listeners.size).toBe(0)
    await host.service.disconnect()
  })

  it('requires a one-time user decision and denies a pending permission on stop', async () => {
    const host = fixture()
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'request', message: 'Check the files' })
    const request = { kind: 'read', path: 'example.txt' } as Parameters<NonNullable<SessionConfig['onPermissionRequest']>>[0]
    const decision = host.configuration().onPermissionRequest!(request, { sessionId: 'existing-session' })
    const prompt = host.events.find((value) => value.type === 'permission')!
    expect(prompt.type).toBe('permission')
    if (prompt.type !== 'permission') throw new Error('Missing permission prompt')
    expect(() => host.service.respond(prompt.id, 'approve')).toThrow('Invalid permission')
    host.service.respond(prompt.id, true)
    await expect(decision).resolves.toEqual({ kind: 'approve-once' })
    const denied = host.configuration().onPermissionRequest!(request, { sessionId: 'existing-session' })
    await host.service.abort('request')
    await expect(denied).resolves.toMatchObject({ kind: 'reject' })
    await run
    expect(host.handle.abort).toHaveBeenCalledOnce()
    expect(host.listeners.size).toBe(0)
    await host.service.disconnect()
  })

  it('surfaces runtime errors without reporting completion', async () => {
    const host = fixture()
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'request', message: 'Continue' })
    host.emit(event('session.error', { message: 'Runtime disconnected' }))
    await expect(run).rejects.toThrow('Runtime disconnected')
    expect(host.events.at(-1)).toMatchObject({ type: 'error', error: 'Runtime disconnected' })
    expect(host.listeners.size).toBe(0)
    await host.service.disconnect()
  })

  it('keeps a long response alive while tools and assistant events make progress', async () => {
    const host = fixture(1000)
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    vi.useFakeTimers()
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'long-request', message: 'Continue' })
    await vi.advanceTimersByTimeAsync(900)
    host.emit(event('assistant.message_delta', { messageId: 'answer', deltaContent: 'Working' }))
    await vi.advanceTimersByTimeAsync(900)
    host.emit(event('tool.execution_start', { toolName: 'build', toolCallId: 'build-one' }))
    await vi.advanceTimersByTimeAsync(900)
    host.emit(event('tool.execution_complete', { toolCallId: 'build-one', success: true }))
    await vi.advanceTimersByTimeAsync(900)
    expect(host.handle.abort).not.toHaveBeenCalled()
    expect(host.events.filter((value) => value.type === 'error')).toEqual([])
    host.emit(event('session.idle'))
    await run
    expect(host.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await host.service.disconnect()
  })

  it.each(['permission', 'user-input'] as const)('pauses inactivity expiry while a %s decision is pending', async (kind) => {
    const host = fixture(1000)
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    vi.useFakeTimers()
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'decision-request', message: 'Continue' })
    await vi.advanceTimersByTimeAsync(900)
    const readRequest = { kind: 'read', path: 'example.txt' } as Parameters<NonNullable<SessionConfig['onPermissionRequest']>>[0]
    const decision = kind === 'permission'
      ? host.configuration().onPermissionRequest!(readRequest, { sessionId: 'existing-session' })
      : host.configuration().onUserInputRequest!({ question: 'Which tests?', choices: ['Unit'], allowFreeform: false }, { sessionId: 'existing-session' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.handle.abort).not.toHaveBeenCalled()
    const prompt = host.events.find((value) => value.type === kind)
    if (!prompt || !('id' in prompt)) throw new Error('Missing decision prompt')
    host.service.respond(prompt.id, kind === 'permission' ? true : 'Unit')
    await expect(decision).resolves.toMatchObject(kind === 'permission' ? { kind: 'approve-once' } : { answer: 'Unit' })
    await vi.advanceTimersByTimeAsync(900)
    expect(host.handle.abort).not.toHaveBeenCalled()
    host.emit(event('session.idle'))
    await run
    expect(vi.getTimerCount()).toBe(0)
    await host.service.disconnect()
  })

  it('still expires a truly silent request and reports an inactivity failure', async () => {
    const host = fixture(1000)
    await host.service.connect()
    await host.service.resumeSession('existing-session')
    vi.useFakeTimers()
    const run = host.service.send({ sessionId: 'existing-session', requestId: 'silent-request', message: 'Continue' })
    const rejected = expect(run).rejects.toThrow('stopped reporting progress')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(host.handle.abort).toHaveBeenCalledOnce()
    expect(host.events.at(-1)).toMatchObject({ type: 'error', requestId: 'silent-request' })
    expect(host.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await host.service.disconnect()
  })
})