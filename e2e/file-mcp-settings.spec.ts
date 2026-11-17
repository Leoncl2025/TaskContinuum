import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron as electron, expect, test } from '@playwright/test'
import { z } from 'zod'
import { deliveryInboxSchema } from '../src/shared/fileDelivery'

test('Preferences authorizes an MCP save directory and exposes that exact grant through the running desktop stdio adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-mcp-preferences-'))
  const workspace = join(root, 'workspace'), profile = join(root, 'profile'), destination = join(root, 'received')
  await Promise.all([mkdir(join(workspace, '.agentdesk'), { recursive: true }), mkdir(join(workspace, 'tasks'), { recursive: true }), mkdir(destination)])
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'MCP preferences fixture' }))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.TASKCONTINUUM_DATA_DIR = profile
  env.TASKCONTINUUM_WORKSPACE = workspace
  env.TASKCONTINUUM_MCP_FEATURES = 'delivery'
  const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  const client = new Client({ name: 'runtime-mcp-settings-e2e', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve('out', 'cli', 'taskcontinuum-files-mcp.cjs')], env, stderr: 'pipe',
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'MCP file delivery', exact: true })).toBeVisible()
    await expect(page.getByText('Local authenticated bridge', { exact: true })).toBeVisible()
    const configuration = JSON.parse(await page.getByLabel('MCP configuration').innerText())
    expect(configuration.servers['taskcontinuum-files'].env).toMatchObject({
      TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_MCP_FEATURES: 'delivery',
    })
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, destination)
    await page.getByRole('button', { name: 'Authorize save directory...' }).click()
    await expect(page.getByText(destination, { exact: false })).toBeVisible()
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('tc_files_send')
    const response = await client.callTool({ name: 'tc_files_inbox_list', arguments: {} })
    const inbox = z.object({ result: deliveryInboxSchema }).parse(response.structuredContent).result
    expect(inbox.transfers).toEqual([])
    expect(inbox.destinations).toHaveLength(1)
    expect(inbox.destinations[0].label).toBe('received')
    await page.getByRole('button', { name: 'Revoke directory' }).click()
    await expect(page.getByRole('button', { name: 'Revoke directory' })).toHaveCount(0)
    const revoked = await client.callTool({ name: 'tc_files_inbox_list', arguments: {} })
    expect(z.object({ result: deliveryInboxSchema }).parse(revoked.structuredContent).result.destinations).toEqual([])
  } finally {
    await client.close()
    await transport.close()
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
