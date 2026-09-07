import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SharedEvent, SharedSessionDescriptor } from '../src/shared/sharedSessions'
import { createSharedCheckpoint, semanticContinuation, verifySharedCheckpoint } from '../src/main/shared/checkpoint'

function fixture() {
  const session: SharedSessionDescriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'checkpoint', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
  const actor = { kind: 'user' as const, id: 'user-A', name: 'Alice', machineId: 'A', machineName: 'Machine A' }
  const events: SharedEvent[] = [
    { sessionId: session.id, epoch: 1, seq: 1, at: new Date().toISOString(), type: 'message', actor, commandId: 'command-1', text: 'Continue this task' },
    { sessionId: session.id, epoch: 1, seq: 2, at: new Date().toISOString(), type: 'delta', actor: { ...actor, kind: 'agent', id: 'agent-B', machineId: 'B', machineName: 'B' }, commandId: 'command-1', text: 'Verified the tests.' },
    { sessionId: session.id, epoch: 1, seq: 3, at: new Date().toISOString(), type: 'completed', actor, commandId: 'command-1' },
  ]
  const code = { commit: 'a'.repeat(40), branch: 'main', clean: true as const }
  return { session, events, code }
}

describe('verified shared checkpoints', () => {
  it('preserves the bounded event prefix, identities, code reference and semantic lineage context', () => {
    const { session, events, code } = fixture()
    const checkpoint = createSharedCheckpoint(session, events, code)
    expect(verifySharedCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint)
    expect(checkpoint.payload.lastSeq).toBe(3)
    expect(checkpoint.payload.runtime.nativeFork).toBe(false)
    expect(semanticContinuation(checkpoint)).toContain('quoted history')
    expect(checkpoint.payload.context).toContain('Alice @ Machine A')
  })

  it('rejects corrupted, incomplete, live-only and credential-bearing exports', () => {
    const { session, events, code } = fixture()
    const checkpoint = createSharedCheckpoint(session, events, code)
    expect(() => verifySharedCheckpoint({ ...checkpoint, sha256: '0'.repeat(64) })).toThrow('digest')
    expect(() => createSharedCheckpoint(session, events.slice(0, 2), code)).toThrow('turn boundary')
    expect(() => createSharedCheckpoint({ ...session, mode: 'live' }, events, code)).toThrow('live-only')
    expect(() => createSharedCheckpoint(session, [{ ...events[0], text: `api_key=${'x'.repeat(32)}` }, ...events.slice(1)], code)).toThrow('credential')
  })
})