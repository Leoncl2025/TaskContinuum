import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { Subscription } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import type { ActionEnvelope, ChatState, RootState, SessionState, TerminalState } from '@microsoft/agent-host-protocol'
import { expect, test } from '@playwright/test'
import { startSshFixture } from '../test/ssh-fixture'
import { openSshTunnel } from '../src/main/shared/ssh'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectAgentHostWebSocket } from '../src/main/agentHostTransport'

test('subscribes two clients to an isolated actual VS Code Agent Host', async () => {
  test.skip(!process.env.TASKCONTINUUM_VERIFY_AHP_CLI, 'Set the installed code-tunnel executable to verify AHP without user sessions.')
  test.setTimeout(180000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-'))
  const home = join(root, 'home')
  await mkdir(home)
  await cp(resolve('e2e/fixtures/ahp/output.mjs'), join(home, 'output.mjs'))
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No isolated test port was assigned.')
  const port = address.port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const token = randomBytes(32).toString('hex')
  const environment = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), VSCODE_CLI_DATA_DIR: join(root, 'cli'), VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED: 'false', VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED: 'false' }
  const host = spawn(process.env.TASKCONTINUUM_VERIFY_AHP_CLI!, [
    'agent', 'host', '--new-instance', '--foreground', '--host', '127.0.0.1', '--port', String(port),
    '--connection-token', token, '--user-data-dir', join(root, 'profile'), '--server-data-dir', join(root, 'server'),
    '--cli-data-dir', join(root, 'cli'), '--idle-timeout', '90',
  ], { cwd: home, windowsHide: true, env: environment })
  const hosts = [host]
  let output = ''
  const capture = (chunk: Buffer) => { output = (output + chunk.toString().replaceAll(token, '[redacted]')).slice(-12000) }
  host.stdout.on('data', capture)
  host.stderr.on('data', capture)
  const clients: AhpClient[] = []
  let production: AgentHostConnection | undefined
  const clientIds = [randomUUID(), randomUUID()]
  let ssh: Awaited<ReturnType<typeof startSshFixture>> | undefined
  let tunnel: Awaited<ReturnType<typeof openSshTunnel>> | undefined
  const pumps: Promise<void>[] = []
  const observe = (subscription: Subscription) => {
    const records: { envelope: ActionEnvelope; receivedAt: number }[] = []
    pumps.push((async () => {
      for await (const event of subscription) {
        if (event.type === 'action') records.push({ envelope: event.params, receivedAt: Date.now() })
      }
    })())
    return records
  }
  let phase = 'Host startup'
  try {
    await expect.poll(async () => {
      if (host.exitCode !== null) throw new Error(`Isolated Agent Host exited (${host.exitCode}): ${output}`)
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); return true } catch { return false }
    }, { timeout: 140000, intervals: [250, 500, 1000] }).toBe(true)
    phase = 'Authentication rejection'
    await expect(WebSocketTransport.connect(`ws://127.0.0.1:${port}/?tkn=wrong-token`)).rejects.toThrow()
    ssh = await startSshFixture(join(root, 'ssh'), port)
    tunnel = await openSshTunnel('owner-machine', port, ssh.config, new AbortController().signal)
    for (let index = 0; index < 2; index++) {
      phase = `Client ${index + 1} WebSocket connection`
      const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${index === 0 ? port : tunnel.port}/?tkn=${token}`)
      const client = new AhpClient(transport, { requestTimeoutMs: 10000 })
      clients.push(client)
      client.connect()
      phase = `Client ${index + 1} protocol initialization`
      const initialized = await client.initialize({ clientId: clientIds[index], protocolVersions: ['0.9.0'] })
      expect(initialized.terminalCommandPrefix).toBe('!')
      const { result } = await client.subscribe('ahp-root://')
      expect(result.snapshot?.resource).toBe('ahp-root://')
      await client.ping()
      console.log(JSON.stringify({ client: index + 1, protocolVersion: initialized.protocolVersion, subscribed: result.snapshot?.resource }))
    }
    phase = 'Isolated empty session creation'
    const catalog = (await clients[0].subscribe('ahp-root://')).result.snapshot?.state as RootState
    const provider = catalog.agents.find((agent) => agent.provider.toLowerCase().includes('copilot'))?.provider
    console.log(JSON.stringify({ advertisedProviders: catalog.agents.map((agent) => agent.provider) }))
    if (!provider) throw new Error('This isolated Host does not advertise a Copilot provider.')
    const session = `copilotcli:/${randomUUID()}`
    await clients[0].request('createSession', { channel: session, provider, workingDirectories: [pathToFileURL(home).href] })
    const firstSession = await clients[0].subscribe(session)
    const secondSession = await clients[1].subscribe(session)
    const firstState = firstSession.result.snapshot?.state as SessionState
    const secondState = secondSession.result.snapshot?.state as SessionState
    expect(firstState.defaultChat).toMatch(/^ahp-chat:/)
    expect(secondState.defaultChat).toBe(firstState.defaultChat)
    const firstChat = await clients[0].subscribe(firstState.defaultChat!)
    const secondChat = await clients[1].subscribe(secondState.defaultChat!)
    expect(firstChat.result.snapshot).toEqual(secondChat.result.snapshot)
    const unrelatedSession = `copilotcli:/${randomUUID()}`
    await clients[0].request('createSession', { channel: unrelatedSession, provider, workingDirectories: [pathToFileURL(home).href] })
    const unrelatedState = (await clients[1].subscribe(unrelatedSession)).result.snapshot?.state as SessionState
    const unrelatedChat = unrelatedState.defaultChat!
    const unrelated = await clients[1].subscribe(unrelatedChat)
    const unrelatedEvents = observe(unrelated.subscription)
    console.log(JSON.stringify({ sameSession: true, sameChat: true, modelPrompts: 0, lifecycle: firstState.lifecycle }))
    phase = 'Host-local streaming command'
    const chat = firstState.defaultChat!
    const firstChatEvents = observe(firstChat.subscription)
    const secondChatEvents = observe(secondChat.subscription)
    const turnId = randomUUID()
    production = new AgentHostConnection({ hostId: randomUUID(), sessionId: session, chatId: chat, owner: { clientId: randomUUID(), machineName: 'Isolated-Host' } }, join(root, 'production-client'), (signal) => connectAgentHostWebSocket(`ws://127.0.0.1:${port}/?tkn=${token}`, {}, signal))
    await production.open()
    await production.send(turnId, '!node output.mjs', undefined, async () => {})
    const terminalResource = () => {
      for (const { envelope } of firstChatEvents) {
        if (envelope.action.type === 'chat/toolCallContentChanged') {
          const terminal = envelope.action.content.find((part) => part.type === 'terminal')
          if (terminal?.type === 'terminal') return terminal.resource
        }
      }
      return undefined
    }
    await expect.poll(terminalResource).toBeTruthy()
    const terminal = terminalResource()!
    const firstTerminal = await clients[0].subscribe(terminal)
    const secondTerminal = await clients[1].subscribe(terminal)
    const firstTerminalEvents = observe(firstTerminal.subscription)
    const secondTerminalEvents = observe(secondTerminal.subscription)
    const outputOf = (events: typeof firstTerminalEvents) => events.flatMap(({ envelope }) => envelope.action.type === 'terminal/data' ? [envelope.action.data] : []).join('')
    console.log(JSON.stringify({ terminalScheme: terminal.split(':')[0], productionState: production.view.state, productionError: production.view.error, productionAllowsTerminal: production.allowedChannel(terminal), productionTerminalCount: Object.keys(production.view.terminals).length, firstSnapshotHasAlpha: JSON.stringify(firstTerminal.result.snapshot?.state).includes('AHP_ALPHA:') }))
    phase = 'Direct subscriber terminal increments'
    await expect.poll(() => outputOf(firstTerminalEvents), { intervals: [10, 20, 50] }).toContain('AHP_ALPHA:')
    phase = 'SSH subscriber terminal increments'
    await expect.poll(() => outputOf(secondTerminalEvents), { intervals: [10, 20, 50] }).toContain('AHP_ALPHA:')
    const productionOutput = () => Object.values(production!.view.terminals).flatMap((state) => state.content.map((part) => part.type === 'command' ? part.output : part.value)).join('')
    phase = 'Production subscriber terminal state'
    await expect.poll(productionOutput, { intervals: [10, 20, 50] }).toContain('AHP_ALPHA:')
    expect(production.view.chat?.activeTurn?.id).toBe(turnId)
    expect(firstChatEvents.some(({ envelope }) => envelope.action.type === 'chat/turnComplete')).toBe(false)
    const lastSeenServerSeq = Math.max(...secondChatEvents.map(({ envelope }) => envelope.serverSeq), ...secondTerminalEvents.map(({ envelope }) => envelope.serverSeq))
    await clients[1].shutdown()
    tunnel.close()
    tunnel = undefined
    await expect.poll(() => firstChatEvents.some(({ envelope }) => envelope.action.type === 'chat/turnComplete')).toBe(true)
    const completion = firstChatEvents.find(({ envelope }) => envelope.action.type === 'chat/toolCallComplete')
    expect(completion?.envelope.action).toMatchObject({ result: { success: true } })
    expect(outputOf(firstTerminalEvents)).toContain('AHP_GAMMA:')
    await expect.poll(productionOutput).toContain('AHP_GAMMA:')
    await production.send(turnId, '!node output.mjs', undefined, async () => {})
    expect(production.view.chat?.turns).toHaveLength(1)
    const nativeCatalog = await clients[0].request('listSessions', { channel: 'ahp-root://', limit: 100 })
    expect(nativeCatalog.items.some((item) => item.resource === session && item.provider === provider)).toBe(true)
    phase = 'Subscriber reconnect without replaying execution'
    tunnel = await openSshTunnel('owner-machine', port, ssh.config, new AbortController().signal)
    const resumed = new AhpClient(await WebSocketTransport.connect(`ws://127.0.0.1:${tunnel.port}/?tkn=${token}`), { requestTimeoutMs: 10000 })
    clients.push(resumed)
    resumed.connect()
    const recovered = await resumed.reconnect({ clientId: clientIds[1], lastSeenServerSeq, subscriptions: [session, chat, terminal] })
    expect(recovered.type).toMatch(/^(replay|snapshot)$/)
    if (recovered.type === 'replay') {
      expect(recovered.missing).toEqual([])
      expect(recovered.actions.every((envelope) => envelope.serverSeq > lastSeenServerSeq)).toBe(true)
      expect(recovered.actions.filter((envelope) => envelope.channel === terminal && envelope.action.type === 'terminal/data'))
        .toEqual(firstTerminalEvents.filter(({ envelope }) => envelope.serverSeq > lastSeenServerSeq && envelope.action.type === 'terminal/data').map(({ envelope }) => envelope))
    }
    const finalChat = (await resumed.subscribe(chat)).result.snapshot?.state as ChatState
    const finalTerminal = (await resumed.subscribe(terminal)).result.snapshot?.state as TerminalState
    expect(finalChat.turns).toHaveLength(1)
    expect(finalChat.turns[0].id).toBe(turnId)
    expect(finalChat.activeTurn).toBeUndefined()
    const restoredOutput = finalTerminal.content.map((part) => part.type === 'command' ? part.output : part.value).join('')
    for (const label of ['ALPHA', 'BETA', 'GAMMA']) expect(restoredOutput.match(new RegExp(`AHP_${label}:`, 'g'))).toHaveLength(1)
    expect(firstChatEvents.filter(({ envelope }) => envelope.action.type === 'chat/turnStarted')).toHaveLength(1)
    expect(unrelatedEvents.filter(({ envelope }) => envelope.action.type === 'chat/turnStarted')).toHaveLength(0)
    expect(((await resumed.subscribe(unrelatedChat)).result.snapshot?.state as ChatState).turns).toHaveLength(0)
    expect(ssh.forwardedConnections()).toBeGreaterThanOrEqual(2)
    const timings = firstTerminalEvents.flatMap(({ envelope, receivedAt }) => envelope.action.type === 'terminal/data'
      ? [...envelope.action.data.matchAll(/AHP_\w+:(\d+)/g)].map((match) => receivedAt - Number(match[1])) : [])
    expect(timings.length).toBeGreaterThan(0)
    expect(Math.max(...timings)).toBeLessThan(2000)
    const sshTimings = secondTerminalEvents.flatMap(({ envelope, receivedAt }) => envelope.action.type === 'terminal/data'
      ? [...envelope.action.data.matchAll(/AHP_\w+:(\d+)/g)].map((match) => receivedAt - Number(match[1])) : [])
    expect(sshTimings.length).toBeGreaterThan(0)
    expect(Math.max(...sshTimings)).toBeLessThan(2000)
    const report = { protocolVersion: '0.9.0', provider, productionClientVerified: true, sameSession: true, sameChat: true, otherSessionUnchanged: true, observedBeforeCompletion: true, reconnect: recovered.type, executionCount: 1, modelGenerationRequested: false, maximumLoopbackOutputLatencyMs: Math.max(...timings), maximumSshFirstOutputLatencyMs: Math.max(...sshTimings), sshConnections: ssh.forwardedConnections(), chatActions: [...new Set(firstChatEvents.map(({ envelope }) => envelope.action.type))], limitation: 'Host-local command and terminal stream on one machine; no real Copilot model delta or physical-network latency verified.' }
    console.log(JSON.stringify(report))
    await test.info().attach('ahp-proof-of-concept', { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json' })
  } catch (error) {
    throw new Error(`${phase}: ${error instanceof Error ? error.message : String(error)}\n${output}`.replaceAll(token, '[redacted]'), { cause: error })
  } finally {
    await production?.close()
    for (const client of clients) await client.shutdown()
    await Promise.all(pumps)
    tunnel?.close()
    await ssh?.close()
    for (const owned of hosts.reverse()) {
      if (owned.exitCode !== null || !owned.pid) continue
      const exited = once(owned, 'exit')
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true }).catch((error: unknown) => {
        if (owned.exitCode !== null) return
        try { process.kill(owned.pid!, 0) } catch (lookup) { if ((lookup as NodeJS.ErrnoException).code === 'ESRCH') return; throw lookup }
        throw error
      })
      else owned.kill()
      await exited
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})