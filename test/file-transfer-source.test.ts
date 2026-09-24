// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureAgentHostDiagnostics, flushAgentHostDiagnostics, logAgentHostDiagnostic,
  startAgentHostDiagnostics, stopAgentHostDiagnostics,
} from '../src/main/agentHostDiagnostics'
import { FileTransferSource } from '../src/main/fileTransferSource'
import { FILE_TRANSFER_LIMITS as LIMITS, FileTransferError } from '../src/shared/fileTransfer'
import type { ExportManifest, ExportRequest } from '../src/shared/fileTransfer'

const authorize = async () => {}
const signal = () => new AbortController().signal
const directories: string[] = []
const services: FileTransferSource[] = []

async function fixture() {
  const directory = resolve('.runtime', `file-transfer-source-${randomUUID()}`)
  directories.push(directory)
  await mkdir(directory, { recursive: true })
  const userData = join(directory, 'user-data')
  const service = new FileTransferSource(userData, '1.2.3')
  services.push(service)
  return { directory, userData, service, exports: join(userData, 'file-transfer-exports') }
}
function request(...paths: string[]): ExportRequest {
  return { transferId: randomUUID(), selection: { kind: 'files', paths } }
}
function logs(range: { sinceUtc?: string; untilUtc?: string } = {}): ExportRequest {
  return { transferId: randomUUID(), selection: { kind: 'logs', source: 'agent-host', ...range } }
}
async function contents(service: FileTransferSource, manifest: ExportManifest, index = 0): Promise<Buffer> {
  const file = manifest.files[index]
  const chunks: Buffer[] = []
  for (let offset = 0; offset < file.sizeBytes; offset += LIMITS.chunkBytes) {
    const chunk = await service.chunk('alice', manifest.transferId, file.fileId, offset, authorize, signal())
    expect(chunk.length).toBe(Math.min(LIMITS.chunkBytes, file.sizeBytes - offset))
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function sparse(path: string, size: number) {
  const file = await open(path, 'w')
  try { await file.truncate(size) } finally { await file.close() }
}
async function seedExport(root: string, bytes: number): Promise<string> {
  const transferId = randomUUID()
  const fileId = randomUUID()
  const directory = join(root, transferId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await sparse(join(directory, `${fileId}.blob`), bytes)
  if (process.platform !== 'win32') {
    const file = await open(join(directory, `${fileId}.blob`), 'r')
    try { await file.chmod(0o600) } finally { await file.close() }
  }
  const now = Date.now()
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    principalHash: createHash('sha256').update('seed-owner').digest('hex'),
    requestHash: createHash('sha256').update('seed-request').digest('hex'),
    manifest: {
      transferId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + LIMITS.retentionMs).toISOString(),
      files: [{ fileId, name: 'seed', sizeBytes: bytes, sha256: '0'.repeat(64), mediaType: 'application/octet-stream' }],
    },
  }), { mode: 0o600 })
  return transferId
}

