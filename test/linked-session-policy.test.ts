// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalPolicyRoot, recordLocalLink, locallyLinkedAgentHostSessions, unregisteredLocalLinks } from '../src/main/linkedSessionPolicy'
import { readRepositorySessionLinks, removeRepositorySessionLink, updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'
import { agentHostTargetFixture, createImmutableBindingsFixture, immutableOwner } from './immutable-bindings-fixture'

const directories: string[] = []
const backends: Awaited<ReturnType<typeof createImmutableBindingsFixture>>[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-links-'))
  directories.push(root)
  const backend = await createImmutableBindingsFixture(root)
  backends.push(backend)
  return { root, profile: join(root, 'profile'), backend, owner: immutableOwner }
}

it('requires exact immutable ownership and local receipts without implicitly moving an Agent Host session', async () => {
  const { root, profile, backend, owner } = await fixture()
  const target = agentHostTargetFixture('original', owner)
  const first = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('unrelated', owner), backend.snapshot.revision)
  const saved = await updateRepositoryAgentHostLink(root, 'T-0002', target, first.revision)
  expect(saved.document.bindings['T-0001']).toEqual(first.document.bindings['T-0001'])
  expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
  await recordLocalLink(profile, root, 'T-0002', saved.document.bindings['T-0002'], owner)
  expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([target])
  await expect(updateRepositoryAgentHostLink(root, 'T-0003', target, saved.revision)).rejects.toThrow('already linked')
  await expect(updateRepositoryAgentHostLink(root, 'T-0002', {
    ...target, owner: { ...owner, clientId: '00000000-0000-4000-8000-000000000002' },
  }, saved.revision)).rejects.toThrow('ownership')
  await updateRepositoryAgentHostLink(root, 'T-0002', { ...target, chatId: 'ahp-chat:/original/other' }, saved.revision)
  expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
  expect(JSON.stringify(await backend.store.getRecords())).not.toMatch(/connectionToken|endpoint|profile/)
  expect(await readdir(root)).toEqual(['profile'])
})

it('projects participant identity to owner and retries an immutable link written before its receipt', async () => {
  const { root, profile, backend, owner } = await fixture()
  const participant = { ...owner, username: 'lianc' }
  const target = agentHostTargetFixture('original', owner)
  const written = await updateRepositoryAgentHostLink(root, 'T-0001', target, backend.snapshot.revision)
  expect(await locallyLinkedAgentHostSessions(profile, root, participant)).toEqual([])
  const retry = await unregisteredLocalLinks(profile, root, written.document.bindings, participant)
  expect(retry.map(([id]) => id)).toEqual(['T-0001'])
  await recordLocalLink(profile, root, retry[0][0], retry[0][1], participant)
  const receiptFile = join(profile, 'local-session-link-receipts.json')
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  expect(receipt.schemaVersion).toBe(2)
  expect(receipt.receipts[0].owner).toEqual(owner)
  expect(receipt.receipts[0].owner).not.toHaveProperty('username')
  expect(receipt.receipts[0].identity).not.toHaveProperty('hostId')
  expect(await locallyLinkedAgentHostSessions(profile, root, participant)).toEqual([target])
  expect(await unregisteredLocalLinks(profile, root, written.document.bindings, participant)).toEqual([])
  await recordLocalLink(profile, root, 'T-0001', written.document.bindings['T-0001'], participant)
  expect(JSON.parse(await readFile(receiptFile, 'utf8')).receipts).toHaveLength(1)
  const foreignOwner = { clientId: '00000000-0000-4000-8000-000000000002', machineName: owner.machineName }
  const foreign = await updateRepositoryAgentHostLink(root, 'T-0002', agentHostTargetFixture('foreign', foreignOwner), written.revision)
  await recordLocalLink(profile, root, 'T-0002', foreign.document.bindings['T-0002'], participant)
  expect(await unregisteredLocalLinks(profile, root, foreign.document.bindings, participant)).toEqual([])
  expect(await locallyLinkedAgentHostSessions(profile, root, participant)).toEqual([target])
  expect(await readRepositorySessionLinks(root)).toEqual(foreign)
})

it('does not carry receipt authority across roots or stable local identities, and honors immutable detach', async () => {
  const { root, profile, backend, owner } = await fixture()
  const other = await fixture()
  const target = agentHostTargetFixture('original', owner)
  const linked = await updateRepositoryAgentHostLink(root, 'T-0001', target, backend.snapshot.revision)
  await recordLocalLink(profile, root, 'T-0001', linked.document.bindings['T-0001'], owner)
  await other.backend.importRecords(await backend.store.getRecords())
  expect(await locallyLinkedAgentHostSessions(profile, other.root, owner)).toEqual([])
  expect(await locallyLinkedAgentHostSessions(profile, root, {
    clientId: '00000000-0000-4000-8000-000000000002', machineName: owner.machineName,
  })).toEqual([])
  await removeRepositorySessionLink(root, 'T-0001', linked.revision)
  expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
  expect((await backend.store.read()).resolution.entities['binding:T-0001'].state).toBe('deleted')
})

