// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-model-cache-'))
  const host = await startAgentHostFixture()
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Host-B' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  cleanup.push(async () => { await connection.close(); await host.close(); await rm(directory, { recursive: true, force: true }) })
  const complete = async (id: string) => {
    host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
    await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
  }
  const send = (id = randomUUID()) => connection.send(id, 'Use my selected model', undefined, async () => {}, undefined, { id: 'gpt-6' })
  return { host, target, connection, send, complete }
}

describe('connection-scoped model catalog for sending', () => {
  it('does not query models when sending after the picker has loaded, even if catalog queries stop working', async () => {
    const f = await fixture()
    await f.connection.models()
    expect(f.host.modelQueries()).toBe(1)
    f.host.failModels(true)
    for (let index = 0; index < 2; index++) {
      const id = randomUUID()
      await f.send(id)
      await f.complete(id)
    }
    expect(f.host.modelQueries()).toBe(1)
    expect(f.host.dispatches).toHaveLength(2)
  })

  it('loads a catalog once if no picker has loaded it yet', async () => {
    const f = await fixture()
    const first = randomUUID()
    await f.send(first)
    expect(f.host.modelQueries()).toBe(1)
    await f.complete(first)
    await f.send()
    expect(f.host.modelQueries()).toBe(1)
    expect(f.host.dispatches).toHaveLength(2)
  })

  it('refreshes explicitly and blocks a model removed by that refresh without querying on send', async () => {
    const f = await fixture()
    const models = await f.connection.models()
    models.length = 0
    const first = randomUUID()
    await f.send(first)
    await f.complete(first)
    f.host.setModels([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
    expect(await f.connection.models()).toEqual([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
    await expect(f.send()).rejects.toThrow('no longer available')
    expect(f.host.modelQueries()).toBe(2)
    expect(f.host.dispatches).toHaveLength(1)
  })

  it('does not fall back to an old catalog or automatically query again after an explicit refresh fails', async () => {
    const f = await fixture()
    await f.connection.models()
    f.host.failModels(true)
    await expect(f.connection.models()).rejects.toThrow('catalog failure')
    await expect(f.send()).rejects.toThrow('Retry loading models')
    expect(f.host.modelQueries()).toBe(2)
    expect(f.host.dispatches).toHaveLength(0)
    f.host.failModels(false)
    await f.connection.models()
    await f.send()
    expect(f.host.modelQueries()).toBe(3)
  })

  it('shares concurrent picker and first-send catalog requests', async () => {
    const f = await fixture()
    await f.connection.open()
    const release = f.host.holdModels()
    const first = f.connection.models()
    const second = f.connection.models()
    const sending = f.send()
    const all = Promise.all([first, second, sending])
    try {
      await expect.poll(() => f.host.modelQueries()).toBe(1)
      release()
      const [one, two] = await all
      expect(one).toEqual(two)
      expect(f.host.modelQueries()).toBe(1)
      expect(f.host.dispatches).toHaveLength(1)
    } finally { release(); await all }
  })

  it('invalidates the old connection catalog on reconnect and ignores an interrupted refresh', async () => {
    const f = await fixture()
    await f.connection.models()
    const release = f.host.holdModels()
    const pending = f.connection.models().then(() => undefined, (error: unknown) => error)
    try {
      await expect.poll(() => f.host.modelQueries()).toBe(2)
      f.host.drop()
      expect(await pending).toBeInstanceOf(Error)
      await expect.poll(() => f.connection.view.state).toBe('offline')
      release()
      f.host.setModels([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
      await f.connection.open()
      await expect(f.send()).rejects.toThrow('no longer available')
      expect(f.host.modelQueries()).toBe(3)
      expect(f.host.dispatches).toHaveLength(0)
    } finally { release(); await pending }
  })

  it('revalidates refreshed configuration before dispatch without issuing an extra query', async () => {
    const f = await fixture()
    await f.connection.models()
    let checks = 0
    await expect(f.connection.send(randomUUID(), 'Preserve validation', undefined, async () => {
      if (++checks === 2) {
        f.host.setModels([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: {
          type: 'object', properties: { thinkingLevel: { type: 'string', title: 'Thinking level', enum: ['low'] } },
        } }])
        await f.connection.models()
      }
    }, undefined, { id: 'gpt-6', config: { thinkingLevel: 'max' } })).rejects.toThrow('unsupported value')
    expect(f.host.modelQueries()).toBe(2)
    expect(f.host.dispatches).toHaveLength(0)
  })
})
