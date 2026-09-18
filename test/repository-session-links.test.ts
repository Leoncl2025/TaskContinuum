import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readRepositorySessionLinks, removeRepositorySessionLink, sessionLinkSchema,
  updateRepositoryAgentHostLink, writeRepositorySessionLinks,
} from '../src/main/repositorySessionLinks'
import { sessionLinksDocumentSchema } from '../src/main/sessionLinkSchema'
import { readRecords, recordPath } from '../src/main/remoteConfig/records'
import { agentHostTargetFixture, createImmutableBindingsFixture, immutableOwner } from './immutable-bindings-fixture'

const directories: string[] = []
const backends: Awaited<ReturnType<typeof createImmutableBindingsFixture>>[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-links-'))
  directories.push(root)
  return root
}
async function backend(root: string) {
  const value = await createImmutableBindingsFixture(root)
  backends.push(value)
  return value
}
const noBackend = /Enable Automatic workspace links.*legacy session configuration is not supported/i
const oldInputs: { name: string; value: unknown }[] = [
  { name: 'GitHub Copilot', value: { provider: 'github-copilot', sessionId: 'original' } },
  { name: 'VS Code Copilot', value: { provider: 'vscode-copilot', sessionId: 'original', workspaceStorageId: 'a'.repeat(32), owner: immutableOwner } },
  { name: 'ownerless Agent Host', value: { provider: 'agent-host', hostId: 'host-main', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original' } },
  { name: 'Host-pinned Agent Host', value: { provider: 'agent-host', hostId: 'host-main', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original', owner: immutableOwner } },
  { name: 'Agent Host without a chat', value: { provider: 'agent-host', hostId: 'host-main', sessionId: 'copilotcli:/original', owner: immutableOwner } },
  { name: 'Agent Host without a stable owner ID', value: { provider: 'agent-host', ...agentHostTargetFixture(), owner: { machineName: 'Machine-B' } } },
  { name: 'Agent Host without an owner machine name', value: { provider: 'agent-host', ...agentHostTargetFixture(), owner: { clientId: immutableOwner.clientId } } },
]

describe('immutable task/session links', () => {
  it('accepts only v2 logical binding documents and never imports v1 identity', () => {
    const bindings = { 'T-0001': { provider: 'agent-host', ...agentHostTargetFixture() } }
    expect(sessionLinksDocumentSchema.safeParse({ schemaVersion: 2, bindings }).success).toBe(true)
    expect(sessionLinksDocumentSchema.safeParse({ schemaVersion: 1, bindings }).success).toBe(false)
    expect(sessionLinksDocumentSchema.safeParse({ schemaVersion: 2, bindings: { 'T-0001': { ...bindings['T-0001'], hostId: 'host-main' } } }).success).toBe(false)
  })

  it('requires a registered backend even for an empty workspace and does not create legacy files', async () => {
    const root = await folder()
    const transform = vi.fn<Parameters<typeof writeRepositorySessionLinks>[2]>((document) => document)
    await expect(readRepositorySessionLinks(root)).rejects.toThrow(noBackend)
    await expect(writeRepositorySessionLinks(root, null, transform)).rejects.toThrow(noBackend)
    await expect(updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture(), null)).rejects.toThrow(noBackend)
    await expect(removeRepositorySessionLink(root, 'T-0001', null)).rejects.toThrow(noBackend)
    expect(transform).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    ['old providers', JSON.stringify({ schemaVersion: 1, bindings: { 'T-0001': oldInputs[0].value, 'T-0002': oldInputs[1].value } })],
    ['a derived Agent Host snapshot', JSON.stringify({ schemaVersion: 1, bindings: { 'T-0001': { provider: 'agent-host', ...agentHostTargetFixture() } } })],
    ['broken JSON', '{'],
    ['merge conflict markers', '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n'],
  ])('neither imports nor rewrites %s from the removed JSON location', async (_name, content) => {
    const root = await folder()
    await mkdir(join(root, '.taskcontinuum'))
    const file = join(root, '.taskcontinuum', 'session-bindings.json')
    await writeFile(file, content)
    await expect(readRepositorySessionLinks(root)).rejects.toThrow(noBackend)
    await expect(removeRepositorySessionLink(root, 'T-0001', null)).rejects.toThrow(noBackend)
    expect(await readFile(file, 'utf8')).toBe(content)
    const active = await backend(root)
    expect((await readRepositorySessionLinks(root)).document.bindings).toEqual({})
    expect(await readRecords(active.outboxRoot)).toEqual([])
    await updateRepositoryAgentHostLink(root, 'T-0003', agentHostTargetFixture('new'), active.snapshot.revision)
    expect(await readFile(file, 'utf8')).toBe(content)
    expect(await readdir(join(root, '.taskcontinuum'))).toEqual(['session-bindings.json'])
  })

  it.each(['directory junction', 'hard-linked file'])('leaves an old %s untouched instead of following it for bindings', async (kind) => {
    const root = await folder()
    const outside = await folder()
    const original = join(outside, 'session-bindings.json')
    const content = '{not a configuration'
    await writeFile(original, content)
    if (kind === 'directory junction') await symlink(outside, join(root, '.taskcontinuum'), process.platform === 'win32' ? 'junction' : 'dir')
    else {
      await mkdir(join(root, '.taskcontinuum'))
      await link(original, join(root, '.taskcontinuum', 'session-bindings.json'))
    }
    await expect(readRepositorySessionLinks(root)).rejects.toThrow(noBackend)
    const active = await backend(root)
    const saved = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture(), active.snapshot.revision)
    expect(saved.document.bindings['T-0001']).toEqual({ provider: 'agent-host', ...agentHostTargetFixture() })
    expect(await readFile(original, 'utf8')).toBe(content)
    expect(await readdir(outside)).toEqual(['session-bindings.json'])
  })

  it.each(oldInputs)('rejects $name rather than accepting an old binding shape', ({ value }) => {
    expect(sessionLinkSchema.safeParse(value).success).toBe(false)
    expect(sessionLinksDocumentSchema.safeParse({ schemaVersion: 2, bindings: { 'T-0001': value } }).success).toBe(false)
  })

  it('carries exact portable Agent Host ownership in signed immutable records across replicas', async () => {
    const root = await folder()
    const active = await backend(root)
    const target = agentHostTargetFixture('original')
    const saved = await updateRepositoryAgentHostLink(root, 'T-0001', target, active.snapshot.revision)
    expect(saved.document.bindings['T-0001']).toEqual({ provider: 'agent-host', ...target })
    const records = await readRecords(active.outboxRoot)
    expect(records).toHaveLength(1)
    const content = await readFile(join(active.outboxRoot, recordPath(records[0])), 'utf8')
    expect(content).not.toContain(root)
    expect(content).not.toMatch(/connectionToken|endpoint|transcript|title|requestHash/)
    const clone = await folder()
    const replica = await backend(clone)
    await replica.importRecords(records)
    const pulled = await readRepositorySessionLinks(clone)
    expect(pulled.document).toEqual(saved.document)
    expect((await replica.store.getRecords())[0]).toEqual(records[0])
    await expect(updateRepositoryAgentHostLink(clone, 'T-0001', {
      ...target, owner: { ...immutableOwner, clientId: '00000000-0000-4000-8000-000000000002' },
    }, pulled.revision)).rejects.toThrow('ownership')
    expect(await replica.store.getPendingRecords()).toEqual([])
    expect(await readdir(root)).toEqual([])
    expect(await readdir(clone)).toEqual([])
  })

  it('preserves unrelated tasks, rejects duplicate chats for the same session, and detaches with a tombstone', async () => {
    const root = await folder()
    const active = await backend(root)
    const first = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('first'), active.snapshot.revision)
    const second = await updateRepositoryAgentHostLink(root, 'T-0002', agentHostTargetFixture('second'), first.revision)
    await expect(updateRepositoryAgentHostLink(root, 'T-0003', {
      ...agentHostTargetFixture('first'), chatId: 'ahp-chat:/another-chat',
    }, second.revision)).rejects.toThrow('already linked to T-0001')
    expect(await readRepositorySessionLinks(root)).toEqual(second)
    const detached = await removeRepositorySessionLink(root, 'T-0001', second.revision)
    expect(detached.document.bindings).toEqual({ 'T-0002': second.document.bindings['T-0002'] })
    const records = await active.store.getRecords()
    expect(records).toHaveLength(3)
    expect(records).toContainEqual(expect.objectContaining({ kind: 'binding', payload: { schemaVersion: 2, action: 'delete', taskId: 'T-0001' } }))
    expect((await active.store.read()).resolution.entities['binding:T-0001'].state).toBe('deleted')
    const moved = await updateRepositoryAgentHostLink(root, 'T-0003', agentHostTargetFixture('first'), detached.revision)
    expect(moved.document.bindings['T-0002']).toEqual(second.document.bindings['T-0002'])
    expect(moved.document.bindings['T-0003']).toEqual(first.document.bindings['T-0001'])
  })

  it('distinguishes logical sessions by owner and session while rejecting runtime Host fields', async () => {
    const root = await folder()
    const active = await backend(root)
    const first = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture(), active.snapshot.revision)
    const hostPinned = { ...agentHostTargetFixture(), hostId: 'host-other' }
    expect(() => updateRepositoryAgentHostLink(root, 'T-0002', hostPinned, first.revision)).toThrow('hostId')
    expect(await readRepositorySessionLinks(root)).toEqual(first)
    const second = await updateRepositoryAgentHostLink(root, 'T-0002', agentHostTargetFixture('two'), first.revision)
    const anotherOwner = { ...immutableOwner, clientId: '00000000-0000-4000-8000-000000000002' }
    const third = await updateRepositoryAgentHostLink(root, 'T-0003', agentHostTargetFixture('one', anotherOwner), second.revision)
    await expect(updateRepositoryAgentHostLink(root, 'T-0004', agentHostTargetFixture('one', { ...immutableOwner, machineName: 'Renamed-machine' }), third.revision)).rejects.toThrow('already linked to T-0001')
    expect(Object.keys((await readRepositorySessionLinks(root)).document.bindings).sort()).toEqual(['T-0001', 'T-0002', 'T-0003'])
  })

  it('rejects stale revisions without rebasing or overwriting accepted records', async () => {
    const root = await folder()
    const active = await backend(root)
    const first = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('first'), active.snapshot.revision)
    const saved = await updateRepositoryAgentHostLink(root, 'T-0002', agentHostTargetFixture('second'), first.revision)
    const original = await readRecords(active.outboxRoot)
    await expect(removeRepositorySessionLink(root, 'T-0001', first.revision)).rejects.toThrow('changed on disk')
    await expect(writeRepositorySessionLinks(root, 'invalid', (document) => document)).rejects.toThrow('Invalid session link revision')
    expect(await readRepositorySessionLinks(root)).toEqual(saved)
    expect(await readRecords(active.outboxRoot)).toEqual(original)
  })

  it.each(['transform', 'beforeCommit'])('rejects a backend removed during %s without committing an operation', async (boundary) => {
    const root = await folder()
    const active = await backend(root)
    const check = vi.fn(async () => { if (boundary === 'beforeCommit') active.unregister() })
    await expect(writeRepositorySessionLinks(root, active.snapshot.revision, (document) => {
      if (boundary === 'transform') active.unregister()
      return { ...document, bindings: { 'T-0001': { provider: 'agent-host', ...agentHostTargetFixture() } } }
    }, check)).rejects.toThrow('backend changed')
    expect(check).toHaveBeenCalledTimes(boundary === 'beforeCommit' ? 1 : 0)
    expect(await readRecords(active.outboxRoot)).toEqual([])
    await expect(readRepositorySessionLinks(root)).rejects.toThrow(noBackend)
  })

  it('honors commit-time authorization while ignoring obsolete locks and preserving ignore rules', async () => {
    const root = await folder()
    await mkdir(join(root, '.taskcontinuum'))
    const ignore = 'session-bindings.lock\nsession-bindings.*.tmp\ncustom-local-state/\n'
    await writeFile(join(root, '.taskcontinuum', '.gitignore'), ignore)
    await writeFile(join(root, '.taskcontinuum', 'session-bindings.lock'), 'old process')
    const active = await backend(root)
    const update = () => ({ schemaVersion: 2 as const, bindings: { 'T-0001': { provider: 'agent-host' as const, ...agentHostTargetFixture() } } })
    await expect(writeRepositorySessionLinks(root, active.snapshot.revision, update, async () => { throw new Error('Authorization revoked') })).rejects.toThrow('Authorization revoked')
    expect(await readRecords(active.outboxRoot)).toEqual([])
    await writeRepositorySessionLinks(root, active.snapshot.revision, update)
    expect(await readFile(join(root, '.taskcontinuum', '.gitignore'), 'utf8')).toBe(ignore)
    expect(await readFile(join(root, '.taskcontinuum', 'session-bindings.lock'), 'utf8')).toBe('old process')
    expect((await readdir(join(root, '.taskcontinuum'))).sort()).toEqual(['.gitignore', 'session-bindings.lock'])
  })
})
