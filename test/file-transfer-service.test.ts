// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTransferService } from '../src/main/fileTransferService'
import { FileTransferBudget } from '../src/main/fileTransferBudget'
import type { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { exportRequestSchema, FILE_TRANSFER_LIMITS, FileTransferError } from '../src/shared/fileTransfer'
import type { ExportManifest, ExportRequest } from '../src/shared/fileTransfer'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(data = Buffer.from('some log data')) {
  const root = await mkdtemp(join(tmpdir(), 'continuum-files-inbox-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const directory = join(root, 'profile')
  const manifest = (id: string): ExportManifest => ({
    transferId: id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + FILE_TRANSFER_LIMITS.retentionMs).toISOString(),
    files: [{ fileId: randomUUID(), name: 'data.log', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), mediaType: 'text/plain' }],
  })
  const saved = new Map<string, ExportManifest>()
  const source = {
    prepare: vi.fn(async (_principal: string, request: ExportRequest) => {
      if (!saved.has(request.transferId)) saved.set(request.transferId, manifest(request.transferId))
      return saved.get(request.transferId)!
    }),
    chunk: vi.fn(async (_principal: string, _id: string, _file: string, offset: number) => data.subarray(offset, offset + FILE_TRANSFER_LIMITS.chunkBytes)),
    release: vi.fn(async () => {}),
  }
  const devices = {
    fileDevices: vi.fn<VSCodeDeviceClient['fileDevices']>(async () => []), fileRequest: vi.fn<VSCodeDeviceClient['fileRequest']>(async () => ({})),
    fileDeviceKey: vi.fn<VSCodeDeviceClient['fileDeviceKey']>(async (_root, peer) => peer),
  }
  const budget = new FileTransferBudget()
  const service = new FileTransferService(directory, source, devices, budget)
  cleanups.push(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  const api = service.forWorkspace(workspace)
  const request = { requestId: randomUUID(), deviceId: 'local' as const, selection: { kind: 'files' as const, paths: ['C:\\fake.log'] } }
  return { root, directory, workspace, service, api, request, source, devices, saved, budget }
}

describe('file transfer inbox', () => {
  it('delivers and hashes a multichunk file, deduplicates request IDs and pages UTF-8 without splitting a character', async () => {
    const text = 'abcd\u4f60\u597d'.repeat(70_000)
    const setup = await fixture(Buffer.from(text))
    const start = await setup.api.fetch(setup.request)
    expect(start.state).toBe('transferring')
    await expect.poll(async () => (await setup.api.status(start.transferId)).state).toBe('delivered')
    const status = await setup.api.status(start.transferId)
    expect(status.receivedBytes).toBe(Buffer.byteLength(text))
    expect(setup.source.chunk).toHaveBeenCalledTimes(Math.ceil(Buffer.byteLength(text) / FILE_TRANSFER_LIMITS.chunkBytes))
    expect((await setup.api.fetch(setup.request)).state).toBe('delivered')
    expect(setup.source.prepare).toHaveBeenCalledOnce()
    const fileId = status.files[0].fileId
    const first = await setup.api.read({ transferId: start.transferId, fileId, offset: 0, maxBytes: 5 })
    expect(first).toMatchObject({ text: 'abcd', nextOffset: 4, eof: false, truncated: true })
    const next = await setup.api.read({ transferId: start.transferId, fileId, offset: first.nextOffset, maxBytes: 6 })
    expect(next).toMatchObject({ text: '\u4f60\u597d', nextOffset: 10 })
    await expect(setup.api.read({ transferId: start.transferId, fileId, offset: 5, maxBytes: 6 })).rejects.toMatchObject({ code: 'NOT_TEXT' })
    await expect(setup.api.fetch({ ...setup.request, selection: { kind: 'files', paths: ['C:\\other'] } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('resumes an interrupted transfer from persisted bytes after service restart', async () => {
    const data = Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes * 2 + 50, 65)
    const setup = await fixture(data)
    setup.source.chunk.mockImplementationOnce(async () => data.subarray(0, FILE_TRANSFER_LIMITS.chunkBytes))
      .mockRejectedValueOnce(new FileTransferError('UNAVAILABLE', 'Connection interrupted.'))
    const start = await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(start.transferId)).state).toBe('interrupted')
    await setup.service.close()
    const restored = new FileTransferService(setup.directory, setup.source, setup.devices)
    cleanups.push(() => restored.close())
    const api = restored.forWorkspace(setup.workspace)
    expect((await api.status(start.transferId)).receivedBytes).toBe(FILE_TRANSFER_LIMITS.chunkBytes)
    await api.resume(start.transferId)
    await expect.poll(async () => (await api.status(start.transferId)).state).toBe('delivered')
    expect(setup.source.chunk.mock.calls.map((call) => call[3])).toEqual([0, FILE_TRANSFER_LIMITS.chunkBytes, FILE_TRANSFER_LIMITS.chunkBytes, FILE_TRANSFER_LIMITS.chunkBytes * 2])
    expect((await api.read({ transferId: start.transferId, fileId: (await api.status(start.transferId)).files[0].fileId, offset: 0, maxBytes: 8 })).text).toBe('AAAAAAAA')
  })

  it('never publishes corrupted bytes or treats failure as delivery', async () => {
    const setup = await fixture(Buffer.from('correct'))
    setup.source.chunk.mockResolvedValue(Buffer.from('corrupt'))
    const start = await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(start.transferId)).state).toBe('failed')
    const status = await setup.api.status(start.transferId)
    expect(status.error?.code).toBe('INTEGRITY_FAILED')
    await expect(setup.api.read({ transferId: start.transferId, fileId: status.files[0].fileId, offset: 0, maxBytes: 8 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('reports storage failures explicitly instead of claiming successful delivery', async () => {
    const setup = await fixture()
    setup.source.chunk.mockRejectedValue(Object.assign(new Error('fixture path must not be exposed'), { code: 'ENOSPC' }))
    const start = await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(start.transferId)).state).toBe('interrupted')
    const status = await setup.api.status(start.transferId)
    expect(status.error).toMatchObject({ code: 'IO_ERROR', message: expect.stringContaining('free disk space') })
    expect(JSON.stringify(status)).not.toContain('fixture path')
    expect(status.receivedBytes).toBe(0)
  })

  it('rejects another workspace and file ID and removes access on cancellation', async () => {
    const setup = await fixture()
    const start = await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(start.transferId)).state).toBe('delivered')
    await mkdir(join(setup.root, 'other'))
    const other = setup.service.forWorkspace(join(setup.root, 'other'))
    await expect(other.status(start.transferId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(setup.api.read({ transferId: start.transferId, fileId: randomUUID(), offset: 0, maxBytes: 8 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const cancelled = await setup.api.cancel(start.transferId)
    expect(cancelled.state).toBe('cancelled')
    await expect(setup.api.read({ transferId: start.transferId, fileId: cancelled.files[0].fileId, offset: 0, maxBytes: 8 })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(setup.source.release).toHaveBeenCalledOnce()
  })

  it('bounds one active transfer per device without delaying byte throughput', async () => {
    const setup = await fixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const original = setup.source.prepare.getMockImplementation()!
    setup.source.prepare.mockImplementation(async (...args) => { await blocked; return original(...args) })
    try {
      await setup.api.fetch(setup.request)
      await expect(setup.api.fetch({ ...setup.request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'BUSY' })
    } finally { release() }
    await expect.poll(async () => (await setup.api.status(setup.request.requestId)).state).toBe('delivered')
  })

  it('bounds total active receiving transfers to two across different peers', async () => {
    const setup = await fixture()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    setup.devices.fileRequest.mockImplementation(async (_root, peer, route, body) => {
      if (route === 'prepare') { await blocked; return setup.source.prepare(peer, exportRequestSchema.parse(body)) }
      if (route === 'chunk') return Buffer.from('some log data')
      return {}
    })
    const requests = Array.from({ length: 3 }, () => ({ ...setup.request, requestId: randomUUID(), deviceId: randomUUID() }))
    try {
      await setup.api.fetch(requests[0])
      await setup.api.fetch(requests[1])
      await expect(setup.api.fetch(requests[2])).rejects.toMatchObject({ code: 'BUSY' })
    } finally { release() }
    await expect.poll(async () => (await setup.api.status(requests[0].requestId)).state).toBe('delivered')
    await expect.poll(async () => (await setup.api.status(requests[1].requestId)).state).toBe('delivered')
  })

  it('shares global capacity with incoming source work and releases leases idempotently', async () => {
    const setup = await fixture()
    const one = setup.budget.acquire('peer-A')
    const two = setup.budget.acquire('peer-B')
    try {
      await expect(setup.api.fetch(setup.request)).rejects.toMatchObject({ code: 'BUSY' })
      expect(() => setup.budget.acquire('peer-A')).toThrow('active')
      one()
      one()
      await setup.api.fetch(setup.request)
      await expect.poll(async () => (await setup.api.status(setup.request.requestId)).state).toBe('delivered')
    } finally { one(); two() }
  })

  it('checks the device again after reading so revocation cannot return cached content', async () => {
    const setup = await fixture()
    const request = { ...setup.request, deviceId: randomUUID() }
    setup.devices.fileRequest.mockImplementation(async (_root, peer, route, body) => {
      if (route === 'prepare') return setup.source.prepare(peer, exportRequestSchema.parse(body))
      if (route === 'chunk') return Buffer.from('some log data')
      return {}
    })
    await setup.api.fetch(request)
    await expect.poll(async () => (await setup.api.status(request.requestId)).state).toBe('delivered')
    const delivered = await setup.api.status(request.requestId)
    setup.devices.fileRequest.mockResolvedValueOnce({}).mockRejectedValueOnce(new FileTransferError('ACCESS_DENIED', 'The trusted device pairing was revoked.'))
    await expect(setup.api.read({ transferId: delivered.transferId, fileId: delivered.files[0].fileId, offset: 0, maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })

  it('expires received blobs and refuses oversized reads', async () => {
    const setup = await fixture()
    await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(setup.request.requestId)).state).toBe('delivered')
    const status = await setup.api.status(setup.request.requestId)
    await expect(setup.api.read({ transferId: status.transferId, fileId: status.files[0].fileId, offset: 0, maxBytes: 32769 })).rejects.toThrow()
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(status.expiresAt) + 1)
    try {
      await expect(setup.api.read({ transferId: status.transferId, fileId: status.files[0].fileId, offset: 0, maxBytes: 16 })).rejects.toMatchObject({ code: 'EXPIRED' })
      await expect(setup.api.status(status.transferId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally { now.mockRestore() }
  })

  it('recovers an interrupted initial metadata write without breaking the inbox', async () => {
    const setup = await fixture()
    const orphan = join(setup.directory, 'file-transfer-inbox', randomUUID())
    await mkdir(orphan, { recursive: true, mode: 0o700 })
    await writeFile(join(orphan, `transfer.json.${randomUUID()}.tmp`), '{partial', { mode: 0o600 })
    await setup.api.fetch(setup.request)
    await expect.poll(async () => (await setup.api.status(setup.request.requestId)).state).toBe('delivered')
    await expect(readdir(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects binary text decoding and preserves empty files as valid deliveries', async () => {
    const binary = await fixture(Buffer.from([0, 1, 2]))
    await binary.api.fetch(binary.request)
    await expect.poll(async () => (await binary.api.status(binary.request.requestId)).state).toBe('delivered')
    const state = await binary.api.status(binary.request.requestId)
    await expect(binary.api.read({ transferId: state.transferId, fileId: state.files[0].fileId, offset: 0, maxBytes: 4 })).rejects.toMatchObject({ code: 'NOT_TEXT' })
    const empty = await fixture(Buffer.alloc(0))
    await empty.api.fetch(empty.request)
    await expect.poll(async () => (await empty.api.status(empty.request.requestId)).state).toBe('delivered')
    const delivered = await empty.api.status(empty.request.requestId)
    expect(await empty.api.read({ transferId: delivered.transferId, fileId: delivered.files[0].fileId, offset: 0, maxBytes: 4 })).toMatchObject({ text: '', nextOffset: 0, eof: true, truncated: false })
  })
})
