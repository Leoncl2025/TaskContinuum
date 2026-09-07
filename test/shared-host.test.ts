import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CopilotEvent } from '../src/shared/sessions'
import type { SharedGrant, SharedSessionDescriptor } from '../src/shared/sharedSessions'
import { SharedSessionHost } from '../src/main/shared/host'
import type { SharedExecutor } from '../src/main/shared/host'
import { SharedJournal } from '../src/main/shared/journal'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

export function participant(machine: string, permissions: SharedGrant['permissions'] = ['read', 'send', 'approve', 'stop', 'checkpoint']): SharedGrant {
  return { id: `grant-${machine}`, actor: { kind: 'user', id: `user-${machine}`, name: `User ${machine}`, machineId: `machine-${machine}`, machineName: machine }, permissions, tokenHash: 'a'.repeat(64) }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'taskcontinuum-shared-'))
  directories.push(directory)
  const descriptor: SharedSessionDescriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'live', createdAt: new Date().toISOString(), owner: { machineId: 'machine-B', machineName: 'B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
  const listeners = new Set<(event: CopilotEvent) => void>()
  const emit = (event: CopilotEvent) => { for (const listener of listeners) listener(event) }
  const executor: SharedExecutor = {
    send: vi.fn(async (request) => { emit({ type: 'delta', ...request, text: 'Executed on B' }) }),
    abort: vi.fn(async () => {}), respond: vi.fn(), onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const journal = new SharedJournal(join(directory, 'events.jsonl'), descriptor)
  const host = new SharedSessionHost(descriptor, journal, executor)
  await host.start()
  return { directory, descriptor, executor, journal, host, emit }
}

describe('single-owner shared session host', () => {
  it('serializes A and C messages through B and preserves authenticated identities', async () => {
    const { host, executor, journal } = await fixture()
    await Promise.all([host.submit(participant('A'), { id: 'command-A', text: 'From A' }), host.submit(participant('C'), { id: 'command-C', text: 'From C' })])
    await host.idle()
    const events = journal.snapshot()
    expect(events.filter((event) => event.type === 'message').map((event) => event.actor.machineName)).toEqual(['A', 'C'])
    expect(events.filter((event) => event.type === 'delta').every((event) => event.actor.machineName === 'B')).toBe(true)
    expect(events.filter((event) => ['started', 'completed'].includes(event.type)).map((event) => event.type)).toEqual(['started', 'completed', 'started', 'completed'])
    expect(vi.mocked(executor.send).mock.calls.every(([request]) => request.sessionId === 'native-B')).toBe(true)
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1))
    await host.close()
  })

  it('deduplicates retries and rejects forged identity fields or unauthorized writers', async () => {
    const { host, executor } = await fixture()
    await host.submit(participant('A'), { id: 'request', text: 'Once' })
    await host.submit(participant('A'), { id: 'request', text: 'Once' })
    await expect(host.submit(participant('C'), { id: 'request', text: 'Once' })).rejects.toThrow('different message or participant')
    expect(() => host.submit(participant('C', ['read']), { id: 'read-only', text: 'No' })).toThrow('Permission denied')
    expect(() => host.submit(participant('A'), { id: 'forged', text: 'No', actor: participant('B').actor })).toThrow()
    await host.idle()
    expect(executor.send).toHaveBeenCalledOnce()
    await host.close()
  })

  it('does not abort when a subscriber disconnects and replays the missing prefix', async () => {
    const { host, journal, executor } = await fixture()
    const seen: number[] = []
    const leave = journal.subscribe((event) => seen.push(event.seq))
    await host.submit(participant('A'), { id: 'request', text: 'Run' })
    leave()
    const cursor = seen.at(-1) ?? 0
    await host.idle()
    expect(executor.abort).not.toHaveBeenCalled()
    expect(journal.snapshot(cursor).at(-1)?.type).toBe('completed')
    await host.close()
  })

  it('marks interrupted commands on restart without replaying tool work', async () => {
    const { host, directory, descriptor, executor, journal } = await fixture()
    await host.close()
    await journal.append({ type: 'message', actor: participant('A').actor, commandId: 'interrupted', text: 'Do not replay' })
    const restored = new SharedSessionHost(descriptor, new SharedJournal(join(directory, 'events.jsonl'), descriptor), executor)
    await restored.start()
    expect(restored.journal.snapshot().at(-1)?.type).toBe('interrupted')
    await restored.submit(participant('A'), { id: 'interrupted', text: 'Do not replay' })
    await restored.idle()
    expect(executor.send).not.toHaveBeenCalled()
    await restored.close()
  })

  it('validates answers before consuming an interaction and accepts only one participant decision', async () => {
    const { host, executor, emit, journal } = await fixture()
    let finish!: () => void
    vi.mocked(executor.send).mockImplementation(async (request) => {
      emit({ type: 'user-input', id: 'question', sessionId: request.sessionId, question: 'Choose one', choices: ['Unit', 'Desktop'], allowFreeform: false })
      await new Promise<void>((resolve) => { finish = resolve })
    })
    await host.submit(participant('A'), { id: 'question-command', text: 'Ask me' })
    await vi.waitFor(() => expect(journal.snapshot().some((event) => event.type === 'question')).toBe(true))
    await expect(host.respond(participant('A'), { id: 'question', answer: 'Other' })).rejects.toThrow('offered answers')
    const decisions = await Promise.allSettled([host.respond(participant('A'), { id: 'question', answer: 'Unit' }), host.respond(participant('C'), { id: 'question', answer: 'Desktop' })])
    expect(decisions.filter((decision) => decision.status === 'fulfilled')).toHaveLength(1)
    expect(executor.respond).toHaveBeenCalledOnce()
    expect(journal.snapshot().filter((event) => event.type === 'resolved')).toHaveLength(1)
    finish()
    await host.idle()
    await host.close()
  })

  it('blocks new commands while freezing a checkpoint boundary', async () => {
    const { host, journal } = await fixture()
    await host.submit(participant('A'), { id: 'complete-first', text: 'Complete' })
    await host.idle()
    let release!: () => void
    const frozen = host.freeze(async (events) => { await new Promise<void>((resolve) => { release = resolve }); return events.length })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(host.submit(participant('C'), { id: 'during-freeze', text: 'Wait' })).rejects.toThrow('checkpoint is being frozen')
    release()
    expect(await frozen).toBe(journal.lastSeq)
    await host.close()
  })

  it('records an active cancellation as interrupted with the stopping participant identity', async () => {
    const { host, executor, journal } = await fixture()
    let finish!: () => void
    vi.mocked(executor.send).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked(executor.abort).mockImplementation(async () => { finish() })
    await host.submit(participant('A'), { id: 'cancel-me', text: 'Run on B' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await host.stop(participant('C'), 'cancel-me')
    await host.idle()
    expect(journal.snapshot().at(-1)).toMatchObject({ type: 'interrupted', commandId: 'cancel-me', actor: { machineId: 'machine-C' } })
    expect(journal.snapshot().some((event) => event.type === 'completed')).toBe(false)
    await host.close()
  })
})