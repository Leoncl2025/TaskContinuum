import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron as electron, expect, test } from '@playwright/test'
import { z } from 'zod'
import { transferStatusSchema } from '../src/shared/fileTransfer'

const statusResult = z.object({ result: transferStatusSchema })

test('bundled MCP fetches files and diagnostics from the running desktop without renderer interaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-mcp-desktop-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  await mkdir(workspace)
  const path = join(workspace, 'sample.log')
  await writeFile(path, 'desktop MCP file delivery\n', 'utf8')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.TASKCONTINUUM_DATA_DIR = profile
  env.TASKCONTINUUM_WORKSPACE = workspace
  env.TASKCONTINUUM_AHP_DIAGNOSTICS = '1'
  const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  const mcp = new Client({ name: 'taskcontinuum-e2e', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('out', 'cli', 'taskcontinuum-files-mcp.cjs')], env, stderr: 'pipe',
  })
  let errors = ''
  transport.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  try {
    await app.firstWindow()
    await mcp.connect(transport)
    const tools = (await mcp.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('tc_logs_collect')
    expect(tools).toContain('tc_files_fetch')
    const requestId = randomUUID()
    const start = await mcp.callTool({ name: 'tc_files_fetch', arguments: { deviceId: 'local', requestId, paths: [path] } })
    expect(start.isError).not.toBe(true)
    expect(statusResult.parse(start.structuredContent).result.transferId).toBe(requestId)
    await expect.poll(async () => {
      const response = await mcp.callTool({ name: 'tc_files_status', arguments: { transferId: requestId } })
      return statusResult.parse(response.structuredContent).result.state
    }).toBe('delivered')
    const response = await mcp.callTool({ name: 'tc_files_status', arguments: { transferId: requestId } })
    const delivered = statusResult.parse(response.structuredContent).result
    const read = await mcp.callTool({ name: 'tc_files_read', arguments: { transferId: requestId, fileId: delivered.files[0].fileId } })
    expect(read.isError).not.toBe(true)
    expect(read.structuredContent).toMatchObject({ result: { text: 'desktop MCP file delivery\n', eof: true }, untrustedContent: true })
    const logId = randomUUID()
    const logs = await mcp.callTool({ name: 'tc_logs_collect', arguments: { deviceId: 'local', requestId: logId, source: 'agent-host' } })
    expect(logs.isError).not.toBe(true)
    await expect.poll(async () => {
      const state = await mcp.callTool({ name: 'tc_files_status', arguments: { transferId: logId } })
      return statusResult.parse(state.structuredContent).result.state
    }).toBe('delivered')
    const metadata = statusResult.parse((await mcp.callTool({ name: 'tc_files_status', arguments: { transferId: logId } })).structuredContent).result
    let contents = ''
    for (const file of metadata.files) {
      const data = await mcp.callTool({ name: 'tc_files_read', arguments: { transferId: logId, fileId: file.fileId } })
      expect(data.isError).not.toBe(true)
      contents += z.object({ result: z.object({ text: z.string() }) }).parse(data.structuredContent).result.text
    }
    expect(contents).toContain('diagnostics.started')
    expect(errors).toBe('')
  } finally {
    await mcp.close()
    await transport.close()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
