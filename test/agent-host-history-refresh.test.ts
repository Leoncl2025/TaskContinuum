// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ChatState, Snapshot } from '@microsoft/agent-host-protocol'
import type { AhpTransport } from '@microsoft/agent-host-protocol/client'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

it.each(['reconnect', 'cached-restart'] as const)('keeps verified history visible until a fresh chat snapshot arrives during %s', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-history-refresh-'))
  const host = await startAgentHostFixture()
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  let connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  let unlisten: (() => void) | undefined
  try {
    host.historyText(2, 'Previously verified answer')
    await connection.open()
    expect(connection.view.chat?.turns).toHaveLength(2)
    if (mode === 'cached-restart') {
      await connection.close()
      const name = (await readdir(join(directory, 'agent-host'))).find((name) => name.endsWith('.cache.json'))!
      const file = join(directory, 'agent-host', name)
      const cached = JSON.parse(await readFile(file, 'utf8')) as { chat: Snapshot }
      cached.chat.fromSeq = 10000
      await writeFile(file, JSON.stringify(cached))
      connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
    } else {
      host.drop()
      await expect.poll(() => connection.state).toBe('offline')
    }
    host.historyText(0, '')
    const intermediate: (ChatState | undefined)[] = []
    unlisten = connection.listen((event) => {
      if (event.type === 'snapshot' && event.snapshot.resource === target.sessionId) intermediate.push(connection.view.chat)
    })

    await connection.open()
    expect(intermediate).toHaveLength(1)
    expect(intermediate[0]?.turns).toHaveLength(2)
    expect(intermediate[0]?.turns[0].responseParts).toContainEqual({ kind: 'markdown', id: 'answer-0', content: 'Previously verified answer' })
    expect(connection.view.chat?.turns).toEqual([])
    host.action({ type: 'chat/turnStarted', turnId: 'live-turn', startedAt: new Date().toISOString(),
      message: { text: 'New original request', origin: { kind: 'user' } } })
    host.action({ type: 'chat/responsePart', turnId: 'live-turn', part: { kind: 'markdown', id: 'live-answer', content: '' } })
    host.action({ type: 'chat/delta', turnId: 'live-turn', partId: 'live-answer', content: 'Incremental update' })
    await expect.poll(() => connection.view.chat?.activeTurn?.responseParts).toContainEqual({ kind: 'markdown', id: 'live-answer', content: 'Incremental update' })
    host.action({ type: 'chat/turnComplete', turnId: 'live-turn', duration: 1 })
    await expect.poll(() => connection.view.chat?.turns).toHaveLength(1)
    expect(host.dispatches).toEqual([])
    expect(host.methods).not.toContain('createSession')
  } finally {
    unlisten?.()
    await connection.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('retains the last verified history when a reconnect returns an invalid chat snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-invalid-history-refresh-'))
  const host = await startAgentHostFixture()
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  let corrupt = false
  const connection = new AgentHostConnection(target, directory, async (signal) => {
    const transport = await connectLocalAgentHost(host.endpoint, signal)
    const wrapped: AhpTransport = {
      send: (message) => transport.send(message),
      recv: async () => {
        const frame = await transport.recv()
        if (corrupt && frame?.kind === 'text') {
          const message = JSON.parse(frame.text) as { result?: { snapshot?: Snapshot } }
          const snapshot = message.result?.snapshot
          if (snapshot?.resource === target.chatId) {
            (snapshot.state as ChatState).resource = 'ahp-chat:/different-chat'
            return { kind: 'text', text: JSON.stringify(message) }
          }
        }
        return frame
      },
      close: () => transport.close(),
    }
    return wrapped
  })
  try {
    host.historyText(2, 'Last verified history')
    await connection.open()
    host.drop()
    await expect.poll(() => connection.state).toBe('offline')
    corrupt = true
    await expect(connection.open()).rejects.toThrow('invalid chat state')
    expect(connection.view.state).toBe('offline')
    expect(connection.view.chat?.turns).toHaveLength(2)
    expect(connection.view.error).toBeTruthy()
    expect(host.dispatches).toEqual([])
  } finally {
    await connection.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
