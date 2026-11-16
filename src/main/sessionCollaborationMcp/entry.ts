import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCollaborationBridgeApi } from './client'
import { defaultDataDirectory } from './descriptor'
import { createSessionCollaborationMcpServer } from './server'

async function main(): Promise<void> {
  if (!process.env.TASKCONTINUUM_WORKSPACE || process.argv.length !== 2) throw new Error('Invalid MCP configuration')
  const api = createCollaborationBridgeApi(defaultDataDirectory(), process.env.TASKCONTINUUM_WORKSPACE)
  const server = createSessionCollaborationMcpServer(api)
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 })
  server.onerror = () => {}
  process.stdin.once('end', () => { void server.close() })
  await server.connect(transport)
}

void main().catch(() => {
  process.stderr.write('Task Continuum collaboration MCP could not start. Configure TASKCONTINUUM_WORKSPACE as an absolute path and start without command arguments.\n')
  process.exitCode = 1
})
