// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  connect: vi.fn(),
  client: vi.fn(),
}))
vi.mock('../src/main/agentHostTransport', () => ({
  discoverAgentHosts: mocks.discover,
  connectLocalAgentHost: mocks.connect,
}))
vi.mock('@microsoft/agent-host-protocol/client', () => ({ AhpClient: mocks.client }))

const hostWarning = 'A local Agent Host could not be read. Check that it is running and supports AHP 0.9.0.'
const skipWarning = 'Some local Agent Host sessions could not be read and were skipped.'
const cleanupWarning = 'Some local Agent Host session subscriptions could not be released.'
const privateError = 'Could not restore C:\\private\\missing-project: internal RPC failure'
const owner = { clientId: '11111111-1111-4111-8111-111111111111', machineName: 'Test-owner' }
const endpoint: AgentHostEndpoint = {
  schemaVersion: 2, type: 'standalone', pid: 1, instanceId: 'fixture-host',
  connectionToken: 'test-only-connection-token', protocolVersion: '0.9.0',
  endpoint: { type: 'tcp', host: '127.0.0.1', port: 12345 },
}
const item = (id: string, provider = 'copilotcli') => ({
  resource: `copilotcli:/${id}`, title: `${id} session`, provider,
})
const older = item('older'), brokenOne = item('broken-one'), brokenTwo = item('broken-two'), newer = item('newer')
const chat = (id: string) => ({ resource: `ahp-chat:/${id}`, title: `${id} chat`, modifiedAt: '2026-09-20T00:00:00Z' })
const snapshot = (resource: string, chats: unknown[]) => ({ snapshot: { resource, state: { provider: 'copilotcli', chats } } })
type Page = { items: ReturnType<typeof item>[]; nextCursor?: string }

function fixture(
  pages: Page[] = [{ items: [older, brokenOne, brokenTwo], nextCursor: 'page-two' }, { items: [newer] }],
  snapshots = new Map<string, unknown>([
    [older.resource, snapshot(older.resource, [chat('older')])],
    [newer.resource, snapshot(newer.resource, [chat('newer')])],
  ]),
) {
  const client = {
    connect: vi.fn(),
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params: { channel: string; cursor?: string }) => {
      if (method === 'listSessions') return pages[params.cursor ? 1 : 0]
      if (method === 'subscribe' && snapshots.has(params.channel)) return snapshots.get(params.channel)
      throw new Error(privateError)
    }),
    unsubscribe: vi.fn<(resource: string) => Promise<void>>(async () => {}),
    shutdown: vi.fn(async () => {}),
  }
  mocks.client.mockImplementation(function () { return client })
  const registry = new AgentHostRegistry('unused-profile', ['unused-discovery'], async () => owner)
  return { registry, client, snapshots }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.discover.mockResolvedValue([endpoint])
  mocks.connect.mockResolvedValue({})
})

