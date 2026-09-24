import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import { agentHostKey, agentHostTerminalIdSchema } from './agentHostProtocol'
import { FileTransferError } from '../shared/fileTransfer'

const DIRECTORY = 'agent-host-diagnostics'
const ACTIVE_FILE = 'agent-host.jsonl'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_QUEUED = 1024
const MAX_CAPTURE_BYTES = 3 * MAX_FILE_BYTES
export const AGENT_HOST_TRACE_HEADER = 'x-taskcontinuum-ahp-trace'

export interface AgentHostDiagnosticCapture {
  jsonl: Buffer
  capturedAt: string
  loggingEnabled: true
  truncated: boolean
  recordCount: number
}

// Revalidate disk records: even an older or externally edited log must not export
// arbitrary fields, error messages, endpoint tokens, or identifiers.
const captureRecordSchema = z.object({
  schemaVersion: z.literal(1), timeUtc: z.iso.datetime(), processId: z.number().int().nonnegative(),
  runId: z.uuid(),
  event: z.enum([
    'diagnostics.started', 'diagnostics.dropped', 'ipc.models', 'device.identity', 'device.transport',
    'connection.open', 'connection.subscribe', 'connection.models', 'connection.heartbeat',
    'connection.stream', 'connection.send', 'connection.offline', 'connection.retry', 'connection.close',
    'gateway.upgrade', 'gateway.request', 'gateway.models', 'gateway.socket',
  ]),
  targetHash: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  ownerHash: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  traceId: z.uuid().optional(), parentTraceId: z.uuid().optional(),
  status: z.enum(['begin', 'ok', 'error', 'closed', 'scheduled']).optional(),
  step: z.enum(['load', 'transport', 'initialize', 'identity', 'session', 'chat', 'terminal', 'root',
    'reconcile', 'authorization', 'workspace-recovery', 'tunnel', 'websocket', 'native', 'queue',
    'response', 'heartbeat', 'validation', 'models', 'snapshot', 'ledger', 'dispatch', 'confirmation']).optional(),
  reason: z.enum(['heartbeat-failed', 'transport-closed', 'stream-ended', 'stream-error', 'access-changed',
    'owner-offline', 'backpressure', 'queue-limit', 'client-closed', 'invalid-frame', 'shutdown', 'auth-required']).optional(),
  method: z.enum(['initialize', 'reconnect', 'ping', 'subscribe', 'unsubscribe', 'dispatchAction', 'other']).optional(),
  channel: z.enum(['root', 'session', 'chat', 'terminal', 'other']).optional(),
  elapsedMs: z.number().int().min(0).max(1e9).optional(),
  queueMs: z.number().int().min(0).max(1e9).optional(),
  authMs: z.number().int().min(0).max(1e9).optional(),
  pending: z.number().int().min(0).max(1e9).optional(),
  count: z.number().int().min(0).max(1e9).optional(),
  attempt: z.number().int().min(0).max(1e9).optional(),
  retryMs: z.number().int().min(0).max(1e9).optional(),
  closeCode: z.number().int().min(0).max(1e9).optional(),
  timeoutMs: z.number().int().min(0).max(1e9).optional(),
  rpcCode: z.number().int().min(-32768).max(32767).optional(),
  dispatched: z.boolean().optional(),
  errorKind: z.enum(['unknown', 'timeout', 'rpc-error', 'transport-closed', 'transport-io', 'transport-protocol',
    'transport-other', 'aborted', 'invalid-data', 'client-closed', 'ECONNRESET', 'ECONNREFUSED',
    'ETIMEDOUT', 'EPIPE', 'EACCES', 'other']).optional(),
  errorMethod: z.enum(['initialize', 'reconnect', 'ping', 'subscribe', 'unsubscribe', 'dispatchAction', 'other']).optional(),
})

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

  async capture(userData: string, signal: AbortSignal): Promise<{ parts: Buffer[]; truncated: boolean; capturedAt: string }> {
    if (resolve(userData, DIRECTORY) !== resolve(this.directory) || this.closed) {
      throw new FileTransferError('LOGS_DISABLED', 'Agent Host diagnostic logging is not enabled.')
    }
    // Only bounded disk reads occupy the writer queue. Parsing, filtering and
    // transfer authorization happen outside it, so a slow client cannot pause logging.
    const capture = this.pending.then(async () => {
      signal.throwIfAborted()
      const parts: Buffer[] = []
      let truncated = false
      let found = false
      try {
        const directory = await lstat(this.directory)
        const canonical = await realpath(this.directory)
        const expected = resolve(this.directory)
        if (!directory.isDirectory() || directory.isSymbolicLink()
          || (process.platform === 'win32' ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected)) {
          throw new Error('Unsafe diagnostic directory.')
        }
        for (const name of ['agent-host.2.jsonl', 'agent-host.1.jsonl', ACTIVE_FILE]) {
          signal.throwIfAborted()
          const file = join(this.directory, name)
          const before = await lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
          if (!before) continue
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Unsafe diagnostic file.')
          found = true
          if (name === 'agent-host.2.jsonl') truncated = true
          const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
          try {
            const opened = await handle.stat({ bigint: true })
            if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Diagnostic file changed.')
            const limit = Math.min(Number(before.size), MAX_FILE_BYTES)
            if (before.size > BigInt(limit)) truncated = true
            const chunks: Buffer[] = []
            for (let offset = 0; offset < limit;) {
              signal.throwIfAborted()
              const buffer = Buffer.alloc(Math.min(256 * 1024, limit - offset))
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
              if (!bytesRead) throw new Error('Diagnostic file changed.')
              chunks.push(buffer.subarray(0, bytesRead))
              offset += bytesRead
            }
            const after = await handle.stat({ bigint: true })
            const pathAfter = await lstat(file, { bigint: true })
            if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
              || (process.platform !== 'win32' && after.ctimeNs !== before.ctimeNs)
              || after.nlink !== 1n || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || pathAfter.isSymbolicLink()) {
              throw new Error('Diagnostic file changed.')
            }
            parts.push(Buffer.concat(chunks))
          } finally { await handle.close() }
        }
        if (!found) throw new Error('Missing diagnostic files.')
        return { parts, truncated, capturedAt: new Date().toISOString() }
      } catch {
        if (signal.aborted) throw new FileTransferError('CANCELLED', 'File transfer was cancelled.')
        throw new FileTransferError('LOGS_MISSING', 'Agent Host diagnostic logs are missing or unavailable.')
      }
    })
    this.pending = capture.then(() => {}, () => {})
    return capture
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

