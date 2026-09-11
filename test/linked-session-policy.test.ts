// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { recordLocalLink, locallyLinkedSessions, locallyLinkedAgentHostSessions, unregisteredLocalLinks } from '../src/main/linkedSessionPolicy'
import { readRepositorySessionLinks, updateRepositorySessionLink, updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'

it('keeps AHP identities separate and requires both Git ownership and exact local receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-links-'))
  const profile = join(root, 'profile')
  const owner = { clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Machine-B' }
  const target = { hostId: 'host-instance-123', sessionId: 'copilotcli:/original', chatId: 'ahp-chat://default/Y29waWxvdGNsaTovb3JpZ2luYWw', owner }
  try {
    const legacy = await updateRepositorySessionLink(root, 'T-0001', 'original', null, 'a'.repeat(32), undefined, owner)
    const saved = await updateRepositoryAgentHostLink(root, 'T-0002', target, legacy.revision)
    expect(saved.document.bindings['T-0001']).toEqual(legacy.document.bindings['T-0001'])
    expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
    await recordLocalLink(profile, root, 'T-0002', saved.document.bindings['T-0002'], owner)
    expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([target])
    expect(await locallyLinkedSessions(profile, root, owner)).toEqual([])
    await expect(updateRepositoryAgentHostLink(root, 'T-0003', target, saved.revision)).rejects.toThrow('already linked')
    await expect(updateRepositoryAgentHostLink(root, 'T-0002', { ...target, owner: { ...owner, clientId: '00000000-0000-4000-8000-000000000002' } }, saved.revision)).rejects.toThrow('ownership')
    await updateRepositoryAgentHostLink(root, 'T-0002', { ...target, chatId: 'ahp-chat:/original/other' }, saved.revision)
    expect(await locallyLinkedAgentHostSessions(profile, root, owner)).toEqual([])
    expect(await readFile(join(root, '.taskcontinuum/session-bindings.json'), 'utf8')).not.toMatch(/connectionToken|endpoint|port|profile/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('projects participant identity to owner and retries a Git link written before its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-adopt-retry-'))
  const profile = join(root, 'profile')
  const participant = { clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Machine-B', username: 'lianc' }
  const owner = { clientId: participant.clientId, machineName: participant.machineName }
  const workspaceId = 'a'.repeat(32)
  try {
    const initial = await updateRepositorySessionLink(root, 'T-0001', 'original', null, workspaceId)
    expect((await unregisteredLocalLinks(profile, root, initial.document.bindings, participant)).map(([id]) => id)).toEqual(['T-0001'])
    const written = await updateRepositorySessionLink(root, 'T-0001', 'original', initial.revision, workspaceId, undefined, owner)
    expect(await locallyLinkedSessions(profile, root, participant)).toEqual([])
    const retry = await unregisteredLocalLinks(profile, root, written.document.bindings, participant)
    expect(retry.map(([id]) => id)).toEqual(['T-0001'])
    await recordLocalLink(profile, root, retry[0][0], retry[0][1], participant)
    const receipt = JSON.parse(await readFile(join(profile, 'local-session-link-receipts.json'), 'utf8'))
    expect(receipt[0].owner).toEqual(owner)
    expect(receipt[0].owner).not.toHaveProperty('username')
    expect(await locallyLinkedSessions(profile, root, participant)).toEqual([{ nativeSessionId: 'original', workspaceStorageId: workspaceId }])
    expect(await unregisteredLocalLinks(profile, root, written.document.bindings, participant)).toEqual([])
    await recordLocalLink(profile, root, 'T-0001', written.document.bindings['T-0001'], participant)
    expect(JSON.parse(await readFile(join(profile, 'local-session-link-receipts.json'), 'utf8'))).toHaveLength(1)
    const foreign = await updateRepositorySessionLink(root, 'T-0002', 'foreign', written.revision, workspaceId, undefined, { clientId: '00000000-0000-4000-8000-000000000002', machineName: 'Machine-A' })
    const remote = await updateRepositorySessionLink(root, 'T-0003', 'legacy-remote', foreign.revision, workspaceId, 'Machine-A')
    expect(await unregisteredLocalLinks(profile, root, remote.document.bindings, participant)).toEqual([])
    expect(await readRepositorySessionLinks(root)).toEqual(remote)
  } finally { await rm(root, { recursive: true, force: true }) }
})