describe('AgentHostRegistry session listing', () => {
  it('skips two unrestorable sessions without losing later entries or pagination', async () => {
    const { registry, client } = fixture()
    const result = await registry.list()
    expect(result.sessions.map((session) => session.sessionId)).toEqual([older.resource, newer.resource])
    expect(result.sessions.map((session) => session.title)).toEqual(['older chat', 'newer chat'])
    expect(result.warnings).toEqual([skipWarning])
    expect(JSON.stringify(result)).not.toContain(privateError)
    expect(JSON.stringify(result)).not.toContain('C:\\private')
    expect(client.request.mock.calls.filter(([method]) => method === 'subscribe').map(([, params]) => params.channel))
      .toEqual([older.resource, brokenOne.resource, brokenTwo.resource, newer.resource])
    expect(client.request.mock.calls.filter(([method]) => method === 'listSessions')).toEqual([
      ['listSessions', { channel: 'ahp-root://', limit: 100 }],
      ['listSessions', { channel: 'ahp-root://', limit: 100, cursor: 'page-two' }],
    ])
    expect(client.unsubscribe.mock.calls).toEqual([[older.resource], [newer.resource]])
    expect(client.shutdown).toHaveBeenCalledOnce()
    expect(mocks.connect.mock.calls[0][1].aborted).toBe(true)
  })

  it.each([
    ['missing snapshot', {}],
    ['wrong resource', snapshot(newer.resource, [chat('partial')])],
    ['wrong provider', { snapshot: { resource: brokenOne.resource, state: { provider: 'other-provider', chats: [chat('partial')] } } }],
    ['invalid chats', { snapshot: { resource: brokenOne.resource, state: { provider: 'copilotcli', chats: {} } } }],
    ['invalid later chat', snapshot(brokenOne.resource, [chat('partial'), { ...chat('invalid'), resource: 'not-an-ahp-chat' }])],
  ])('discards the entire item and unsubscribes after a %s', async (_label, invalid) => {
    const { registry, client, snapshots } = fixture([{ items: [older, brokenOne, newer] }])
    snapshots.set(brokenOne.resource, invalid)
    const result = await registry.list()
    expect(result.sessions.map((session) => session.sessionId)).toEqual([older.resource, newer.resource])
    expect(result.sessions.some((session) => session.chatId === 'ahp-chat:/partial')).toBe(false)
    expect(result.warnings).toEqual([skipWarning])
    expect(client.unsubscribe.mock.calls).toEqual([[older.resource], [brokenOne.resource], [newer.resource]])
  })

  it('retains valid chats and continues pages when unsubscribe fails', async () => {
    const { registry, client } = fixture([{ items: [older], nextCursor: 'page-two' }, { items: [newer] }])
    client.unsubscribe.mockRejectedValue(new Error(privateError))
    const result = await registry.list()
    expect(result.sessions.map((session) => session.sessionId)).toEqual([older.resource, newer.resource])
    expect(result.warnings).toEqual([cleanupWarning])
    expect(result.warnings).not.toContain(hostWarning)
    expect(JSON.stringify(result)).not.toContain(privateError)
    expect(client.unsubscribe.mock.calls).toEqual([[older.resource], [newer.resource]])
    expect(client.shutdown).toHaveBeenCalledOnce()
  })

  it('still cleans up rejected snapshots without letting cleanup errors stop enumeration', async () => {
    const { registry, client, snapshots } = fixture([{ items: [brokenOne, newer] }])
    snapshots.set(brokenOne.resource, snapshot(brokenOne.resource, [chat('partial'), null]))
    client.unsubscribe.mockRejectedValueOnce(new Error(privateError))
    const result = await registry.list()
    expect(result.sessions.map((session) => session.sessionId)).toEqual([newer.resource])
    expect(result.warnings).toEqual([skipWarning, cleanupWarning])
    expect(client.unsubscribe.mock.calls).toEqual([[brokenOne.resource], [newer.resource]])
  })

  it('deduplicates the skip warning across local Hosts', async () => {
    mocks.discover.mockResolvedValue([endpoint, { ...endpoint, instanceId: 'second-fixture-host' }])
    const { registry } = fixture([{ items: [brokenOne, brokenTwo] }])
    expect(await registry.list()).toEqual({ sessions: [], warnings: [skipWarning] })
  })

  it('retains the provider filter, hidden-chat filtering and read-only conversion', async () => {
    const unsupported = item('unsupported', 'another-provider')
    const { registry, client, snapshots } = fixture([{ items: [unsupported, newer] }])
    snapshots.set(newer.resource, snapshot(newer.resource, [
      { resource: 'invalid-hidden-id', interactivity: 'hidden' },
      { ...chat('newer'), title: '', interactivity: 'read-only' },
    ]))
    const result = await registry.list()
    expect(result.sessions).toEqual([{
      sessionId: newer.resource, chatId: 'ahp-chat:/newer', owner, provider: 'copilotcli',
      title: newer.title, updatedAt: '2026-09-20T00:00:00Z', canSend: false,
    }])
    expect(result.warnings).toEqual([])
    expect(client.request.mock.calls.filter(([method]) => method === 'subscribe').map(([, params]) => params.channel)).toEqual([newer.resource])
  })

  it('preserves the global chat limit while staging a multi-chat item', async () => {
    const { registry, client, snapshots } = fixture([{ items: [older, newer], nextCursor: 'page-two' }, { items: [brokenOne] }])
    snapshots.set(older.resource, snapshot(older.resource, Array.from({ length: 999 }, (_, index) => chat(`older-${index}`))))
    snapshots.set(newer.resource, snapshot(newer.resource, [chat('newer-first'), chat('newer-second')]))
    const result = await registry.list()
    expect(result.sessions).toHaveLength(1000)
    expect(result.sessions.at(-1)?.chatId).toBe('ahp-chat:/newer-first')
    expect(result.warnings).toEqual([])
    expect(client.request.mock.calls.filter(([method]) => method === 'listSessions')).toHaveLength(1)
    expect(client.unsubscribe.mock.calls).toEqual([[older.resource], [newer.resource]])
  })

  it.each(['connection', 'initialize', 'listSessions'])('keeps a %s failure at Host scope', async (stage) => {
    const { registry, client } = fixture()
    if (stage === 'connection') mocks.connect.mockRejectedValueOnce(new Error(privateError))
    else if (stage === 'initialize') client.initialize.mockRejectedValueOnce(new Error(privateError))
    else client.request.mockRejectedValueOnce(new Error(privateError))
    expect(await registry.list()).toEqual({ sessions: [], warnings: [hostWarning] })
    expect(client.unsubscribe).not.toHaveBeenCalled()
    expect(client.shutdown).toHaveBeenCalledTimes(stage === 'connection' ? 0 : 1)
  })

  it('keeps successful earlier items when a later catalog page fails at Host scope', async () => {
    const { registry, client } = fixture()
    client.request.mockImplementation(async (method, params) => {
      if (method === 'subscribe') return snapshot(older.resource, [chat('older')])
      if (!params.cursor) return { items: [older], nextCursor: 'page-two' }
      throw new Error(privateError)
    })
    const result = await registry.list()
    expect(result.sessions.map((session) => session.sessionId)).toEqual([older.resource])
    expect(result.warnings).toEqual([hostWarning])
    expect(client.shutdown).toHaveBeenCalledOnce()
  })
})
