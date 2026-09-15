import { describe, expect, it, vi } from 'vitest'
import { PeerLinks } from '../src/main/remoteConfig/peers'
import type { PublicPeer, PublicPeerGrant } from '../src/main/remoteConfig/peers'

function peer(id: string): PublicPeer {
  return { deviceId: id, machineName: `Machine-${id}`, username: 'owner', clientPublicKey: 'validated', hostPublicKey: 'validated', identityRevision: `identity-${id}`, route: { tunnelId: 'owner.eus', sshPort: 10000, controlPort: 10001 } }
}
function grant(id: string): PublicPeerGrant {
  return { operationId: `grant-${id}`, grantId: `pair-${id}`, issuerId: id, recipientId: 'A', expiresAt: '2099-01-01T00:00:00Z', issuerIdentityRef: `identity-${id}`, recipientIdentityRef: 'identity-A' }
}

describe('reciprocal peer orchestration', () => {
  it('publishes separate grants and connects B and C independently without implicit B/C pairing', async () => {
    const issue = vi.fn(async (peer: PublicPeer) => { expect(peer.deviceId).not.toBe('A') })
    const notices = new Map<string, unknown[]>()
    const links = new PeerLinks({
      localId: 'A', localIdentityRevision: () => 'identity-A', authorize: async () => {}, issue,
      connect: async (peer) => {
        notices.set(peer.deviceId, [])
        return { notify: async (payload) => { notices.get(peer.deviceId)!.push(payload) }, close: vi.fn() }
      },
      disconnected: async () => {}, onChanged: () => {}, onError: (error) => { throw error },
    })
    await links.reconcile([peer('A'), peer('B'), peer('C')], [])
    expect(issue.mock.calls.map(([value]) => value.deviceId)).toEqual(['B', 'C'])
    await links.reconcile([peer('A'), peer('B'), peer('C')], [grant('B'), grant('C')])
    expect(links.status().map((state) => state.state)).toEqual(['linked', 'linked'])
    await links.notify('binding-one', { taskId: 'T-0009' }, ['B'])
    expect(notices.get('B')).toEqual([{ taskId: 'T-0009' }])
    expect(notices.get('C')).toEqual([])
    await links.close()
  })

  it('does not let an offline peer block another and closes stale grants', async () => {
    const close = vi.fn()
    const links = new PeerLinks({
      localId: 'A', localIdentityRevision: () => 'identity-A', authorize: async () => {}, issue: async () => {},
      connect: async (peer) => {
        if (peer.deviceId === 'B') throw new Error('B is offline')
        return { notify: async () => {}, close }
      },
      disconnected: async () => {}, onChanged: () => {}, onError: (error) => { throw error },
    })
    await links.reconcile([peer('B'), peer('C')], [grant('B'), grant('C')])
    expect(links.status()).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'B', state: 'offline' }),
      expect.objectContaining({ deviceId: 'C', state: 'linked' }),
    ]))
    await links.reconcile([peer('C')], [])
    expect(close).toHaveBeenCalledOnce()
    expect(links.status()[0].state).toBe('discovered')
    await links.close()
  })

  it('drains a notification arriving as the prior reconciliation completes without another tick', async () => {
    const sent: unknown[] = []
    let late: Promise<void> | undefined
    let armed = false
    const links = new PeerLinks({
      localId: 'A', localIdentityRevision: () => 'identity-A', authorize: async () => {}, issue: async () => {},
      connect: async () => ({ notify: async (payload) => { sent.push(payload) }, close: () => {} }),
      disconnected: async () => {}, onError: (error) => { throw error },
      onChanged: () => { if (armed && sent.includes('first') && !late) late = links.notify('late-op', 'late', ['B']) },
    })
    await links.reconcile([peer('B')], [grant('B')])
    armed = true
    await links.notify('first-op', 'first', ['B'])
    if (!late) throw new Error('The late notification was not scheduled.')
    await late
    expect(sent).toEqual(['first', 'late'])
    await links.close()
  })
})
