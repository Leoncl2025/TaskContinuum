// @vitest-environment node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedEnrollment, SharedGrant, SharedSessionDescriptor } from '../src/shared/sharedSessions'
import { SharedSessionHost } from '../src/main/shared/host'
import type { SharedExecutor } from '../src/main/shared/host'
import { SharedJournal } from '../src/main/shared/journal'
import { startSharedServer } from '../src/main/shared/server'
import { SharedSessionClient } from '../src/main/shared/client'
import { sshArguments } from '../src/main/shared/ssh'
import type { CopilotEvent } from '../src/shared/sessions'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'taskcontinuum-transport-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const session: SharedSessionDescriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'live', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'Machine B', agentId: 'agent-B', nativeSessionId: 'session-B', epoch: 1 } }
  const token = randomBytes(32).toString('base64url')
  const grant: SharedGrant = { id: 'grant-A', actor: { kind: 'user', id: 'user-A', name: 'Alice', machineId: 'A', machineName: 'Machine A' }, permissions: ['read', 'send', 'approve', 'stop', 'checkpoint'], tokenHash: createHash('sha256').update(token).digest('hex') }
  const listeners = new Set<(event: CopilotEvent) => void>()
  const executor: SharedExecutor = { send: vi.fn(async (request) => { for (const listener of listeners) listener({ ...request, type: 'delta', text: 'Agent on B' }) }), abort: vi.fn(async () => {}), respond: vi.fn(), onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const host = new SharedSessionHost(session, new SharedJournal(join(directory, 'host.jsonl'), session), executor)
  await host.start()
  cleanup.push(() => host.close())
  const server = await startSharedServer({ host, getGrants: async () => [grant] })
  let stopped = false
  const stopServer = async () => { if (!stopped) { stopped = true; await server.close() } }
  cleanup.push(stopServer)
  const enrollment: SharedEnrollment = { schemaVersion: 1, session, actor: grant.actor, permissions: grant.permissions, token, endpoint: { kind: 'local', port: server.port } }
  const client = new SharedSessionClient(enrollment, join(directory, 'client.jsonl'))
  cleanup.push(() => client.disconnect())
  return { directory, host, executor, server, stopServer, enrollment, client }
}

describe('authenticated live and cached transport', () => {
  it('streams from B, replays after disconnect, and retains a cache while B is offline', async () => {
    const { host, client, enrollment, directory, stopServer, executor } = await fixture()
    expect((await client.connect()).online).toBe(true)
    await client.command('command-one', 'Hello from A')
    await host.idle()
    await vi.waitFor(() => expect(client.view.events.at(-1)?.type).toBe('completed'))
    expect(client.view.events.find((event) => event.type === 'message')?.actor.machineId).toBe('A')
    expect(client.view.events.find((event) => event.type === 'delta')?.actor.machineId).toBe('B')
    await client.disconnect()
    expect(executor.abort).not.toHaveBeenCalled()
    const restored = await client.connect()
    expect(restored.events.at(-1)?.type).toBe('completed')
    expect(restored.online).toBe(true)
    await client.command('command-two', 'Continue')
    await host.idle()
    await vi.waitFor(() => expect(client.view.events.filter((event) => event.type === 'completed')).toHaveLength(2))
    await client.disconnect()
    await stopServer()
    expect((await client.connect()).online).toBe(false)
    expect(client.view.events.some((event) => event.text === 'Agent on B')).toBe(true)
    const newClient = new SharedSessionClient(enrollment, join(directory, 'new-C-cache.jsonl'))
    cleanup.push(() => newClient.disconnect())
    expect((await newClient.connect()).events).toEqual([])
    await expect(client.command('offline', 'Do not send')).rejects.toThrow('offline')
  })

  it('requires a valid enrollment credential and blocks browser origins', async () => {
    const { server, enrollment } = await fixture()
    expect((await fetch(`http://127.0.0.1:${server.port}/session`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${server.port}/session`, { headers: { Authorization: `Bearer ${enrollment.token}`, Origin: 'https://example.com' } })).status).toBe(403)
    const forged = await fetch(`http://127.0.0.1:${server.port}/commands`, { method: 'POST', headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'forged', text: 'hello', machineId: 'B' }) })
    expect(forged.status).toBe(400)
  })

  it('builds restricted non-interactive SSH arguments and rejects argument injection', () => {
    const args = sshArguments('approved-host', 7350, 7340)
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('127.0.0.1:7350:127.0.0.1:7340')
    expect(args.slice(-2)).toEqual(['--', 'approved-host'])
    expect(() => sshArguments('-oProxyCommand=bad', 7350, 7340)).toThrow()
    expect(() => sshArguments('host;bad', 7350, 7340)).toThrow()
  })
})