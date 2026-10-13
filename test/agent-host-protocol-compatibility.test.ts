// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { AhpErrorCodes, MessageKind } from '@microsoft/agent-host-protocol'
import type { ChatTurnStartedAction } from '@microsoft/agent-host-protocol'
import { describe, expect, it } from 'vitest'
import { agentHostProtocolVersions } from '../src/shared/agentHost'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { agentHostEndpointSchema, requireAgentHostProtocolVersion } from '../src/main/agentHostProtocol'
import { connectAgentHostWebSocket, discoverAgentHosts } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

async function fixture(protocolVersion: string, advertisedVersion = protocolVersion) {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-version-'))
  const discovery = join(root, 'discovery')
  await mkdir(discovery)
  const host = await startAgentHostFixture(undefined, protocolVersion)
  const endpoint = { ...host.endpoint, protocolVersion: advertisedVersion }
  await writeFile(join(discovery, 'host.json'), JSON.stringify(endpoint))
  const owner = { clientId: randomUUID(), machineName: 'Fixture-owner' }
  const target = { owner, sessionId: host.sessionId, chatId: host.chatId }
  const registry = new AgentHostRegistry(join(root, 'profile'), [discovery], async () => owner)
  return { root, discovery, host, endpoint, owner, target, registry,
    close: async () => { await registry.close(); await host.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('Agent Host protocol compatibility', () => {
  it.each(agentHostProtocolVersions)('discovers, lists, streams and sends on AHP %s without replacing the session', async (version) => {
    const f = await fixture(version)
    const [terminal] = f.host.historyTerminals(1)
    const original = f.host.snapshot(f.host.chatId)
    try {
      expect(await discoverAgentHosts([f.discovery])).toEqual([f.endpoint])
      expect((await f.registry.list()).sessions).toContainEqual(expect.objectContaining(f.target))
      const connection = await f.registry.connection(f.target)
      await connection.open()
      expect(connection.view.protocolVersion).toBe(version)
      expect(connection.handshake.protocolVersion).toBe(version)
      expect(f.host.snapshot(f.host.chatId)).toEqual(original)
      expect(f.host.dispatches).toEqual([])
      expect(await connection.models()).toContainEqual(expect.objectContaining({ id: 'gpt-6' }))
      const output = await connection.terminal(terminal)
      expect(output.state).toMatchObject({ content: [{ type: 'unclassified', value: 'Full historical output 0' }] })
      const turnId = randomUUID()
      await connection.send(turnId, 'Fixture-only compatibility check', undefined, async () => {}, undefined, { id: 'gpt-6' })
      f.host.action({ type: 'chat/responsePart', turnId, part: { id: 'reply', kind: 'markdown', content: '' } })
      f.host.action({ type: 'chat/delta', turnId, partId: 'reply', content: 'Compatible streamed response' })
      await expect.poll(() => connection.view.chat?.activeTurn?.responseParts).toContainEqual({ id: 'reply', kind: 'markdown', content: 'Compatible streamed response' })
      await connection.cancel(turnId, async () => {})
      await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
      expect(f.host.dispatches).toHaveLength(2)
      expect(f.host.initializations.length).toBeGreaterThan(0)
      for (const offered of f.host.initializations) expect(offered).toEqual([...agentHostProtocolVersions])
      expect(connection.view.target).toEqual(f.target)
    } finally { await f.close() }
  })

  it.each([
    ['0.10.0', '0.9.0'],
    ['1.1.0', '1.0.0'],
  ])('negotiates advertised %s using the actual compatible %s baseline', async (advertised, selected) => {
    const f = await fixture(selected, advertised)
    try {
      expect(await discoverAgentHosts([f.discovery])).toEqual([f.endpoint])
      const connection = await f.registry.connection(f.target)
      await connection.open()
      expect(connection.view.protocolVersion).toBe(selected)
      expect(f.host.dispatches).toEqual([])
    } finally { await f.close() }
  })

  it.each(['0.8.0', '1.1.0', '2.0.0'])('does not accept an unoffered %s initialize response', async (selected) => {
    const f = await fixture(selected, '0.10.0')
    try {
      expect(await discoverAgentHosts([f.discovery])).toEqual([f.endpoint])
      const catalog = await f.registry.list()
      expect(catalog.sessions).toEqual([])
      expect(catalog.warnings).toEqual([expect.stringContaining('supports AHP')])
      expect((await f.registry.creationHosts(new AbortController().signal))[0]).toMatchObject({ available: false })
      expect(f.host.dispatches).toEqual([])
    } finally { await f.close() }
  })

  it('keeps descriptor validation local and rejects malformed or unoffered versions', async () => {
    const f = await fixture('0.10.0')
    try {
      for (const version of ['0.10', '0.10.0\n', '00.10.0', '0.10.0-preview', 'garbage']) {
        expect(agentHostEndpointSchema.safeParse({ ...f.endpoint, protocolVersion: version }).success).toBe(false)
      }
      expect(agentHostEndpointSchema.safeParse({ ...f.endpoint, endpoint: { type: 'tcp', host: 'example.com', port: 80 } }).success).toBe(false)
      expect(() => requireAgentHostProtocolVersion('0.10.0', ['0.9.0'])).toThrow('unoffered')
      expect(() => requireAgentHostProtocolVersion(undefined)).toThrow('unsupported')
    } finally { await f.close() }
  })

  it.each(agentHostProtocolVersions)('preserves %s and read-only authorization through the remote gateway', async (version) => {
    const f = await fixture(version)
    const server = createServer()
    let port = 0
    const gateway = attachAgentHostGateway(server, {
      port: () => port,
      authorize: async (_token, target, send) => {
        expect(target).toEqual(f.target)
        if (send) throw new Error('Read-only fixture.')
        return { canSend: false, actor: f.owner }
      },
      connection: (target) => f.registry.connection(target),
    })
    let client: AhpClient | undefined
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture gateway port.')
      port = address.port
      const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(f.target)).toString('base64url')}`
      client = new AhpClient(await connectAgentHostWebSocket(url, {}, new AbortController().signal))
      client.connect()
      if (version !== '0.9.0') {
        await expect(client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })).rejects.toMatchObject({ code: AhpErrorCodes.UnsupportedProtocolVersion })
        await client.shutdown()
        client = new AhpClient(await connectAgentHostWebSocket(url, {}, new AbortController().signal))
        client.connect()
      }
      const initialized = await client.initialize({ clientId: randomUUID(), protocolVersions: [...agentHostProtocolVersions] })
      expect(initialized.protocolVersion).toBe(version)
      expect(initialized._meta?.taskcontinuumCanSend).toBe(false)
      const result = await client.request('subscribe', { channel: f.target.chatId })
      expect(result.snapshot?.resource).toBe(f.target.chatId)
      const remote = client
      const closed = (async () => {
        for await (const state of remote.stateChanges()) if (state.status === 'closed') return true
        return false
      })()
      remote.dispatch(f.target.chatId, {
        type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId: randomUUID(),
        startedAt: new Date().toISOString(),
        message: { text: 'Must not be sent', origin: { kind: MessageKind.User } },
      })
      expect(await closed).toBe(true)
      expect(f.host.dispatches).toEqual([])
    } finally {
      await client?.shutdown()
      gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await f.close()
    }
  })
})
