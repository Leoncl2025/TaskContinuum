import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { basename } from 'node:path'
import { createCollaborationBridgeApi } from './client'
import { defaultDataDirectory } from './descriptor'
import { createTaskContinuumMcpServer } from './server'

async function main(): Promise<void> {
  if (!process.env.TASKCONTINUUM_WORKSPACE || process.argv.length !== 2) throw new Error('Invalid MCP configuration')
  const collaboration = createCollaborationBridgeApi(defaultDataDirectory(), process.env.TASKCONTINUUM_WORKSPACE)
  const server = createTaskContinuumMcpServer({ collaboration }, basename(process.argv[1]) === 'taskcontinuum-collab-mcp.cjs')
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 })
  server.onerror = () => {}
  process.stdin.once('end', () => { void server.close() })
  await server.connect(transport)
}

void main().catch(() => {
  process.stderr.write('TaskContinuum MCP could not start. Configure TASKCONTINUUM_WORKSPACE as an absolute path and start without command arguments.\n')
  process.exitCode = 1
})
