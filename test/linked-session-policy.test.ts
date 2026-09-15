// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recordLocalLink, locallyLinkedAgentHostSessions, unregisteredLocalLinks } from '../src/main/linkedSessionPolicy'
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
  expect(receipt[0].owner).toEqual(owner)
  expect(receipt[0].owner).not.toHaveProperty('username')
  expect(await locallyLinkedAgentHostSessions(profile, root, participant)).toEqual([target])
  expect(await unregisteredLocalLinks(profile, root, written.document.bindings, participant)).toEqual([])
  await recordLocalLink(profile, root, 'T-0001', written.document.bindings['T-0001'], participant)
  expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toHaveLength(1)
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

it('rejects legacy local receipts rather than silently migrating them or granting an Agent Host link', async () => {
  const { root, profile, backend, owner } = await fixture()
  const saved = await updateRepositoryAgentHostLink(root, 'T-0001', agentHostTargetFixture('original', owner), backend.snapshot.revision)
  await mkdir(profile)
  const file = join(profile, 'local-session-link-receipts.json')
  const old: unknown = [{ root, taskId: 'T-0001', owner, identity: { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) } }]
  const content = JSON.stringify(old)
  await writeFile(file, content)
  await expect(locallyLinkedAgentHostSessions(profile, root, owner)).rejects.toThrow('unsupported legacy format')
  await expect(unregisteredLocalLinks(profile, root, saved.document.bindings, owner)).rejects.toThrow('unsupported legacy format')
  await expect(recordLocalLink(profile, root, 'T-0001', saved.document.bindings['T-0001'], owner)).rejects.toThrow('unsupported legacy format')
  expect(await readFile(file, 'utf8')).toBe(content)
  expect(await readRepositorySessionLinks(root)).toEqual(saved)
})
