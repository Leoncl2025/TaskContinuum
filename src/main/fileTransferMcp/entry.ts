import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createBridgeApi } from './client'
import { defaultDataDirectory } from './descriptor'
import { createFileTransferMcpServer } from './server'

async function main(): Promise<void> {
  if (!process.env.TASKCONTINUUM_WORKSPACE || process.argv.length !== 2) throw new Error('Invalid MCP configuration')
  const api = createBridgeApi(defaultDataDirectory(), process.env.TASKCONTINUUM_WORKSPACE)
  const server = createFileTransferMcpServer(api)
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 })
  server.onerror = () => {}
  process.stdin.once('end', () => { void server.close() })
  await server.connect(transport)
}

void main().catch(() => {
  process.stderr.write('Task Continuum file MCP could not start. Configure TASKCONTINUUM_WORKSPACE as an absolute path and start without command arguments.\n')
  process.exitCode = 1
})
