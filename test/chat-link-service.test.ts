// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatLinkService } from '../src/main/chatLinkService'
import { FileTransferService } from '../src/main/fileTransferService'
import { FileTransferSource } from '../src/main/fileTransferSource'
import { chunkRequestSchema, exportRequestSchema, transferLookupSchema, FileTransferError } from '../src/shared/fileTransfer'
import type { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(remote = true) {
  const root = await mkdtemp(join(tmpdir(), 'continuum-chat-links-'))
  const workspace = join(root, 'workspace')
  const sourceFolder = join(root, 'source-workspace')
  await Promise.all([workspace, sourceFolder].map((folder) => mkdir(folder)))
  const source = new FileTransferSource(join(root, 'source-profile'), 'test')
  const local = new FileTransferSource(join(root, 'receiver-profile'), 'test')
  const owner = { clientId: randomUUID(), machineName: 'Original-owner' }
  const receiver = remote ? { clientId: randomUUID(), machineName: 'Receiver' } : owner
  const target = { owner, sessionId: 'copilotcli:/linked-file', chatId: 'ahp-chat:/linked-file/main' }
  const deviceId = randomUUID()
  let allowed = true
  const checkPeer = async () => { if (!allowed) throw new FileTransferError('ACCESS_DENIED', 'File device was revoked.') }
  const devices: Pick<VSCodeDeviceClient, 'fileDevices' | 'fileDeviceKey' | 'fileRequest'> = {
    fileDevices: async () => [],
    fileDeviceKey: async () => owner.clientId,
    fileRequest: vi.fn(async (_root, _peer, route, body, signal) => {
      await checkPeer()
      if (route === 'capabilities') return { protocolVersion: 1, ownerId: randomUUID(), pairId: deviceId }
      if (route === 'prepare') return source.prepare('peer', exportRequestSchema.parse(body), checkPeer, signal)
      if (route === 'chunk') {
        const request = chunkRequestSchema.parse(body)
        return source.chunk('peer', request.transferId, request.fileId, request.offset, checkPeer, signal)
      }
      return source.release('peer', transferLookupSchema.parse(body).transferId, checkPeer)
    }),
  }
  const files = new FileTransferService(join(root, 'receiver-profile'), local, devices)
  const openExternal = vi.fn(async () => {})
  const device = vi.fn(async () => deviceId)
  const directories = vi.fn(async () => [pathToFileURL(sourceFolder).href])
  const authorize = vi.fn(async () => {})
  const service = new ChatLinkService({ files, owner: async () => receiver, device, directories, authorize, openExternal })
  const checkpoint = vi.fn(async () => {})
  cleanups.push(async () => { await files.close(); await source.close(); await local.close(); await rm(root, { recursive: true, force: true }) })
  async function linked(path: string) {
    const opened = await service.open(workspace, { requestId: randomUUID(), href: pathToFileURL(path).href, target }, checkpoint)
    if (opened.kind !== 'file') throw new Error('Expected a linked file.')
    await expect.poll(async () => (await service.status(workspace, { target, transferId: opened.status.transferId }, checkpoint)).state, { timeout: 10000 }).toBe('delivered')
    const status = await service.status(workspace, { target, transferId: opened.status.transferId }, checkpoint)
    return { opened, reference: { target, transferId: status.transferId, fileId: status.files[0].fileId } }
  }
  return { root, workspace, sourceFolder, target, owner, receiver, deviceId, devices, files, service, openExternal, device, directories, authorize, checkpoint, linked,
    revoke: () => { allowed = false } }
}

describe('context-bound file link opening', () => {
  it('opens public HTTP links without file transfer or a selected workspace', async () => {
    const f = await fixture()
    expect(await f.service.open(undefined, { href: 'https://example.com/pull/42', requestId: randomUUID() }, f.checkpoint)).toEqual({ kind: 'external' })
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/pull/42')
    expect(f.device).not.toHaveBeenCalled()
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.devices.fileRequest).not.toHaveBeenCalled()
    await expect(f.service.open(undefined, { href: 'command:do-something', requestId: randomUUID() }, f.checkpoint)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.openExternal).toHaveBeenCalledOnce()
  })

  it.each([true, false])('fetches a file from its exact owner through the existing transfer service (remote: %s)', async (remote) => {
    const f = await fixture(remote)
    const path = join(f.sourceFolder, 'report.txt')
    await writeFile(path, 'Read-only received content\n')
    const { reference, opened } = await f.linked(path)
    expect(opened.status.deviceId).toBe(remote ? f.deviceId : 'local')
    const preview = await f.service.preview(f.workspace, reference, f.checkpoint)
    expect(preview).toMatchObject({ kind: 'text', page: { text: 'Read-only received content\n', eof: true } })
    if (remote) expect(f.device).toHaveBeenCalledExactlyOnceWith(f.workspace, f.owner)
    else expect(f.device).not.toHaveBeenCalled()
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.directories).not.toHaveBeenCalled()
    const destination = join(f.root, 'saved-copy.txt')
    await f.service.save(f.workspace, reference, destination, f.checkpoint)
    expect(await readFile(destination, 'utf8')).toBe('Read-only received content\n')
    expect(await readFile(path, 'utf8')).toBe('Read-only received content\n')
  })

  it('resolves relative paths only against the verified source session folder, not the receiver workspace', async () => {
    const f = await fixture()
    await writeFile(join(f.sourceFolder, 'report.txt'), 'Source document')
    await writeFile(join(f.workspace, 'report.txt'), 'Wrong receiver document')
    const opened = await f.service.open(f.workspace, { href: './report.txt:4', requestId: randomUUID(), target: f.target }, f.checkpoint)
    if (opened.kind !== 'file') throw new Error('Expected a linked file.')
    expect(opened.line).toBe(4)
    await expect.poll(async () => (await f.service.status(f.workspace, { target: f.target, transferId: opened.status.transferId }, f.checkpoint)).state).toBe('delivered')
    const status = await f.service.status(f.workspace, { target: f.target, transferId: opened.status.transferId }, f.checkpoint)
    expect(await f.service.preview(f.workspace, { target: f.target, transferId: status.transferId, fileId: status.files[0].fileId }, f.checkpoint))
      .toMatchObject({ kind: 'text', page: { text: 'Source document' } })
    f.directories.mockResolvedValue([])
    await expect(f.service.open(f.workspace, { href: './report.txt', requestId: randomUUID(), target: f.target }, f.checkpoint)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('does not transfer guessed-owner files or bypass current chat authorization', async () => {
    const f = await fixture()
    const path = join(f.sourceFolder, 'report.txt')
    await writeFile(path, 'Document')
    await expect(f.service.open(f.workspace, { href: pathToFileURL(path).href, requestId: randomUUID() }, f.checkpoint)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    f.authorize.mockRejectedValueOnce(new Error('Private authorization details'))
    await expect(f.service.open(f.workspace, { href: pathToFileURL(path).href, requestId: randomUUID(), target: f.target }, f.checkpoint))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', message: expect.not.stringContaining('Private authorization details') })
    expect(f.devices.fileRequest).not.toHaveBeenCalled()
  })

  it('denies preview and copying for another chat or workspace, and after device revocation', async () => {
    const f = await fixture()
    const path = join(f.sourceFolder, 'report.txt')
    await writeFile(path, 'Document')
    const { reference } = await f.linked(path)
    await expect(f.service.preview(f.workspace, { ...reference, target: { ...f.target, chatId: 'ahp-chat:/sibling' } }, f.checkpoint)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(f.service.status(join(f.root, 'another'), reference, f.checkpoint)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    f.revoke()
    await expect(f.service.preview(f.workspace, reference, f.checkpoint)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const destination = join(f.root, 'must-not-write.txt')
    await expect(f.service.save(f.workspace, reference, destination, f.checkpoint)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await readdir(f.root)).includes('must-not-write.txt')).toBe(false)
  })

  it('shows source transfer errors for missing and app-private files rather than claiming delivery', async () => {
    const f = await fixture()
    const path = join(f.root, 'source-profile', 'private.txt')
    await mkdir(join(f.root, 'source-profile'), { recursive: true })
    await writeFile(path, 'Private application content')
    for (const source of [path, join(f.sourceFolder, 'missing.txt')]) {
      const opened = await f.service.open(f.workspace, { target: f.target, href: pathToFileURL(source).href, requestId: randomUUID() }, f.checkpoint)
      if (opened.kind !== 'file') throw new Error('Expected a file.')
      await expect.poll(async () => (await f.service.status(f.workspace, { target: f.target, transferId: opened.status.transferId }, f.checkpoint)).state).toBe('failed')
      const status = await f.service.status(f.workspace, { target: f.target, transferId: opened.status.transferId }, f.checkpoint)
      expect(status.error?.code).toBe(source === path ? 'ACCESS_DENIED' : 'NOT_FOUND')
    }
  })

  it('verifies and previews received PNG data without relying on an untrusted MIME label', async () => {
    const f = await fixture()
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMpoAAAAASUVORK5CYII='
    const path = join(f.sourceFolder, 'result.png')
    await writeFile(path, Buffer.from(data, 'base64'))
    const { reference } = await f.linked(path)
    expect(await f.service.preview(f.workspace, reference, f.checkpoint)).toMatchObject({ kind: 'image', image: { data, mimeType: 'image/png' } })
  })

  it('keeps an existing destination intact when received bytes are corrupted', async () => {
    const f = await fixture()
    const path = join(f.sourceFolder, 'report.txt')
    await writeFile(path, 'Original')
    const { reference } = await f.linked(path)
    const blob = join(f.root, 'receiver-profile', 'file-transfer-inbox', reference.transferId, `${reference.fileId}.blob`)
    await writeFile(blob, 'Tampered')
    const destination = join(f.root, 'destination.txt')
    await writeFile(destination, 'Keep existing content')
    await expect(f.service.save(f.workspace, reference, destination, f.checkpoint)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(await readFile(destination, 'utf8')).toBe('Keep existing content')
    expect((await readdir(f.root)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('can cancel its own transfer without granting read access to a revoked chat', async () => {
    const f = await fixture()
    const path = join(f.sourceFolder, 'report.txt')
    await writeFile(path, 'Document')
    const { reference } = await f.linked(path)
    f.authorize.mockRejectedValue(new Error('Revoked chat'))
    expect((await f.service.cancel(f.workspace, reference, f.checkpoint)).state).toBe('cancelled')
    await expect(f.service.preview(f.workspace, reference, f.checkpoint)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
})
