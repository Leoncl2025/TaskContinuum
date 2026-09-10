// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { remoteHistorySchema, remoteInvitationSchema } from '../src/main/vscodeRemoteProtocol'
import { deliveryPrompt } from '../src/main/vscodeChatDelivery'
import { vsCodeChatResource } from '../src/shared/vscodeChat'

describe('remote original VS Code authorization', () => {
  it('scopes read/send to an owner-approved participant and session without exposing local administration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-remote-grant-'))
    const identity = { workspaceStorageId: 'a'.repeat(32), nativeSessionId: 'original' }
    const directory = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const data = { customTitle: 'Original shared chat', inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: 'Earlier question', result: {} }] }
    const file = join(directory, 'original.json')
    await writeFile(file, JSON.stringify(data))
    await writeFile(join(directory, 'other.json'), JSON.stringify(data))
    const dispatch = vi.fn(async (_identity, delivery) => {
      await writeFile(file, JSON.stringify({ ...data, requests: [...data.requests, { requestId: 'remote-turn', message: deliveryPrompt(delivery), response: [{ value: 'Executed on B' }], result: {} }] }))
      return { state: 'submitted' as const, nativeRequestId: 'remote-turn' }
    })
    const open = vi.fn(async () => {})
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.136.1', open, dispatch })
    const base = `http://127.0.0.1:${bridge.descriptor.port}`
    const call = (token: string, route: string, body?: unknown) => fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'Machine A' }
    try {
      const invitation = remoteInvitationSchema.parse(await (await call(bridge.descriptor.token, '/remote/grant', { ...identity, participant, canSend: true })).json())
      expect(invitation.token).not.toBe(bridge.descriptor.token)
      expect(invitation.execution.machineName).toBe(hostname())
      expect((await call(invitation.token, '/identity')).status).toBe(404)
      for (const route of ['/open', '/send', '/remote/grant', '/remote/revoke', '/remote/grants']) expect((await call(invitation.token, route, identity)).status).toBe(404)
      expect((await call(invitation.token, '/remote/read', { ...identity, nativeSessionId: 'other' })).status).toBe(403)
      expect((await call(invitation.token, '/remote/read', { ...identity, workspaceStorageId: 'b'.repeat(32) })).status).toBe(403)
      expect((await call(invitation.token, '/remote/send', { ...identity, id: randomUUID(), text: 'Bad', participant: { ...participant, username: 'B' } })).status).toBe(400)
      const initial = remoteHistorySchema.parse(await (await call(invitation.token, '/remote/read', identity)).json())
      expect(initial.view.canOpenRemote).toBe(true)
      expect((await call(invitation.token, '/remote/open', { ...identity, nativeSessionId: 'other' })).status).toBe(403)
      expect((await call(invitation.token, '/remote/open', { ...identity, workspaceStorageId: 'b'.repeat(32) })).status).toBe(403)
      expect(await (await call(invitation.token, '/remote/open', identity)).json()).toEqual({ opened: true, ...identity })
      expect(open).toHaveBeenCalledExactlyOnceWith(vsCodeChatResource(identity.nativeSessionId))
      expect(dispatch).not.toHaveBeenCalled()
      expect(initial.view.session).not.toHaveProperty('workingDirectory')
      expect(initial.view.participant).toEqual(participant)
      const command = { ...identity, id: randomUUID(), text: 'Continue on B' }
      expect(await (await call(invitation.token, '/remote/send', command)).json()).toMatchObject({ state: 'pending', participant, execution: { machineName: hostname() } })
      await vi.waitFor(async () => {
        const view = remoteHistorySchema.parse(await (await call(invitation.token, '/remote/read', identity)).json()).view
        expect(view.deliveries[0].state).toBe('submitted')
        expect(view.messages.at(-2)).toMatchObject({ text: 'Continue on B', author: { name: 'Alice', machineName: 'Machine A' } })
        expect(view.messages.at(-1)).toMatchObject({ text: 'Executed on B', author: { machineName: hostname() } })
      })
      await call(invitation.token, '/remote/send', command)
      expect(dispatch).toHaveBeenCalledTimes(1)
      const readOnly = remoteInvitationSchema.parse(await (await call(bridge.descriptor.token, '/remote/grant', { ...identity, participant: { ...participant, clientId: randomUUID() }, canSend: false })).json())
      expect((await call(readOnly.token, '/remote/send', { ...command, id: randomUUID() })).status).toBe(403)
      expect((await call(readOnly.token, '/remote/open', identity)).status).toBe(403)
      const view = remoteHistorySchema.parse(await (await call(readOnly.token, '/remote/read', identity)).json()).view
      expect(view.canSend).toBe(false)
      expect(view.canOpenRemote).toBe(false)
      expect(view.bridgeError).toContain('reading only')
      const grants = await (await call(bridge.descriptor.token, '/remote/grants', identity)).json()
      expect(JSON.stringify(grants)).not.toContain(invitation.token)
      expect((await call(bridge.descriptor.token, '/remote/revoke', { ...identity, grantId: invitation.grant.id })).ok).toBe(true)
      expect((await call(invitation.token, '/remote/read', identity)).status).toBe(401)
      expect((await call(invitation.token, '/remote/open', identity)).status).toBe(401)
      const expiring = remoteInvitationSchema.parse(await (await call(bridge.descriptor.token, '/remote/grant', { ...identity, participant, canSend: true })).json())
      const slow = request(`${base}/remote/send`, { method: 'POST', headers: { Authorization: `Bearer ${expiring.token}`, 'Content-Type': 'application/json', Expect: '100-continue' } })
      try {
        const continued = new Promise<void>((resolve) => slow.once('continue', resolve))
        const status = new Promise<number | undefined>((resolve, reject) => { slow.once('error', reject); slow.once('response', (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)) }) })
        slow.flushHeaders()
        await continued
        expect((await call(bridge.descriptor.token, '/remote/revoke', { ...identity, grantId: expiring.grant.id })).ok).toBe(true)
        slow.end(JSON.stringify({ ...command, id: randomUUID() }))
        expect(await status).toBe(401)
        expect(dispatch).toHaveBeenCalledTimes(1)
      } finally { slow.destroy() }
      expect(open).toHaveBeenCalledTimes(1)
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })
})