it.each(['github-copilot', 'vscode-copilot'])('never grants access from an old %s file or converts its bindings into receipts', async (provider) => {
  const { root, profile, backend, owner } = await fixture()
  const old: unknown = { schemaVersion: 1, bindings: { 'T-0001': {
    provider, sessionId: 'original', owner, ...(provider === 'vscode-copilot' ? { workspaceStorageId: 'a'.repeat(32) } : {}),
  } } }
  await mkdir(join(root, '.taskcontinuum'))
  const file = join(root, '.taskcontinuum', 'session-bindings.json')
  const content = JSON.stringify(old)
  await writeFile(file, content)
  expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
  expect(await unregisteredLocalLinks(profile, root, (await readRepositorySessionLinks(root)).document.bindings, owner)).toEqual([])
  expect(await backend.store.getRecords()).toEqual([])
  expect(await readFile(file, 'utf8')).toBe(content)
  await expect(readFile(join(profile, 'local-session-link-receipts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  backend.unregister()
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('Enable Automatic workspace links')
  expect(await readFile(file, 'utf8')).toBe(content)
})

it('rejects legacy local receipts without accepting, migrating or rewriting them', async () => {
  const { root, profile, backend, owner } = await fixture()
  const target = agentHostTargetFixture('original', owner)
  const saved = await updateRepositoryAgentHostLink(root, 'T-0001', target, backend.snapshot.revision)
  await mkdir(profile)
  const file = join(profile, 'local-session-link-receipts.json')
  const canonical = await canonicalPolicyRoot(root)
  const old = [{ root: canonical, taskId: 'T-0001', owner, identity: { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) } }]
  const content = JSON.stringify(old)
  await writeFile(file, content)
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('Schema v2 logical session receipts are required')
  await expect(unregisteredLocalLinks(profile, root, saved.document.bindings, owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0001', undefined, owner)).rejects.toThrow('invalid')
  expect(await readFile(file, 'utf8')).toBe(content)
  expect(await readRepositorySessionLinks(root)).toEqual(saved)
})

it.each(['same', 'another'])('rejects mixed legacy and current receipts from %s workspace without granting access or rewriting data', async (workspace) => {
  const { root, profile, backend, owner } = await fixture()
  const target = agentHostTargetFixture('original', owner)
  const retryTarget = agentHostTargetFixture('retry', owner)
  const first = await updateRepositoryAgentHostLink(root, 'T-0001', target, backend.snapshot.revision)
  const saved = await updateRepositoryAgentHostLink(root, 'T-0002', retryTarget, first.revision)
  await recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)
  const file = join(profile, 'local-session-link-receipts.json')
  const native: unknown[] = JSON.parse(await readFile(file, 'utf8')).receipts
  const legacy = { root: await canonicalPolicyRoot(root), taskId: 'T-0002', owner, identity: { nativeSessionId: 'retry', workspaceStorageId: 'a'.repeat(32) } }
  const unrelated = { ...legacy, root: workspace === 'another' ? join(legacy.root, 'another-workspace') : legacy.root, taskId: 'T-0003' }
  const content = JSON.stringify({ schemaVersion: 2, receipts: [legacy, unrelated, ...native] })
  await writeFile(file, content)
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('invalid')
  await expect(unregisteredLocalLinks(profile, root, saved.document.bindings, owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0002', saved.document.bindings['T-0002'], owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0001', undefined, owner)).rejects.toThrow('invalid')
  expect(await readFile(file, 'utf8')).toBe(content)
  expect(await readRepositorySessionLinks(root)).toEqual(saved)
})

it.each([
  { nativeSessionId: 'original' },
  { nativeSessionId: 'original', workspaceStorageId: 'not-a-workspace-id' },
  { nativeSessionId: 'copilotcli:/original', workspaceStorageId: 'a'.repeat(32) },
  { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32), hostId: 'host-main' },
  { hostId: 'host-main', sessionId: 'copilotcli:/original' },
  { hostId: 'host-main', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original' },
])('still rejects a malformed receipt identity without accepting other receipts: %j', async (identity) => {
  const { root, profile, backend, owner } = await fixture()
  const saved = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('original', owner), backend.snapshot.revision)
  await recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)
  const file = join(profile, 'local-session-link-receipts.json')
  const native: unknown[] = JSON.parse(await readFile(file, 'utf8')).receipts
  const content = JSON.stringify({ schemaVersion: 2, receipts: [...native, { root, taskId: 'T-0002', owner, identity }] })
  await writeFile(file, content)
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('invalid')
  await expect(unregisteredLocalLinks(profile, root, saved.document.bindings, owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)).rejects.toThrow('invalid')
  expect(await readFile(file, 'utf8')).toBe(content)
  expect(await readRepositorySessionLinks(root)).toEqual(saved)
})

it.each(['{invalid JSON', '{}'])('does not replace an unreadable receipt document: %s', async (content) => {
  const { root, profile, backend, owner } = await fixture()
  const saved = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('original', owner), backend.snapshot.revision)
  await mkdir(profile)
  const file = join(profile, 'local-session-link-receipts.json')
  await writeFile(file, content)
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('invalid')
  await expect(recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)).rejects.toThrow('invalid')
  expect(await readFile(file, 'utf8')).toBe(content)
})
