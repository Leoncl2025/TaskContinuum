// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryPrompt, VSCodeChatDeliveryService } from '../src/main/vscodeChatDelivery'
import type { VSCodeDispatchResult } from '../src/main/vscodeChatDelivery'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-delivery-'))
  directories.push(root)
  const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
  const directory = join(root, identity.workspaceStorageId, 'chatSessions')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'original.json')
  const previous = { requestId: 'earlier', message: 'Previous question', response: [{ value: 'Previous answer' }], result: {} }
  await writeFile(file, JSON.stringify({ requests: [previous] }))
  const participant = { username: 'Alice', machineName: 'Machine A' }
  const execution = { agentName: 'GitHub Copilot', machineName: 'Machine B' }
  return { root, identity, file, previous, participant, execution, store: new VSCodeSessionStore([root]) }
}

describe('original VS Code message delivery', () => {
  it('persists authenticated attribution before dispatch and deduplicates retries', async () => {
    const fixtureData = await fixture()
    let finish!: (value: VSCodeDispatchResult) => void
    const dispatch = vi.fn(() => new Promise<VSCodeDispatchResult>((resolve) => { finish = resolve }))
    const service = new VSCodeChatDeliveryService(fixtureData.root, fixtureData.store, fixtureData.participant, fixtureData.execution, dispatch)
    const request = { id: randomUUID(), text: 'Continue the original work' }
    const delivery = await service.submit(fixtureData.identity, request)
    expect(delivery).toMatchObject({ state: 'pending', participant: fixtureData.participant, execution: fixtureData.execution })
    expect(JSON.parse(await readFile(join(fixtureData.root, 'deliveries.json'), 'utf8'))).toEqual([delivery])
    expect(await service.submit(fixtureData.identity, request)).toEqual(delivery)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await expect(service.submit(fixtureData.identity, { ...request, text: 'Different text' })).rejects.toThrow('different submission')
    await expect(service.submit(fixtureData.identity, { id: randomUUID(), text: 'Another message' })).rejects.toThrow('Another message')
    finish({ state: 'submitted', nativeRequestId: 'new-original-request' })
    await vi.waitFor(async () => expect((await service.list(fixtureData.identity))[0]).toMatchObject({ state: 'submitted', nativeRequestId: 'new-original-request' }))
    expect(deliveryPrompt(delivery)).toContain('Message from "Alice" on "Machine A"')
    expect(deliveryPrompt({ ...delivery, text: '@reviewer Review this change' })).toMatch(/^@reviewer Review this change\n/)
    await service.close()
  })

  it('never replays a pending delivery after restart and reconciles only its exact original request', async () => {
    const fixtureData = await fixture()
    const record = { id: randomUUID(), nativeSessionId: 'original', text: 'Continue once', participant: fixtureData.participant, execution: fixtureData.execution, createdAt: new Date().toISOString(), state: 'pending' as const }
    await writeFile(join(fixtureData.root, 'deliveries.json'), JSON.stringify([record]))
    const dispatch = vi.fn()
    const service = new VSCodeChatDeliveryService(fixtureData.root, fixtureData.store, fixtureData.participant, fixtureData.execution, dispatch)
    expect((await service.list(fixtureData.identity))[0].state).toBe('uncertain')
    expect((await service.submit(fixtureData.identity, { id: record.id, text: record.text })).state).toBe('uncertain')
    expect(dispatch).not.toHaveBeenCalled()
    await writeFile(fixtureData.file, JSON.stringify({ requests: [fixtureData.previous, { requestId: 'accepted-original', message: deliveryPrompt(record) }] }))
    expect((await service.list(fixtureData.identity))[0]).toMatchObject({ state: 'submitted', nativeRequestId: 'accepted-original' })
    expect(dispatch).not.toHaveBeenCalled()
    await service.close()
  })
})