import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import { agentHostKey, agentHostTerminalIdSchema } from './agentHostProtocol'

const DIRECTORY = 'agent-host-diagnostics'
const ACTIVE_FILE = 'agent-host.jsonl'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_QUEUED = 1024
export const AGENT_HOST_TRACE_HEADER = 'x-taskcontinuum-ahp-trace'

export type AgentHostDiagnosticEvent =
  | 'diagnostics.started' | 'diagnostics.dropped'
  | 'ipc.models' | 'device.identity' | 'device.transport'
  | 'connection.open' | 'connection.subscribe' | 'connection.models' | 'connection.heartbeat'
  | 'connection.stream' | 'connection.send' | 'connection.offline' | 'connection.retry' | 'connection.close'
  | 'gateway.upgrade' | 'gateway.request' | 'gateway.models' | 'gateway.socket'
type Status = 'begin' | 'ok' | 'error' | 'closed' | 'scheduled'
type Step = 'load' | 'transport' | 'initialize' | 'identity' | 'session' | 'chat' | 'terminal' | 'root'
  | 'reconcile' | 'authorization' | 'workspace-recovery' | 'tunnel' | 'websocket'
  | 'native' | 'queue' | 'response' | 'heartbeat' | 'validation' | 'models'
  | 'snapshot' | 'ledger' | 'dispatch' | 'confirmation'
type Reason = 'heartbeat-failed' | 'transport-closed' | 'stream-ended' | 'stream-error'
  | 'access-changed' | 'owner-offline' | 'backpressure' | 'queue-limit' | 'client-closed'
  | 'invalid-frame' | 'shutdown' | 'auth-required'
type Method = 'initialize' | 'reconnect' | 'ping' | 'subscribe' | 'unsubscribe' | 'dispatchAction' | 'other'
type Channel = 'root' | 'session' | 'chat' | 'terminal' | 'other'

export interface AgentHostDiagnosticDetails {
  target?: AgentHostTarget
  ownerId?: string
  traceId?: string
  parentTraceId?: string
  status?: Status
  step?: Step
  reason?: Reason
  method?: Method
  channel?: Channel
  elapsedMs?: number
  queueMs?: number
  authMs?: number
  pending?: number
  count?: number
  attempt?: number
  retryMs?: number
  closeCode?: number
  dispatched?: boolean
  error?: unknown
}

function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16) }
function safeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1e9 ? Math.round(value) : undefined
}
function safeUuid(value: string | undefined): string | undefined {
  return value && z.uuid().safeParse(value).success ? value : undefined
}
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  if (error.name === 'RpcTimeoutError' || error.name === 'TimeoutError') return 'timeout'
  if (error.name === 'RpcError') return 'rpc-error'
  if (error.name === 'TransportError') {
    const kind = (error as Error & { kind?: unknown }).kind
    if (kind === 'closed' || kind === 'io' || kind === 'protocol') return `transport-${kind}`
    return 'transport-other'
  }
  if (error.name === 'AbortError') return 'aborted'
  if (error.name === 'ZodError') return 'invalid-data'
  if (error.name === 'ClientClosedError') return 'client-closed'
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'EACCES') return code
  return 'other'
}

export function agentHostDiagnosticMethod(value: unknown): Method {
  return value === 'initialize' || value === 'reconnect' || value === 'ping' || value === 'subscribe'
    || value === 'unsubscribe' || value === 'dispatchAction' ? value : 'other'
}

export function agentHostDiagnosticChannel(value: unknown, target: AgentHostTarget): Channel {
  if (value === 'ahp-root://') return 'root'
  if (value === target.sessionId) return 'session'
  if (value === target.chatId) return 'chat'
  if (typeof value === 'string' && agentHostTerminalIdSchema.safeParse(value).success) return 'terminal'
  return 'other'
}

