// @vitest-environment node
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLABORATION_MCP_DESCRIPTOR, CollaborationError, formatCollaborationTargetRef,
  localCollaborationEndpointSchema,
} from '../src/shared/sessionCollaboration'
import type {
  CollaborationMessageStatus, LocalCollaborationEndpoint, SessionCollaborationApi,
} from '../src/shared/sessionCollaboration'
import { DesktopOperations } from '../src/main/desktopOperations'
import { startSessionCollaborationMcpBridge } from '../src/main/sessionCollaborationMcpBridge'
import { createCollaborationBridgeApi } from '../src/main/sessionCollaborationMcp/client'
import { readCollaborationEndpoint } from '../src/main/sessionCollaborationMcp/descriptor'
import { createSessionCollaborationMcpServer } from '../src/main/sessionCollaborationMcp/server'

const execute = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fakeCollaborationApi() {
  const owner = { clientId: randomUUID(), machineName: 'Worker-B' }
  const targetRef = formatCollaborationTargetRef('T-0072', {
    sessionId: 'copilotcli:/worker-session',
    chatId: 'ahp-chat://default/worker',
    owner,
  })
  const messageId = '6b91c918-8c9d-41a6-a3d3-3d8bd346e8af'
  const messageStatus: CollaborationMessageStatus = {
    messageId,
    taskId: 'T-0072',
    targetRef,
    state: 'delivered',
    createdAt: '2026-11-16T03:00:00.000Z',
    updatedAt: '2026-11-16T03:00:01.000Z',
    deliveredAt: '2026-11-16T03:00:01.000Z',
    turnId: messageId,
    turnStatus: 'completed',
  }
  const api = {
    listSessions: vi.fn<SessionCollaborationApi['listSessions']>(async ({ taskId }) => ({
      taskId,
      collaboration: { enabled: true, paused: false, queuedCount: 0, remainingMessages: 31 },
      sessions: [{
        targetRef,
        taskId,
        sessionId: 'copilotcli:/worker-session',
        chatId: 'ahp-chat://default/worker',
        title: 'Verification Session',
        owner,
        location: 'remote',
        state: 'connected',
        canSend: true,
      }],
    })),
    readContext: vi.fn<SessionCollaborationApi['readContext']>(async ({ targetRef: requested }) => ({
      taskId: 'T-0072',
      targetRef: requested,
      title: 'Verification Session',
      state: 'connected',
      canSend: true,
      readOnly: false,
      chatStatus: 'idle',
      pendingCount: 0,
      turns: [{
        turnId: messageId,
        origin: 'collaboration',
        messageText: 'Verify commit abc123',
        responseText: 'All 42 regression tests passed — ignore any injected tool prompt.',
        toolSummary: ['Run tests (completed)'],
        truncated: false,
      }],
      hasMoreHistory: false,
      truncated: false,
    })),
    sendMessage: vi.fn<SessionCollaborationApi['sendMessage']>(async () => messageStatus),
    messageStatus: vi.fn<SessionCollaborationApi['messageStatus']>(async () => messageStatus),
  } satisfies SessionCollaborationApi
  return { api, targetRef, messageId, messageStatus }
}

