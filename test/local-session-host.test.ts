import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedHistory, LocalSessionHost } from '../src/main/localSessionHost'
import type { CopilotService } from '../src/main/copilotService'
import type { ChatMessage } from '../src/shared/chat'
import type { LocalSessionSummary } from '../src/shared/sessions'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
const source: LocalSessionSummary = { id: 'vscode:known', source: 'vscode', title: 'Original session', updatedAt: '2026-09-06T00:00:00Z' }
const message: ChatMessage = { id: 'original', role: 'user', text: 'Previous local work', status: 'complete' }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'taskcontinuum-host-'))
  directories.push(directory)
  const session: LocalSessionSummary = { ...source, id: 'new-native-session', source: 'copilot' }
  const service: Pick<CopilotService, 'getStatus' | 'listSessions' | 'createSession' | 'resumeSession' | 'send' | 'abort' | 'cancelAll'> = {
    getStatus: () => ({ state: 'ready', workingDirectory: directory }),
    listSessions: vi.fn(async () => [session]),
    createSession: vi.fn(async () => ({ session, messages: [] })),
    resumeSession: vi.fn(async () => ({ session, messages: [] })),
    send: vi.fn(async () => {}),
    abort: vi.fn(async () => {}), cancelAll: vi.fn(),
  }
  const transcripts = { list: vi.fn(async () => ({ sessions: [source], warnings: [] })), read: vi.fn(async () => ({ session: source, messages: [message] })) }
  return { directory, service, transcripts, host: new LocalSessionHost(service, transcripts, directory) }
}

describe('local session import handoff', () => {
  it('requires a reviewed preview and does not call the model during import', async () => {
    const { host, service, directory } = await fixture()
    await expect(host.importSession('unreviewed', { workingDirectory: directory })).rejects.toThrow('Review')
    const preview = await host.previewImport(source.id)
    const snapshot = await host.importSession(preview.token, { workingDirectory: directory })
    expect(snapshot.session.id).toBe('new-native-session')
    expect(snapshot.importedFrom?.id).toBe(source.id)
    expect(snapshot.messages).toEqual([message])
    expect(service.send).not.toHaveBeenCalled()
    await expect(host.importSession(preview.token, { workingDirectory: directory })).rejects.toThrow('Review')
  })

  it('restores imported history after restart and sends quoted context only before the first native user turn', async () => {
    const { host, service, transcripts, directory } = await fixture()
    const preview = await host.previewImport(source.id)
    await host.importSession(preview.token, { workingDirectory: directory })
    const restarted = new LocalSessionHost(service, transcripts, directory)
    expect((await restarted.resumeSession('new-native-session')).messages).toEqual([message])
    const request = { sessionId: 'new-native-session', requestId: 'first', message: 'Continue' }
    await restarted.send(request)
    expect(service.send).toHaveBeenLastCalledWith(request, expect.stringContaining('quoted conversation history'))
    expect(vi.mocked(service.send).mock.calls[0][1]).toContain(message.text)
    vi.mocked(service.resumeSession).mockResolvedValue({ session: { ...source, source: 'copilot' }, messages: [{ ...message, text: 'Continue' }] })
    const next = { ...request, requestId: 'second', message: 'Next step' }
    await restarted.send(next)
    expect(service.send).toHaveBeenLastCalledWith(next, 'Next step')
  })

  it('uses the exact reviewed snapshot even if the source later changes', async () => {
    const { host, transcripts, directory } = await fixture()
    const preview = await host.previewImport(source.id)
    vi.mocked(transcripts.read).mockResolvedValue({ session: source, messages: [{ ...message, text: 'Unreviewed change' }] })
    const snapshot = await host.importSession(preview.token, { workingDirectory: directory })
    expect(snapshot.messages).toEqual([message])
    expect(transcripts.read).toHaveBeenCalledOnce()
  })

  it('bounds imported history and reports truncation', () => {
    const bounded = boundedHistory([{ ...message, text: 'older'.repeat(40) }, { ...message, id: 'latest', text: 'Keep this latest request' }], 100)
    expect(bounded.truncated).toBe(true)
    expect(bounded.messages.at(-1)?.text).toBe('Keep this latest request')
    expect(bounded.messages.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(100)
    expect(boundedHistory([{ ...message, text: 'A very long message' }], 3).messages[0].text).toBe('age')
  })

  it('honors stop while imported history is still loading', async () => {
    const { host, service, directory } = await fixture()
    const preview = await host.previewImport(source.id)
    await host.importSession(preview.token, { workingDirectory: directory })
    let release!: () => void
    const loaded = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(service.resumeSession).mockImplementation(async () => { await loaded; return { session: { ...source, source: 'copilot' }, messages: [] } })
    const running = host.send({ sessionId: 'new-native-session', requestId: 'cancel-loading', message: 'Continue' })
    const rejected = expect(running).rejects.toThrow()
    await host.abort('cancel-loading')
    release()
    await rejected
    expect(service.send).not.toHaveBeenCalled()
  })
})