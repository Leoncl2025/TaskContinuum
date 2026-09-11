import { lstat, readdir } from 'node:fs/promises'
import { connect as connectSocket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client'
import { readJsonBounded } from './shared/storage'
import { agentHostEndpointSchema } from './agentHostProtocol'
import type { AgentHostEndpoint } from './agentHostProtocol'

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
  const socket = new WebSocket(url, { ...options, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000, followRedirects: false, perMessageDeflate: false })
  const transport = new BoundedAgentHostTransport(socket, signal)
  await new Promise<void>((resolve, reject) => {
    const failed = () => { cleanup(); reject(new Error('Agent Host connection failed or access was rejected.')) }
    const opened = () => { cleanup(); resolve() }
    const cleanup = () => { socket.off('open', opened); socket.off('error', failed); socket.off('close', failed) }
    socket.once('open', opened).once('error', failed).once('close', failed)
  }).catch(async (error: unknown) => { await transport.close(); throw error })
  signal.throwIfAborted()
  return transport
}

class BoundedAgentHostTransport implements AhpTransport {
  private queue: string[] = []
  private bytes = 0
  private closed = false
  private failure?: Error
  private waiting?: { resolve(value: TransportFrame | null): void; reject(error: Error): void }
  private readonly abort = () => { this.finish(new Error('Agent Host connection was cancelled.')); this.socket.terminate() }

  constructor(private readonly socket: WebSocket, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.abort, { once: true })
    socket.on('error', () => this.finish(new Error('Agent Host transport failed. No execution was replayed.')))
    socket.on('close', () => this.finish())
    socket.on('message', (data, binary) => {
      if (this.closed) return
      const text = data.toString()
      if (binary || this.queue.length >= 1024 || this.bytes + Buffer.byteLength(text) > 16 * 1024 * 1024) {
        this.finish(new Error('Agent Host stream exceeded its buffer. Reconnect for a fresh snapshot.'))
        socket.terminate()
        return
      }
      if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ kind: 'text', text }) }
      else { this.queue.push(text); this.bytes += Buffer.byteLength(text) }
    })
  }

  send(message: JsonRpcMessage | string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw this.failure ?? new Error('Agent Host is disconnected.')
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    if (this.socket.bufferedAmount + Buffer.byteLength(text) > 16 * 1024 * 1024) { this.abort(); throw new Error('Agent Host send buffer is full. No automatic retry.') }
    this.socket.send(text, (error) => { if (error) this.abort() })
  }

  recv(): Promise<TransportFrame | null> {
    if (this.failure) return Promise.reject(this.failure)
    const text = this.queue.shift()
    if (text !== undefined) { this.bytes -= Buffer.byteLength(text); return Promise.resolve({ kind: 'text', text }) }
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