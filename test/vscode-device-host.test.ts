// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { deviceRequest } from '../src/main/vscodeDeviceHttp'
import { deviceIdentitySchema } from '../src/main/vscodeDeviceProtocol'
import { agentHostCatalogSchema } from '../src/main/agentHostProtocol'
import type { AgentHostRegistry } from '../src/main/agentHostRegistry'
import type { AgentHostTarget } from '../src/shared/agentHost'

const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

describe('device-scoped native Agent Host gateway', () => {
  it('keeps device identity across restart and scopes the native catalog to workspace permissions', async () => {
    const root = await mkdtemp(join(process.cwd(), '.test-ah-device-host-'))
    const workspace = join(root, 'tasks')
    await mkdir(workspace)
    const target: AgentHostTarget = { hostId: 'native-host-123', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original', owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const describeSession = vi.fn(async () => ({ ...target, title: 'Original native chat', provider: 'copilotcli', updatedAt: new Date().toISOString(), canSend: true }))
    const registry = { describe: describeSession } as unknown as AgentHostRegistry
    const createHost = () => {
      const host = new VSCodeDeviceHost(join(root, 'profile'), protector)
      host.setAgentHostAccess(registry, async () => [target])
      return host
    }
    let host = createHost()
    cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'Client-A' }
    const key = newSshKeyPair()
    const pair = await host.pair(participant, key.publicKey)
    const ownerId = await host.ownerId()
    const port = await host.start()
    const call = (path: string, body: unknown = {}) => deviceRequest(port, port, pair.token, path, body, AbortSignal.timeout(5000))

    expect(deviceIdentitySchema.parse(await call('/device/identity'))).toEqual({ ownerId, deviceId: pair.id })
    expect(describeSession).not.toHaveBeenCalled()
    expect(agentHostCatalogSchema.parse(await call('/device/agent-host/sessions')).sessions).toEqual([])
    await host.setWorkspace(pair.id, workspace, false)
    expect(agentHostCatalogSchema.parse(await call('/device/agent-host/sessions')).sessions).toEqual([expect.objectContaining({ ...target, canSend: false })])
    await host.setWorkspace(pair.id, workspace, true)
    expect(agentHostCatalogSchema.parse(await call('/device/agent-host/sessions')).sessions).toEqual([expect.objectContaining({ ...target, canSend: true })])

    await host.close()
    host = createHost()
    expect(await host.start()).toBe(port)
    expect(await host.ownerId()).toBe(ownerId)
    expect((await host.list())[0]).toMatchObject({ id: pair.id, participant, publicKey: key.publicKey, token: pair.token })
    expect(await host.pair(participant, key.publicKey)).toMatchObject({ id: pair.id, token: pair.token })
    await expect(host.pair(participant, newSshKeyPair().publicKey)).rejects.toThrow('identity changed')
    expect(agentHostCatalogSchema.parse(await call('/device/agent-host/sessions')).sessions).toEqual([expect.objectContaining(target)])
    await host.setWorkspace(pair.id, workspace, null)
    expect(agentHostCatalogSchema.parse(await call('/device/agent-host/sessions')).sessions).toEqual([])
    expect(await readFile(join(root, 'profile', 'remote-vscode-device-host.json'), 'utf8')).not.toContain(pair.token)
    await host.revoke(pair.id)
    await expect(call('/device/identity')).rejects.toMatchObject({ status: 403 })
    await expect(call('/device/agent-host/sessions')).rejects.toMatchObject({ status: 403 })
  })

  it('rejects all retired session routes and preserves inert grants without using them', async () => {
    const root = await mkdtemp(join(process.cwd(), '.test-ah-device-legacy-'))
    const file = join(root, 'remote-vscode-device-host.json')
    const archived = [{ identity: { nativeSessionId: 'retired', workspaceStorageId: 'b'.repeat(32) }, canSend: true, invitation: { legacy: 'opaque historical data' } }]
    const pair = { id: randomUUID(), participant: { clientId: randomUUID(), username: 'Alice', machineName: 'Client-A' }, publicKey: newSshKeyPair().publicKey,
      token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 60000).toISOString(), sessions: archived, workspaces: [] }
    const state = { ownerId: randomUUID(), pairs: [pair] }
    const stored = JSON.stringify({ encrypted: protector.encrypt(JSON.stringify(state)).toString('base64') })
    await writeFile(file, stored)
    const host = new VSCodeDeviceHost(root, protector)
    cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
    expect(await host.list()).toEqual([pair])
    expect(await readFile(file, 'utf8')).toBe(stored)
    const port = await host.start()
    for (const path of ['/device/sessions', '/device/session/read', '/device/session/send', '/device/session/open', '/remote/grant', '/remote/read', '/remote/send', '/remote/open']) {
      await expect(deviceRequest(port, port, pair.token, path, { identity: archived[0].identity, text: 'Never dispatch' }, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 404 })
    }
    expect(host).not.toHaveProperty('approve')
    expect(host).not.toHaveProperty('revokeSession')
    await expect(deviceRequest(port, port, pair.token, '/device/agent-host/sessions', {}, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 404 })
    await host.setWorkspace(pair.id, root, true)
    const updated = JSON.parse(protector.decrypt(Buffer.from(JSON.parse(await readFile(file, 'utf8')).encrypted, 'base64')))
    expect(updated.ownerId).toBe(state.ownerId)
    expect(updated.pairs[0]).toMatchObject({ id: pair.id, participant: pair.participant, publicKey: pair.publicKey, token: pair.token, sessions: archived })
  })

  it('requires authenticated loopback requests and fails closed on unreadable enrollment storage', async () => {
    const root = await mkdtemp(join(process.cwd(), '.test-ah-device-auth-'))
    const host = new VSCodeDeviceHost(root, protector)
    cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
    const pair = await host.pair({ clientId: randomUUID(), username: 'Alice', machineName: 'Client-A' }, newSshKeyPair().publicKey)
    const port = await host.start()
    const url = `http://127.0.0.1:${port}/device/identity`
    for (const headers of [{}, { Authorization: `Bearer ${pair.token}`, Origin: 'https://untrusted.example.test' }, { Authorization: `Bearer ${pair.token}`, Host: 'untrusted.example.test' }]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const operation = request(url, { method: 'POST', headers }, (response) => { response.resume(); resolve(response.statusCode) })
        operation.once('error', reject)
        operation.end('{}')
      })
      expect(status).toBe(403)
    }
    expect((await fetch(url, { headers: { Authorization: `Bearer ${pair.token}` } })).status).toBe(403)
    await expect(deviceRequest(port, port, pair.token, '/device/identity', { extra: true }, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 400 })
    const broken = join(root, 'broken')
    await mkdir(broken)
    const file = join(broken, 'remote-vscode-device-host.json')
    await writeFile(file, '{"encrypted":"not-readable"}')
    const invalid = new VSCodeDeviceHost(broken, protector)
    await expect(invalid.ownerId()).rejects.toThrow('not replaced')
    expect(await readFile(file, 'utf8')).toBe('{"encrypted":"not-readable"}')
    await invalid.close()
  })
})
