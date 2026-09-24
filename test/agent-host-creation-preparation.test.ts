// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { startAgentHostCreationFixture } from './agent-host-creation-fixture'
import type { PreparedAgentHostCreation } from '../src/main/agentHostRegistry'
import { captureAgentHostDiagnostics, startAgentHostDiagnostics, stopAgentHostDiagnostics } from '../src/main/agentHostDiagnostics'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-creation-preparation-'))
  const discovery = join(root, 'discovery')
  const workspace = join(root, 'workspace')
  await Promise.all([mkdir(discovery), mkdir(workspace)])
  const host = await startAgentHostCreationFixture()
  await writeFile(join(discovery, 'host.json'), JSON.stringify(host.endpoint))
  const owner = { clientId: randomUUID(), machineName: 'Worker-B' }
  const registry = new AgentHostRegistry(join(root, 'profile'), [discovery], async () => owner)
  cleanup.push(async () => { await registry.close(); await host.close(); await rm(root, { recursive: true, force: true }) })
  const sessionId = `copilotcli:/${randomUUID()}`
  return { root, host, registry, workspace, owner, sessionId }
}

describe('native creation preparation lifetime', () => {
  it('does not kill a prepared connection while the final authorized task check takes over ten seconds', async () => {
    const f = await fixture()
    let prepared: PreparedAgentHostCreation | undefined
    try {
      prepared = await f.registry.prepareCreation(f.host.hostId, f.sessionId, f.workspace, new AbortController().signal)
      expect(f.host.creations).toHaveLength(0)
      await prepared.create(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10_200)) })
      expect(prepared.dispatched).toBe(true)
      expect(f.host.creations).toHaveLength(1)
      expect(await prepared.inspect(undefined, true)).toMatchObject({ state: 'ready', session: { sessionId: f.sessionId } })
      await expect(prepared.create(async () => {})).rejects.toThrow('cannot be replayed')
      expect(f.host.creations).toHaveLength(1)
    } finally { await prepared?.close() }
  }, 15000)

  it('still honors caller cancellation and never dispatches after the final guard rejects', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const prepared = await f.registry.prepareCreation(f.host.hostId, f.sessionId, f.workspace, abort.signal)
    try {
      await expect(prepared.create(async () => { throw new Error('Send permission revoked.') })).rejects.toThrow('revoked')
      expect(prepared.dispatched).toBe(false)
      expect(f.host.creations).toHaveLength(0)
      abort.abort()
      await expect(prepared.create(async () => {})).rejects.toThrow()
      expect(prepared.dispatched).toBe(false)
      expect(f.host.creations).toHaveLength(0)
    } finally { await prepared.close() }
  })

  it('keeps the five-second configuration RPC timeout and exports its precise failure stage without private data', async () => {
    const f = await fixture()
    const paused = f.host.pausePreparation()
    const profile = join(f.root, 'logs')
    await startAgentHostDiagnostics(profile)
    try {
      const started = performance.now()
      await expect(f.registry.prepareCreation(f.host.hostId, f.sessionId, f.workspace, new AbortController().signal))
        .rejects.toThrow('resolving the native session configuration')
      expect(performance.now() - started).toBeGreaterThanOrEqual(5000)
      expect(f.host.creations).toHaveLength(0)
      const captured = await captureAgentHostDiagnostics(profile, {}, new AbortController().signal)
      const text = captured.jsonl.toString('utf8')
      const entries = text.trim().split('\n').map((line) => JSON.parse(line))
      expect(entries).toContainEqual(expect.objectContaining({ event: 'creation.prepare', step: 'configuration', status: 'error', errorKind: 'timeout', timeoutMs: 5000, dispatched: false }))
      expect(captured.truncated).toBe(false)
      for (const privateValue of [f.workspace, f.sessionId, f.host.endpoint.connectionToken]) expect(text).not.toContain(privateValue)
    } finally { paused.resolve(); await stopAgentHostDiagnostics() }
  }, 10000)
})