afterEach(async () => {
  await stopAgentHostDiagnostics()
  await Promise.all(services.splice(0).map((service) => service.close()))
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('FileTransferSource snapshots', () => {
  it('streams bounded, hashed immutable snapshots and persists owner-bound resume across restart', async () => {
    const f = await fixture()
    const path = join(f.directory, 'outside-workspace.txt')
    const data = Buffer.alloc(LIMITS.chunkBytes * 2 + 31, 'x')
    await writeFile(path, data)
    const req = request(path)
    const manifest = await f.service.prepare('alice', req, authorize, signal())
    expect(manifest.files).toEqual([expect.objectContaining({
      name: 'outside-workspace.txt', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
    })])
    expect(JSON.stringify(manifest)).not.toContain(f.directory)
    expect(Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt)).toBeLessThanOrEqual(LIMITS.retentionMs)
    await writeFile(path, 'the source has changed')
    expect((await contents(f.service, manifest)).equals(data)).toBe(true)
    expect(await f.service.prepare('alice', req, authorize, signal())).toEqual(manifest)
    manifest.files[0].name = 'caller-mutation'
    expect((await f.service.prepare('alice', req, authorize, signal())).files[0].name).toBe('outside-workspace.txt')
    await f.service.close()
    const restarted = new FileTransferSource(f.userData, '2.0.0')
    services.push(restarted)
    const resumed = await restarted.prepare('alice', req, authorize, signal())
    expect(resumed.transferId).toBe(manifest.transferId)
    expect((await contents(restarted, resumed)).equals(data)).toBe(true)
    expect(await restarted.chunk('alice', req.transferId, resumed.files[0].fileId, data.length, authorize, signal())).toEqual(Buffer.alloc(0))
    const metadata = await readFile(join(f.exports, req.transferId, 'manifest.json'), 'utf8')
    expect(metadata).not.toContain(path)
    expect(metadata).not.toContain('alice')
  }, 15_000)

  it('enforces authorization and principal/selection binding for prepare, chunk and release', async () => {
    const f = await fixture()
    const path = join(f.directory, 'private.txt')
    await writeFile(path, 'private data')
    const req = request(path)
    const denied = async () => { throw new Error(`secret-token ${path}`) }
    await expect(f.service.prepare('alice', req, denied, signal())).rejects.toMatchObject({
      code: 'ACCESS_DENIED', message: 'Access to this file transfer is denied.',
    })
    const manifest = await f.service.prepare('alice', req, authorize, signal())
    await expect(f.service.prepare('bob', req, authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(f.service.prepare('alice', { ...req, selection: { kind: 'files', paths: [join(f.directory, 'other')] } }, authorize, signal()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.service.chunk('bob', req.transferId, manifest.files[0].fileId, 0, authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(f.service.release('bob', req.transferId, authorize)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(f.service.release('alice', req.transferId, denied)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await contents(f.service, manifest)).toString()).toBe('private data')
    await f.service.release('alice', req.transferId, authorize)
    await f.service.release('alice', req.transferId, authorize)
    expect(await readdir(f.exports)).toEqual([])
  })

  it('never returns chunk data after revocation or cancellation', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'private')
    const manifest = await f.service.prepare('alice', request(path), authorize, signal())
    let calls = 0
    await expect(f.service.chunk('alice', manifest.transferId, manifest.files[0].fileId, 0, async () => {
      if (++calls === 4) throw new FileTransferError('IO_ERROR', path)
    }, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const abort = new AbortController()
    calls = 0
    await expect(f.service.chunk('alice', manifest.transferId, manifest.files[0].fileId, 0, async () => {
      if (++calls === 4) abort.abort()
    }, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(f.service.prepare('alice', request(path), authorize, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('rejects malformed identifiers, offsets, counts and sanitized OS failures', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, '')
    await expect(f.service.prepare('alice', { ...request(path), transferId: '../outside' }, authorize, signal())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.service.prepare('alice', request(...Array<string>(11).fill(path)), authorize, signal())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.service.prepare('alice', request(join(f.directory, 'missing-secret')), authorize, signal())).rejects.toMatchObject({
      code: 'NOT_FOUND', message: 'The file transfer or requested file is unavailable.',
    })
    const manifest = await f.service.prepare('alice', request(path), authorize, signal())
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1]) {
      await expect(f.service.chunk('alice', manifest.transferId, manifest.files[0].fileId, offset, authorize, signal())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(f.service.chunk('alice', manifest.transferId, randomUUID(), 0, authorize, signal())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('denies protected userData, credentials, endpoint entries and non-local/special paths', async () => {
    const f = await fixture()
    vi.stubEnv('TASKCONTINUUM_AGENT_HOST_DISCOVERY', join(f.directory, 'custom-discovery'))
    const paths = [
      join(f.userData, 'device-credentials.json'), join(f.userData, 'file-transfer-inbox', 'data'),
      join(f.userData, 'file-transfer-mcp.json'), join(f.directory, '.ssh', 'id_ed25519'),
      join(f.directory, 'Code', 'agent-host', 'local-endpoint', 'entries', 'native.json'),
      join(f.directory, 'custom-discovery', 'native.json'),
    ]
    for (const path of paths) { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, 'secret') }
    for (const path of [...paths, 'relative.txt', '\\\\server\\share\\secret', '\\\\?\\C:\\secret', '\\\\.\\pipe\\secret',
      'C:\\secret:stream', 'C:\\NUL', f.directory, join(f.directory, 'data\0')]) {
      await expect(f.service.prepare('alice', request(path), authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    }
    for (const path of paths) expect(await readFile(path, 'utf8')).toBe('secret')
  })

  it('refuses hard links and directory junction escapes without touching their targets', async () => {
    const f = await fixture()
    const path = join(f.directory, 'original')
    const hard = join(f.directory, 'hard')
    await writeFile(path, 'private')
    await link(path, hard)
    for (const linked of [path, hard]) {
      await expect(f.service.prepare('alice', request(linked), authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    }
    const target = join(f.directory, 'target')
    const alias = join(f.directory, 'alias')
    await mkdir(target)
    await writeFile(join(target, 'data'), 'private')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.service.prepare('alice', request(join(alias, 'data')), authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(await readFile(join(target, 'data'), 'utf8')).toBe('private')
  })

  it('rejects nested directory junctions into protected userData on Windows without elevation', async () => {
    const f = await fixture()
    const target = join(f.userData, 'credentials')
    await mkdir(target, { recursive: true })
    const secret = join(target, 'token.json')
    await writeFile(secret, 'private-token')
    const outside = join(f.directory, 'ordinary-files', 'nested')
    await mkdir(outside, { recursive: true })
    const junction = join(outside, 'linked-user-data')
    await symlink(f.userData, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const aliased = join(junction, 'credentials', 'token.json')
    await expect(f.service.prepare('alice', request(aliased), authorize, signal())).rejects.toMatchObject({
      code: 'ACCESS_DENIED', message: 'Access to this file transfer is denied.',
    })
    expect(await readFile(secret, 'utf8')).toBe('private-token')
    expect(await readdir(f.exports)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('refuses a final-component symlink', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    const alias = join(f.directory, 'alias')
    await writeFile(path, 'private')
    await symlink(path, alias)
    await expect(f.service.prepare('alice', request(alias), authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })

  it('detects same-size source mutation during copying and cleans partial artifacts', async () => {
    const f = await fixture()
    const path = join(f.directory, 'changing')
    await writeFile(path, Buffer.alloc(LIMITS.chunkBytes * 2, 'a'))
    const req = request(path)
    let calls = 0
    await expect(f.service.prepare('alice', req, async () => {
      if (++calls === 6) await writeFile(path, Buffer.alloc(LIMITS.chunkBytes * 2, 'b'))
    }, signal())).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    expect(await readdir(f.exports)).toEqual([])
    const recovered = await f.service.prepare('alice', req, authorize, signal())
    expect((await contents(f.service, recovered))[0]).toBe('b'.charCodeAt(0))
  })

  it('cleans failed later files and reservations, while preserving unrelated userData', async () => {
    const f = await fixture()
    const first = join(f.directory, 'first')
    const second = join(f.directory, 'second')
    await writeFile(first, Buffer.alloc(LIMITS.chunkBytes + 1))
    await writeFile(second, 'second')
    await mkdir(f.userData)
    const keep = join(f.userData, 'credentials.json')
    await writeFile(keep, 'keep')
    let calls = 0
    const req = request(first, second)
    await expect(f.service.prepare('alice', req, async () => {
      if (++calls === 6) await rm(second)
    }, signal())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await readdir(f.exports)).toEqual([])
    expect(await readFile(keep, 'utf8')).toBe('keep')
    await writeFile(second, 'restored')
    const manifest = await f.service.prepare('alice', req, authorize, signal())
    expect(manifest.files).toHaveLength(2)
  })

  it('cancels partial copies, permits retry, and close preserves completed snapshots', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, Buffer.alloc(LIMITS.chunkBytes * 2))
    const abort = new AbortController()
    let calls = 0
    const req = request(path)
    await expect(f.service.prepare('alice', req, async () => { if (++calls === 6) abort.abort() }, abort.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await readdir(f.exports)).toEqual([])
    const manifest = await f.service.prepare('alice', req, authorize, signal())
    await f.service.close()
    await expect(f.service.chunk('alice', manifest.transferId, manifest.files[0].fileId, 0, authorize, signal())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await readdir(f.exports)).toEqual([manifest.transferId])
  })

  it('close cancels even an authorization callback that has stopped responding', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const entered = deferred()
    const gate = deferred()
    const preparing = f.service.prepare('alice', request(path), async () => {
      entered.resolve()
      await gate.promise
    }, signal())
    const cancelled = expect(preparing).rejects.toMatchObject({ code: 'CANCELLED' })
    try {
      await entered.promise
      await f.service.close()
      await cancelled
    } finally { gate.resolve() }
  })

  it('close is idempotent and rolls back a prepare paused at final publication', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const req = request(path)
    const entered = deferred()
    const gate = deferred()
    const preparing = f.service.prepare('alice', req, async () => {
      const published = await readFile(join(f.exports, req.transferId, 'manifest.json')).then(() => true, () => false)
      if (published) { entered.resolve(); await gate.promise }
    }, signal())
    const cancelled = expect(preparing).rejects.toMatchObject({ code: 'CANCELLED' })
    try {
      await entered.promise
      const closing = f.service.close()
      expect(f.service.close()).toBe(closing)
      await closing
      await cancelled
      expect(await readdir(f.exports)).toEqual([])
    } finally { gate.resolve() }
    await Promise.resolve()
    expect(await readdir(f.exports)).toEqual([])
    await expect(f.service.prepare('alice', req, authorize, signal())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('fails BUSY without queueing at one operation per principal and two globally', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const gate = deferred()
    const started = deferred()
    let entered = 0
    const blocked = async () => { if (++entered === 2) started.resolve(); await gate.promise }
    const a = f.service.prepare('alice', request(path), blocked, signal())
    const b = f.service.prepare('bob', request(path), blocked, signal())
    try {
      await started.promise
      await expect(f.service.prepare('alice', request(path), authorize, signal())).rejects.toMatchObject({ code: 'BUSY' })
      await expect(f.service.prepare('charlie', request(path), authorize, signal())).rejects.toMatchObject({ code: 'BUSY' })
    } finally { gate.resolve(); await Promise.all([a, b]) }
  })

  it('bounds each file and the aggregate batch before copying', async () => {
    const f = await fixture()
    const large = join(f.directory, 'large')
    await sparse(large, LIMITS.fileBytes + 1)
    await expect(f.service.prepare('alice', request(large), authorize, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    await sparse(large, LIMITS.batchBytes / 2 + 1)
    await expect(f.service.prepare('alice', request(large, large), authorize, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(await readdir(f.exports)).toEqual([])
  })

  it('counts in-flight reservations against the persistent 500 MiB quota', async () => {
    const f = await fixture()
    for (let index = 0; index < 4; index++) await seedExport(f.exports, LIMITS.fileBytes)
    const big = join(f.directory, 'big')
    const small = join(f.directory, 'small')
    await sparse(big, LIMITS.fileBytes)
    await writeFile(small, 'x')
    const entered = deferred()
    const gate = deferred()
    const abort = new AbortController()
    let calls = 0
    const preparing = f.service.prepare('alice', request(big), async () => {
      if (++calls === 4) { entered.resolve(); await gate.promise }
    }, abort.signal)
    const cancelled = expect(preparing).rejects.toMatchObject({ code: 'CANCELLED' })
    try {
      await entered.promise
      await expect(f.service.prepare('bob', request(small), authorize, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    } finally { abort.abort(); gate.resolve(); await cancelled }
    const retry = await f.service.prepare('bob', request(small), authorize, signal())
    expect(retry.files[0].sizeBytes).toBe(1)
  })

  it('retains a failed-copy reservation if safe cleanup cannot complete', async () => {
    const f = await fixture()
    for (let index = 0; index < 4; index++) await seedExport(f.exports, LIMITS.fileBytes)
    const big = join(f.directory, 'big')
    const small = join(f.directory, 'small')
    await sparse(big, LIMITS.fileBytes)
    await writeFile(small, 'x')
    const req = request(big)
    const unrelated = join(f.exports, req.transferId, 'unrelated')
    let calls = 0
    await expect(f.service.prepare('alice', req, async () => {
      if (++calls === 6) {
        await writeFile(unrelated, 'do not remove')
        throw new Error('authorization revoked')
      }
    }, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(await readFile(unrelated, 'utf8')).toBe('do not remove')
    await expect(f.service.prepare('bob', request(small), authorize, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('caps persisted exports at 128, including across restart', async () => {
    const f = await fixture()
    for (let index = 0; index < LIMITS.transfers; index++) await seedExport(f.exports, 0)
    const path = join(f.directory, 'empty')
    await writeFile(path, '')
    await expect(f.service.prepare('alice', request(path), authorize, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(await readdir(f.exports)).toHaveLength(LIMITS.transfers)
  }, 15000)

  it('keeps a transfer ID bound to its reserving principal while preparation is in flight', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const req = request(path)
    const entered = deferred()
    const gate = deferred()
    let calls = 0
    const preparing = f.service.prepare('alice', req, async () => {
      if (++calls === 4) { entered.resolve(); await gate.promise }
    }, signal())
    try {
      await entered.promise
      await expect(f.service.prepare('bob', req, authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    } finally { gate.resolve(); await preparing }
  })

  it('expires snapshots on access and after restart, and removes only owned artifact paths', async () => {
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'keep source')
    const one = await f.service.prepare('alice', request(path), authorize, signal())
    const two = await f.service.prepare('alice', request(path), authorize, signal())
    const unknown = join(f.exports, 'not-an-export')
    await mkdir(unknown)
    await writeFile(join(unknown, 'keep'), 'keep')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + LIMITS.retentionMs + 1000)
    await expect(f.service.chunk('alice', one.transferId, one.files[0].fileId, 0, authorize, signal())).rejects.toMatchObject({ code: 'EXPIRED' })
    await f.service.close()
    const restarted = new FileTransferSource(f.userData, '1')
    services.push(restarted)
    const fresh = await restarted.prepare('alice', request(path), authorize, signal())
    expect(await readdir(f.exports)).not.toContain(two.transferId)
    expect((await contents(restarted, fresh)).toString()).toBe('keep source')
    expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('keep')
  })

  it('sweeps expired snapshots without another transfer operation and clears its unref timer on close', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const timers = vi.spyOn(globalThis, 'setInterval')
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const manifest = await f.service.prepare('alice', request(path), authorize, signal())
    const timer = timers.mock.results[0].value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    vi.setSystemTime(Date.parse(manifest.expiresAt) + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => { expect(await readdir(f.exports)).toEqual([]) })
    await f.service.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await readdir(f.exports)).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('data')
  })

  it('loads and expires persisted snapshots on its first idle sweep after restart', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const f = await fixture()
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    const manifest = await f.service.prepare('alice', request(path), authorize, signal())
    await f.service.close()
    vi.setSystemTime(Date.parse(manifest.expiresAt) + 1)
    const restarted = new FileTransferSource(f.userData, '1')
    services.push(restarted)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => { expect(await readdir(f.exports)).toEqual([]) })
    await restarted.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reenter a sweep and waits for an active sweep when closing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const f = await fixture()
    const gate = deferred()
    const initialize = vi.spyOn(f.service as unknown as { initialize(): Promise<void> }, 'initialize')
      .mockImplementation(() => gate.promise)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(initialize).toHaveBeenCalledTimes(1)
    let finished = false
    const closing = f.service.close().then(() => { finished = true })
    try {
      expect(vi.getTimerCount()).toBe(0)
      await Promise.resolve()
      expect(finished).toBe(false)
    } finally { gate.resolve() }
    await closing
    expect(finished).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('logs background cleanup failures explicitly without paths, tokens or raw errors', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const f = await fixture()
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(f.service as unknown as { initialize(): Promise<void> }, 'initialize')
      .mockRejectedValue(new Error(`secret-token ${f.directory}`))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logger).toHaveBeenCalledWith(
      'File transfer export cleanup failed. Expired snapshots remain unavailable; check file permissions and storage.',
    )
    const output = JSON.stringify(logger.mock.calls)
    expect(output).not.toContain('secret-token')
    expect(output).not.toContain(f.directory)
    await f.service.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans interrupted snapshots at startup and refuses an export-root junction', async () => {
    const f = await fixture()
    const incomplete = join(f.exports, randomUUID())
    await mkdir(incomplete, { recursive: true, mode: 0o700 })
    await writeFile(join(incomplete, `${randomUUID()}.blob`), 'partial')
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    await f.service.prepare('alice', request(path), authorize, signal())
    await expect(readdir(incomplete)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.service.close()
    await rm(f.exports, { recursive: true })
    const outside = join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'keep')
    await symlink(outside, f.exports, process.platform === 'win32' ? 'junction' : 'dir')
    const restarted = new FileTransferSource(f.userData, '1')
    services.push(restarted)
    await expect(restarted.prepare('alice', request(path), authorize, signal())).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep')
  })

  it('removes only orphaned owned artifacts when resuming a complete export', async () => {
    const f = await fixture()
    const id = await seedExport(f.exports, 0)
    const directory = join(f.exports, id)
    const orphan = join(directory, `${randomUUID()}.blob`)
    const partial = join(directory, 'manifest.partial.json')
    await sparse(orphan, LIMITS.fileBytes)
    await writeFile(partial, 'interrupted')
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    await f.service.prepare('alice', request(path), authorize, signal())
    expect(await readdir(directory)).toHaveLength(2)
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans hard-linked metadata without reading or deleting its outside target', async () => {
    const f = await fixture()
    const outside = join(f.directory, 'private-metadata')
    await writeFile(outside, 'private contents')
    const id = randomUUID()
    await mkdir(join(f.exports, id), { recursive: true, mode: 0o700 })
    await link(outside, join(f.exports, id, 'manifest.json'))
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    await f.service.prepare('alice', request(path), authorize, signal())
    expect(await readFile(outside, 'utf8')).toBe('private contents')
    await expect(readdir(join(f.exports, id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('cleans symlink metadata without touching its target', async () => {
    const f = await fixture()
    const outside = join(f.directory, 'private-metadata')
    await writeFile(outside, 'private contents')
    const id = randomUUID()
    await mkdir(join(f.exports, id), { recursive: true, mode: 0o700 })
    await symlink(outside, join(f.exports, id, 'manifest.json'))
    const path = join(f.directory, 'data')
    await writeFile(path, 'data')
    await f.service.prepare('alice', request(path), authorize, signal())
    expect(await readFile(outside, 'utf8')).toBe('private contents')
    await expect(readdir(join(f.exports, id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('stable diagnostic exports', () => {
  it('does not enable diagnostics automatically or export closed disk logs', async () => {
    const f = await fixture()
    await expect(f.service.prepare('alice', logs(), authorize, signal())).rejects.toMatchObject({ code: 'LOGS_DISABLED' })
    await startAgentHostDiagnostics(f.userData)
    await stopAgentHostDiagnostics()
    await expect(f.service.prepare('alice', logs(), authorize, signal())).rejects.toMatchObject({ code: 'LOGS_DISABLED' })
    expect(await readdir(f.exports)).toEqual([])
  })

  it('captures rotations in writer order, filters UTC ranges and emits export metadata', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await startAgentHostDiagnostics(f.userData, 768)
    for (let index = 0; index < 12; index++) {
      vi.setSystemTime(new Date(`2026-01-01T00:00:${String(index).padStart(2, '0')}Z`))
      logAgentHostDiagnostic('connection.heartbeat', { status: 'ok', count: index })
      await flushAgentHostDiagnostics()
    }
    const req = logs({ sinceUtc: '2026-01-01T00:00:08Z', untilUtc: '2026-01-01T00:00:10Z' })
    const manifest = await f.service.prepare('alice', req, authorize, signal())
    expect(manifest.files.map((file) => file.name)).toEqual(['agent-host.jsonl', 'export-metadata.json'])
    const lines = (await contents(f.service, manifest)).toString().trim().split('\n').map((line) => JSON.parse(line) as { count: number })
    expect(lines.map((line) => line.count)).toEqual([8, 9, 10])
    expect(JSON.parse((await contents(f.service, manifest, 1)).toString())).toMatchObject({
      schemaVersion: 1, appVersion: '1.2.3', loggingEnabled: true, truncated: true, recordCount: 3,
    })
    await expect(f.service.prepare('alice', logs({ sinceUtc: '2027-01-01T00:00:00Z' }), authorize, signal())).rejects.toMatchObject({ code: 'NO_RECORDS' })
  })

  it('sanitizes disk JSONL to allowlisted fields and distinguishes missing active logs', async () => {
    const f = await fixture()
    await startAgentHostDiagnostics(f.userData)
    const rotation = join(f.userData, 'agent-host-diagnostics', 'agent-host.1.jsonl')
    await writeFile(rotation, JSON.stringify({
      schemaVersion: 1, timeUtc: new Date().toISOString(), processId: 123, runId: randomUUID(),
      event: 'gateway.request', status: 'ok', token: 'secret-token', path: f.directory, error: 'private text',
    }) + '\n' + JSON.stringify({
      schemaVersion: 1, timeUtc: new Date().toISOString(), processId: 123, runId: randomUUID(),
      event: 'gateway.request', status: 'secret-value',
    }) + '\n', { mode: 0o600 })
    const manifest = await f.service.prepare('alice', logs(), authorize, signal())
    const text = (await contents(f.service, manifest)).toString()
    expect(text).toContain('gateway.request')
    for (const secret of ['secret-token', 'secret-value', 'private text', f.directory]) expect(text).not.toContain(secret)
    const before = await captureAgentHostDiagnostics(f.userData, {}, signal())
    expect(before.truncated).toBe(true)
    await rm(rotation)
    await rm(join(f.userData, 'agent-host-diagnostics', 'agent-host.jsonl'))
    await expect(f.service.prepare('alice', logs(), authorize, signal())).rejects.toMatchObject({ code: 'LOGS_MISSING' })
  })
})