function entry(event: AgentHostDiagnosticEvent, details: AgentHostDiagnosticDetails, runId: string): string {
  const traceId = safeUuid(details.traceId)
  const parentTraceId = safeUuid(details.parentTraceId)
  const error = details.error
  const timeout = error instanceof Error && error.name === 'RpcTimeoutError' ? safeNumber((error as Error & { timeoutMs?: number }).timeoutMs) : undefined
  const rpcCode = error instanceof Error && error.name === 'RpcError' && Number.isInteger((error as Error & { code?: number }).code)
    ? (error as Error & { code: number }).code : undefined
  const record = {
    schemaVersion: 1, timeUtc: new Date().toISOString(), processId: process.pid, runId, event,
    ...(details.target ? { targetHash: fingerprint(agentHostKey(details.target)) } : {}),
    ...(details.ownerId ? { ownerHash: fingerprint(details.ownerId) } : {}),
    ...(traceId ? { traceId } : {}),
    ...(parentTraceId ? { parentTraceId } : {}),
    ...(details.status ? { status: details.status } : {}),
    ...(details.step ? { step: details.step } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.method ? { method: details.method } : {}),
    ...(details.channel ? { channel: details.channel } : {}),
    ...(safeNumber(details.elapsedMs) !== undefined ? { elapsedMs: safeNumber(details.elapsedMs) } : {}),
    ...(safeNumber(details.queueMs) !== undefined ? { queueMs: safeNumber(details.queueMs) } : {}),
    ...(safeNumber(details.authMs) !== undefined ? { authMs: safeNumber(details.authMs) } : {}),
    ...(safeNumber(details.pending) !== undefined ? { pending: safeNumber(details.pending) } : {}),
    ...(safeNumber(details.count) !== undefined ? { count: safeNumber(details.count) } : {}),
    ...(safeNumber(details.attempt) !== undefined ? { attempt: safeNumber(details.attempt) } : {}),
    ...(safeNumber(details.retryMs) !== undefined ? { retryMs: safeNumber(details.retryMs) } : {}),
    ...(safeNumber(details.closeCode) !== undefined ? { closeCode: safeNumber(details.closeCode) } : {}),
    ...(details.dispatched !== undefined ? { dispatched: details.dispatched === true } : {}),
    ...(error !== undefined ? { errorKind: errorKind(error) } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    ...(rpcCode !== undefined && rpcCode >= -32768 && rpcCode <= 32767 ? { rpcCode } : {}),
    ...(error instanceof Error && error.name === 'RpcTimeoutError'
      ? { errorMethod: agentHostDiagnosticMethod((error as Error & { method?: unknown }).method) } : {}),
  }
  return JSON.stringify(record) + '\n'
}

async function safeFile(file: string, maxFileBytes: number): Promise<void> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Agent Host diagnostic file is not a private regular file.')
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Agent Host diagnostic file permissions are not private.')
    if (info.size > maxFileBytes) throw new Error('Agent Host diagnostic file exceeds the size limit.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

class AgentHostDiagnosticLog {
  private readonly runId = randomUUID()
  private readonly directory: string
  private readonly maxFileBytes: number
  private handle?: FileHandle
  private size = 0
  private pending: Promise<void> = Promise.resolve()
  private queued = 0
  private dropped = 0
  private failure?: Error
  private closed = false

  private constructor(userData: string, maxFileBytes: number) {
    this.directory = join(userData, DIRECTORY)
    this.maxFileBytes = maxFileBytes
  }

  static async start(userData: string, maxFileBytes = MAX_FILE_BYTES): Promise<AgentHostDiagnosticLog> {
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 512) throw new Error('Invalid Agent Host diagnostic size limit.')
    const log = new AgentHostDiagnosticLog(userData, maxFileBytes)
    await mkdir(log.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(log.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Agent Host diagnostic directory is not private.')
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Agent Host diagnostic directory permissions are not private.')
    await Promise.all(['agent-host.1.jsonl', 'agent-host.2.jsonl'].map((name) => safeFile(join(log.directory, name), maxFileBytes)))
    await log.open()
    log.record('diagnostics.started', { status: 'ok' })
    try { await log.flush() } catch (error) { await log.handle?.close(); throw error }
    return log
  }

  private async open(): Promise<void> {
    const file = join(this.directory, ACTIVE_FILE)
    await safeFile(file, this.maxFileBytes)
    const handle = await open(file, 'a', 0o600)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1) throw new Error('Agent Host diagnostic file is not a private regular file.')
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Agent Host diagnostic file permissions are not private.')
      if (info.size > this.maxFileBytes) throw new Error('Agent Host diagnostic file exceeds the size limit.')
      this.handle = handle
      this.size = info.size
    } catch (error) { await handle.close(); throw error }
  }

  private async rotate(): Promise<void> {
    await this.handle!.close()
    this.handle = undefined
    for (const name of [ACTIVE_FILE, 'agent-host.1.jsonl', 'agent-host.2.jsonl']) await safeFile(join(this.directory, name), this.maxFileBytes)
    await rm(join(this.directory, 'agent-host.2.jsonl'), { force: true })
    try { await rename(join(this.directory, 'agent-host.1.jsonl'), join(this.directory, 'agent-host.2.jsonl')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(join(this.directory, ACTIVE_FILE), join(this.directory, 'agent-host.1.jsonl'))
    await this.open()
  }

  private async write(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line)
    if (bytes > this.maxFileBytes) throw new Error('Agent Host diagnostic entry exceeds the size limit.')
    if (this.size + bytes > this.maxFileBytes) await this.rotate()
    await this.handle!.writeFile(line, 'utf8')
    this.size += bytes
  }

  record(event: AgentHostDiagnosticEvent, details: AgentHostDiagnosticDetails): void {
    if (this.closed || this.failure) return
    if (this.queued >= MAX_QUEUED) {
      if (++this.dropped === 1) console.error('Agent Host diagnostic logging is overloaded; events were dropped.')
      return
    }
    const line = entry(event, details, this.runId)
    this.queued++
    this.pending = this.pending.then(async () => {
      if (this.dropped) {
        const dropped = this.dropped
        this.dropped = 0
        await this.write(entry('diagnostics.dropped', { count: dropped }, this.runId))
      }
      await this.write(line)
    }).catch((error: unknown) => { this.fail(error) }).finally(() => { this.queued-- })
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = error instanceof Error ? error : new Error('Diagnostic logging failed.')
    console.error('Agent Host diagnostic logging failed:', errorKind(error))
  }

  async flush(): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.failure) return
      if (this.dropped) {
        const dropped = this.dropped
        this.dropped = 0
        await this.write(entry('diagnostics.dropped', { count: dropped }, this.runId))
      }
      await this.handle?.sync()
    }).catch((error: unknown) => { this.fail(error) })
    await this.pending
    if (this.failure) throw new Error('Agent Host diagnostic logging failed.', { cause: this.failure })
  }

  async close(): Promise<void> {
    this.closed = true
    try { await this.flush() } finally { await this.handle?.close() }
  }
}

let active: AgentHostDiagnosticLog | undefined

export async function startAgentHostDiagnostics(userData: string, maxFileBytes?: number): Promise<void> {
  if (active) throw new Error('Agent Host diagnostics are already running.')
  active = await AgentHostDiagnosticLog.start(userData, maxFileBytes)
}

export function logAgentHostDiagnostic(event: AgentHostDiagnosticEvent, details: AgentHostDiagnosticDetails = {}): void {
  active?.record(event, details)
}

export async function flushAgentHostDiagnostics(): Promise<void> { await active?.flush() }

export async function stopAgentHostDiagnostics(): Promise<void> {
  const log = active
  active = undefined
  await log?.close()
}
