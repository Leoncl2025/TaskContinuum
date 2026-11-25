// @vitest-environment node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { SessionState } from '@microsoft/agent-host-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectLocalAgentHost } from '../src/main/agentHostTransport'
import { TaskContinuumAgentHostTools } from '../src/main/taskContinuumAgentHostTools'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'

const codeRoot = process.platform === 'win32' ? process.env.TASKCONTINUUM_TEST_VSCODE_ROOT : undefined
const appRoot = process.env.TASKCONTINUUM_TEST_VSCODE_APP
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.skipIf(!codeRoot || !appRoot)('registers and withdraws TaskContinuum tool definitions in an isolated installed VS Code Host', { timeout: 50000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tc-native-tools-smoke-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
  const work = join(directory, 'workspace')
  await mkdir(work)
  const hostExe = join(codeRoot!, 'Code.exe')
  const entry = join(appRoot!, 'out', 'bootstrap-fork.js')
  const socket = `\\\\.\\pipe\\tc-native-tools-smoke-${randomUUID()}`
  const token = randomUUID()
  const env = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: directory, HOME: directory, APPDATA: join(directory, 'appdata'), LOCALAPPDATA: join(directory, 'local'),
    COPILOT_HOME: join(directory, 'copilot'),
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_ESM_ENTRYPOINT: 'vs/platform/agentHost/node/agentHostMain',
    VSCODE_NLS_CONFIG: JSON.stringify({ defaultMessagesFile: join(dirname(entry), 'nls.messages.json') }),
    VSCODE_AGENT_HOST_SOCKET_PATH: socket, VSCODE_AGENT_HOST_CONNECTION_TOKEN: token,
    VSCODE_AGENT_HOST_TELEMETRY_LEVEL: 'off',
  }
  const child = spawn(hostExe, [entry, '--user-data-dir', join(directory, 'vscode')], {
    cwd: work, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let startup = ''
  child.stderr?.on('data', (bytes: Buffer) => { startup = (startup + bytes.toString()).slice(-4000) })
  cleanup.push(async () => {
    if (child.exitCode !== null || !child.pid) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  })
  const endpoint: AgentHostEndpoint = { schemaVersion: 2, type: 'editor', pid: child.pid!, instanceId: randomUUID(),
    protocolVersion: '1.0.0', connectionToken: token, endpoint: { type: 'socket', path: socket } }
  let observer!: AhpClient
  try {
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error('Isolated Host exited.')
      observer = new AhpClient(await connectLocalAgentHost(endpoint, AbortSignal.timeout(1000)), { requestTimeoutMs: 20000 })
    }, { timeout: 10000 })
  } catch {
    throw new Error(`Could not connect to isolated installed Host (${child.exitCode}): ${startup.replaceAll(directory, '<temp>').replaceAll(token, '<token>').replaceAll(socket, '<pipe>')}`)
  }
  cleanup.push(() => observer.shutdown())
  observer.connect()
  const initialized = await observer.initialize({ clientId: randomUUID(), protocolVersions: ['1.0.0'] })
  expect(initialized.protocolVersion).toBe('1.0.0')
  const sessionId = `copilotcli:/${randomUUID()}`
  await observer.request('createSession', { channel: sessionId, provider: 'copilotcli', workingDirectories: [pathToFileURL(work).href] })
  const state = async () => (await observer.request('subscribe', { channel: sessionId })).snapshot?.state as SessionState
  const chatId = (await state()).defaultChat!
  expect(chatId).toMatch(/^ahp-chat:\//)
  const target = { sessionId, chatId, owner: { clientId: randomUUID(), machineName: 'Local' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(endpoint, signal), true)
  cleanup.push(() => connection.close())
  const tools = new TaskContinuumAgentHostTools(() => { throw new Error('This smoke test does not send an Agent prompt.') })
  const detach = tools.attach(work, connection, async () => {})
  cleanup.push(detach)
  await connection.open()
  await vi.waitFor(async () => expect((await state()).activeClients).toContainEqual(expect.objectContaining({
    displayName: 'TaskContinuum', tools: expect.arrayContaining([expect.objectContaining({ name: 'taskcontinuum_collaboration_list_sessions' })]),
  })), { timeout: 5000 })
  detach()
  await vi.waitFor(async () => expect((await state()).activeClients.some((item) => item.displayName === 'TaskContinuum')).toBe(false), { timeout: 5000 })
})
