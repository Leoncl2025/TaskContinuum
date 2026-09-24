// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'
import { agentHostKey } from '../src/shared/agentHost'

it('measures a guarded send with at least 3.6 MB of history without changing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-hot-path-'))
  const host = await startAgentHostFixture()
  const text = 'previous result '.repeat(850)
  host.historyText(300, text)
  const snapshot = host.snapshot(host.chatId)
  const historyBytes = Buffer.byteLength(JSON.stringify(snapshot))
  expect(historyBytes).toBeGreaterThanOrEqual(3_600_000)
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  try {
    await connection.models()
    const clone = globalThis.structuredClone
    let fullHistoryClones = 0
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      if (value && typeof value === 'object' && ('turns' in value || 'state' in value && value.state && typeof value.state === 'object' && 'turns' in value.state)) fullHistoryClones++
      return clone(value, options)
    })
    const started = performance.now()
    let sendMs: number
    const id = randomUUID()
    let authorizations = 0
    try {
      await connection.send(id, 'Next message', undefined, async () => {
        if (++authorizations !== 2) return
        const ledgerPath = join(directory, 'agent-host', `${createHash('sha256').update(agentHostKey(target)).digest('hex')}.commands.json`)
        const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
        expect(ledger.commands).toContainEqual(expect.objectContaining({ id, state: 'pending' }))
        expect(host.dispatches).toHaveLength(0)
      }, undefined, { id: 'gpt-6' })
      sendMs = performance.now() - started
    } finally { spy.mockRestore() }
    console.log(JSON.stringify({ historyBytes, fullHistoryClones, sendMs: Math.round(sendMs), nativeModelQueries: host.modelQueries() }))
    // One copy in the simulated native Host response, one in our owned chat state.
    expect(fullHistoryClones).toBe(2)
    expect(connection.view.chat?.turns).toHaveLength(300)
    expect(connection.view.chat?.turns[0].responseParts[0]).toMatchObject({ content: text })
    expect(host.dispatches).toHaveLength(1)
    expect(host.modelQueries()).toBe(1)
    const cloneStatus = vi.spyOn(globalThis, 'structuredClone')
    try {
      expect(connection.state).toBe('connected')
      expect(cloneStatus).not.toHaveBeenCalled()
    } finally { cloneStatus.mockRestore() }
    const view = connection.view
    const exported = connection.snapshot(host.chatId)
    const exportedChat = exported.state as NonNullable<typeof view.chat>
    exportedChat.turns[0].responseParts = []
    if (view.chat) view.chat.turns[0].responseParts = []
    expect(connection.view.chat?.turns[0].responseParts[0]).toMatchObject({ content: text })
  } finally { await connection.close(); await host.close(); await rm(directory, { recursive: true, force: true }) }
})