export async function captureAgentHostDiagnostics(
  userData: string,
  range: { sinceUtc?: string; untilUtc?: string },
  signal: AbortSignal,
): Promise<AgentHostDiagnosticCapture> {
  const log = active
  if (!log) throw new FileTransferError('LOGS_DISABLED', 'Agent Host diagnostic logging is not enabled.')
  const snapshot = await log.capture(userData, signal)
  const since = range.sinceUtc ? Date.parse(range.sinceUtc) : -Infinity
  const until = range.untilUtc ? Date.parse(range.untilUtc) : Infinity
  const lines: Buffer[] = []
  let bytes = 0
  let truncated = snapshot.truncated
  for (const part of snapshot.parts) {
    const text = part.toString('utf8')
    if (text && !text.endsWith('\n')) truncated = true
    for (const line of text.split('\n').slice(0, -1)) {
      signal.throwIfAborted()
      if (!line) continue
      try {
        const record = captureRecordSchema.safeParse(JSON.parse(line))
        if (!record.success) { truncated = true; continue }
        const timestamp = Date.parse(record.data.timeUtc)
        if (timestamp < since || timestamp > until) continue
        const output = Buffer.from(JSON.stringify(record.data) + '\n')
        if (bytes + output.length > MAX_CAPTURE_BYTES) { truncated = true; continue }
        bytes += output.length
        lines.push(output)
      } catch { truncated = true }
    }
  }
  if (active !== log) throw new FileTransferError('LOGS_DISABLED', 'Agent Host diagnostic logging is not enabled.')
  if (!lines.length) throw new FileTransferError('NO_RECORDS', 'No diagnostic records match the requested range.')
  return { jsonl: Buffer.concat(lines), capturedAt: snapshot.capturedAt, loggingEnabled: true, truncated, recordCount: lines.length }
}

export async function stopAgentHostDiagnostics(): Promise<void> {
  const log = active
  active = undefined
  await log?.close()
}
