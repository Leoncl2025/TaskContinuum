import { lstat, readdir } from 'node:fs/promises'
import { connect as connectSocket } from 'node:net'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isAbsolute, join } from 'node:path'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client'
import { readJsonBounded } from './shared/storage'
import { agentHostEndpointSchema } from './agentHostProtocol'
import type { AgentHostEndpoint } from './agentHostProtocol'
import { AGENT_HOST_LIMIT_HEADER, AGENT_HOST_LIMITS, AgentHostSizeLimitError, decodeAgentHostSizeLimit } from './agentHostLimits'

export async function discoverAgentHosts(directories: string[]): Promise<AgentHostEndpoint[]> {
  const found = new Map<string, AgentHostEndpoint>()
  const ambiguous = new Set<string>()
  for (const directory of directories) {
    const info = await lstat(directory).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.slice(0, 128)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const file = join(directory, entry.name)
        const info = await lstat(file)
        if (info.isSymbolicLink() || info.nlink !== 1) continue
        const endpoint = agentHostEndpointSchema.parse(await readJsonBounded(file, 16384))
        process.kill(endpoint.pid, 0)
        if (endpoint.endpoint.type === 'socket') validateSocketPath(endpoint.endpoint.path)
        if (found.has(endpoint.instanceId)) { found.delete(endpoint.instanceId); ambiguous.add(endpoint.instanceId) }
        if (ambiguous.has(endpoint.instanceId)) continue
        found.set(endpoint.instanceId, endpoint)
      } catch { continue }
    }
  }
  return [...found.values()]
}

function validateSocketPath(path: string): void {
  if (process.platform === 'win32' ? !path.startsWith('\\\\.\\pipe\\') : !isAbsolute(path)) throw new Error('Agent Host socket must be local.')
}

export function connectLocalAgentHost(endpoint: AgentHostEndpoint, signal: AbortSignal): Promise<AhpTransport> {
  const checked = agentHostEndpointSchema.parse(endpoint)
  const query = `/?tkn=${encodeURIComponent(checked.connectionToken)}`
  if (checked.endpoint.type === 'tcp') {
    const host = checked.endpoint.host === '::1' ? '[::1]' : checked.endpoint.host
    return connectAgentHostWebSocket(`ws://${host}:${checked.endpoint.port}${query}`, {}, signal)
  }
  const path = checked.endpoint.path
  validateSocketPath(path)
  return connectAgentHostWebSocket(`ws://localhost${query}`, { createConnection: () => connectSocket(path) }, signal)
}

export async function connectAgentHostWebSocket(url: string, options: ClientOptions, signal: AbortSignal): Promise<AhpTransport> {
  signal.throwIfAborted()
  const socket = new WebSocket(url, { ...options, maxPayload: AGENT_HOST_LIMITS.messageBytes, handshakeTimeout: 10000, followRedirects: false, perMessageDeflate: false })
  const transport = new BoundedAgentHostTransport(socket, signal)
  await new Promise<void>((resolve, reject) => {
    const failed = () => { cleanup(); reject(transport.error ?? new Error('Agent Host connection failed or access was rejected.')) }
    const opened = () => { cleanup(); resolve() }
    const unexpected = (request: ClientRequest, response: IncomingMessage) => {
      const header = response.headers[AGENT_HOST_LIMIT_HEADER]
      const limit = response.statusCode === 413 && typeof header === 'string' ? decodeAgentHostSizeLimit(header) : undefined
      cleanup()
      reject(limit ?? new Error('Agent Host connection failed or access was rejected.'))
      response.resume()
      request.destroy()
      void transport.close()
    }
    const cleanup = () => { socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); socket.off('unexpected-response', unexpected) }
    socket.once('open', opened).once('error', failed).once('close', failed)
    socket.once('unexpected-response', unexpected)
  }).catch(async (error: unknown) => { await transport.close(); throw error })
  signal.throwIfAborted()
  return transport
}

class BoundedAgentHostTransport implements AhpTransport {
  private queue: { text: string; bytes: number }[] = []
  private bytes = 0
  private closed = false
  private failure?: Error
  private waiting?: { resolve(value: TransportFrame | null): void; reject(error: Error): void }
  private readonly abort = () => { this.finish(new Error('Agent Host connection was cancelled.')); this.socket.terminate() }
  get error(): Error | undefined { return this.failure }

  constructor(private readonly socket: WebSocket, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true })
    socket.on('error', (error: Error & { code?: string }) => this.finish(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
      ? new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes)
      : new Error('Agent Host transport failed. No execution was replayed.', { cause: error })))
    socket.on('close', (code, reason) => this.finish(code === 1009 ? decodeAgentHostSizeLimit(reason.toString()) : undefined))
    socket.on('message', (data, binary) => {
      if (this.closed) return
      const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength
      if (binary || this.queue.length >= AGENT_HOST_LIMITS.receiveBufferMessages || this.bytes + bytes > AGENT_HOST_LIMITS.receiveBufferBytes) {
        this.finish(binary ? new Error('Agent Host returned an unsupported binary message.')
          : this.queue.length >= AGENT_HOST_LIMITS.receiveBufferMessages ? new Error(`Agent Host receive backlog exceeds ${AGENT_HOST_LIMITS.receiveBufferMessages} messages. No execution was replayed.`)
            : new AgentHostSizeLimitError('receive-buffer', AGENT_HOST_LIMITS.receiveBufferBytes, this.bytes + bytes))
        socket.terminate()
        return
      }
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8')
      if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ kind: 'text', text }) }
      else { this.queue.push({ text, bytes }); this.bytes += bytes }
    })
  }

  send(message: JsonRpcMessage | string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw this.failure ?? new Error('Agent Host is disconnected.')
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    const bytes = Buffer.byteLength(text)
    if (bytes > AGENT_HOST_LIMITS.requestBytes) throw new AgentHostSizeLimitError('request', AGENT_HOST_LIMITS.requestBytes, bytes)
    if (this.socket.bufferedAmount + bytes > AGENT_HOST_LIMITS.requestBytes) {
      const error = new AgentHostSizeLimitError('send-buffer', AGENT_HOST_LIMITS.requestBytes, this.socket.bufferedAmount + bytes)
      this.finish(error)
      this.socket.terminate()
      throw error
    }
    this.socket.send(text, (error) => { if (error) this.abort() })
  }

  recv(): Promise<TransportFrame | null> {
    if (this.failure) return Promise.reject(this.failure)
    const frame = this.queue.shift()
    if (frame !== undefined) { this.bytes -= frame.bytes; return Promise.resolve({ kind: 'text', text: frame.text }) }
    if (this.closed) return Promise.resolve(null)
    if (this.waiting) return Promise.reject(new Error('Only one Agent Host reader is permitted.'))
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject } })
  }

  private finish(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    this.queue = []
    this.bytes = 0
    this.signal.removeEventListener('abort', this.abort)
    const waiting = this.waiting
    this.waiting = undefined
    if (error) waiting?.reject(error)
    else waiting?.resolve(null)
  }

  close(): Promise<void> { this.finish(); this.socket.terminate(); return Promise.resolve() }
}