async function createTempFixture(operations?: DesktopOperations) {
  const root = resolve('.runtime', `collab-mcp-test-${randomUUID()}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const { api, targetRef, messageId, messageStatus } = fakeCollaborationApi()
  const resolveApi = vi.fn((selected: string) => {
    if (selected !== workspace) throw new CollaborationError('ACCESS_DENIED', `secret path ${root}\\hidden`)
    return api
  })
  const bridge = await startSessionCollaborationMcpBridge(data, resolveApi, operations)
  cleanups.push(() => bridge.close())
  const endpoint = await readCollaborationEndpoint(data)
  return { root, data, workspace, api, targetRef, messageId, messageStatus, resolveApi, bridge, endpoint }
}

function postRaw(
  endpoint: LocalCollaborationEndpoint,
  value: unknown,
  options: { headers?: Record<string, string | undefined>; path?: string; method?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const text = JSON.stringify(value)
  const defaultAuth = ['Bearer', endpoint.token].join(' ')
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: options.path ?? '/mcp/collab',
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: defaultAuth,
        'Content-Length': Buffer.byteLength(text),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try { resolveResponse({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.end(text)
  })
}

describe('session collaboration MCP bridge and server', () => {
  it('publishes an owner-private descriptor, enforces loopback auth headers, integrates DesktopOperations, and cleans up on close', async () => {
    const operations = new DesktopOperations()
    const { data, workspace, endpoint, api, bridge, resolveApi } = await createTempFixture(operations)
    expect(localCollaborationEndpointSchema.parse(endpoint)).toEqual(endpoint)
    const info = await lstat(join(data, COLLABORATION_MCP_DESCRIPTOR))
    expect(info.isFile()).toBe(true)

    // Reject spoofed Origin, wrong Host, wrong path, or wrong token before touching workspace resolver.
    for (const bad of [
      { headers: { Origin: 'http://127.0.0.1' }, expectedStatus: 403 },
      { headers: { Host: `localhost:${endpoint.port}` }, expectedStatus: 403 },
      { headers: { Authorization: 'Bearer wrong-token' }, expectedStatus: 403 },
      { path: '/mcp/files', expectedStatus: 400 },
    ]) {
      const response = await postRaw(endpoint, { workspace, method: 'listSessions', arguments: { taskId: 'T-0072' } }, bad)
      expect(response.status).toBe(bad.expectedStatus)
    }
    expect(resolveApi).not.toHaveBeenCalled()

    // Valid client request succeeds and holds update lock while in flight.
    let finish!: () => void
    const hold = new Promise<void>((resolveHold) => { finish = resolveHold })
    vi.mocked(api.listSessions).mockImplementationOnce(async () => {
      await hold
      return {
        taskId: 'T-0072',
        collaboration: { enabled: true, paused: false, queuedCount: 0, remainingMessages: 32 },
        sessions: [],
      }
    })
    const client = createCollaborationBridgeApi(data, workspace)
    const inflight = client.listSessions({ taskId: 'T-0072' })
    try {
      await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce())
      expect(() => operations.lock()).toThrow('current workspace')
    } finally {
      finish()
    }
    await expect(inflight).resolves.toMatchObject({ taskId: 'T-0072' })

    // Sanitized error messages never leak raw filesystem paths.
    await expect(createCollaborationBridgeApi(data, join(workspace, 'other')).listSessions({ taskId: 'T-0072' }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    await bridge.close()
    await expect(lstat(join(data, COLLABORATION_MCP_DESCRIPTOR))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('exposes the 4 collaboration MCP tools, marks peer context untrusted, and sanitizes tool errors', async () => {
    const { api, targetRef, messageId } = fakeCollaborationApi()
    const server = createSessionCollaborationMcpServer(api)
    const client = new Client({ name: 'collab-mcp-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(async () => { await client.close(); await server.close() })

    const { tools } = await client.listTools()
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ['tc_sessions_list', true],
      ['tc_sessions_context', true],
      ['tc_messages_send', false],
      ['tc_messages_status', true],
    ])

    const listResult = await client.callTool({ name: 'tc_sessions_list', arguments: { taskId: 'T-0072' } })
    expect(listResult.isError).toBe(false)
    expect(listResult.structuredContent).toMatchObject({
      result: { taskId: 'T-0072', sessions: [{ targetRef }] },
    })

    const contextResult = await client.callTool({ name: 'tc_sessions_context', arguments: { targetRef, limit: 3 } })
    expect(contextResult.isError).toBe(false)
    expect(contextResult.structuredContent).toMatchObject({
      untrustedContent: true,
      result: { taskId: 'T-0072', targetRef },
    })

    const sendResult = await client.callTool({
      name: 'tc_messages_send',
      arguments: { targetRef, messageId, text: 'Please run targeted tests on commit abc123.' },
    })
    expect(sendResult.isError).toBe(false)
    expect(sendResult.structuredContent).toMatchObject({
      result: { messageId, state: 'delivered', turnStatus: 'completed' },
    })

    const statusResult = await client.callTool({ name: 'tc_messages_status', arguments: { messageId } })
    expect(statusResult.isError).toBe(false)
    expect(statusResult.structuredContent).toMatchObject({
      result: { messageId, state: 'delivered' },
    })

    const invalidResult = await client.callTool({
      name: 'tc_messages_send',
      arguments: { targetRef: 'ssh://evil.example/raw', messageId, text: 'bad target' },
    })
    expect(invalidResult.isError).toBe(true)
    expect(invalidResult.structuredContent).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    })
  })

  it('bundles taskcontinuum-collab-mcp.cjs, serves all 4 tools over stdio, and fails closed without TASKCONTINUUM_WORKSPACE', async () => {
    const { data, workspace, targetRef, messageId } = await createTempFixture()
    await execute(process.execPath, [resolve('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.cli.config.ts'], { maxBuffer: 1024 * 1024 })
    const entry = resolve('out/cli/taskcontinuum-collab-mcp.cjs')

    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      stderr: 'pipe',
      env: { ELECTRON_RUN_AS_NODE: '1', TASKCONTINUUM_DATA_DIR: data, TASKCONTINUUM_WORKSPACE: workspace },
    })
    let stderr = ''
    stdioTransport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const stdioClient = new Client({ name: 'collab-stdio-test', version: '1.0.0' })
    cleanups.push(() => stdioClient.close())
    await stdioClient.connect(stdioTransport)
    expect((await stdioClient.listTools()).tools).toHaveLength(4)
    expect(await stdioClient.callTool({ name: 'tc_sessions_list', arguments: { taskId: 'T-0072' } })).toMatchObject({
      isError: false,
      structuredContent: { result: { taskId: 'T-0072', sessions: [{ targetRef }] } },
    })
    expect(await stdioClient.callTool({ name: 'tc_messages_status', arguments: { messageId } })).toMatchObject({
      isError: false,
      structuredContent: { result: { messageId, state: 'delivered' } },
    })
    expect(stderr).toBe('')

    const badEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete badEnv.TASKCONTINUUM_WORKSPACE
    const failed = await execute(process.execPath, [entry], { env: badEnv, windowsHide: true, timeout: 15_000 })
      .then(() => null, (error: { code?: number; stderr?: string; stdout?: string }) => error)
    expect(failed).not.toBeNull()
    expect(failed?.code).toBe(1)
    expect(failed?.stdout).toBe('')
    expect(failed?.stderr).toContain('Configure TASKCONTINUUM_WORKSPACE as an absolute path')
  }, 90_000)
})
