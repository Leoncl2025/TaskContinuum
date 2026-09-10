import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { z } from 'zod'
import { VSCodeSessionStore } from './vscodeSessions'
import { writeJsonAtomic } from './shared/storage'
import { vsCodeChatResource } from '../shared/vscodeChat'
import { VSCodeChatDeliveryService } from './vscodeChatDelivery'
import type { VSCodeDispatch } from './vscodeChatDelivery'
import { companionSchema, vscodeIdentitySchema } from './vscodeChatSchemas'
import { remoteClientSchema, remoteInvitationSchema, remoteGrantSchema } from './vscodeRemoteProtocol'
import type { RemoteVSCodeInvitation } from './vscodeRemoteProtocol'
import { originalChatView } from './vscodeChatView'
export { companionSchema, vscodeIdentitySchema } from './vscodeChatSchemas'

export async function startVSCodeChatCompanion(options: {
  storageRoot: string
  workspaceStorageId: string
  discoveryDirectory: string
  vscodeVersion: string
  open(resource: string): Promise<void>
  dispatch?: VSCodeDispatch
}) {
  const workspaceStorageId = z.string().regex(/^[a-f0-9]{32}$/).parse(options.workspaceStorageId)
  const storageRoot = await realpath(options.storageRoot)
  const store = new VSCodeSessionStore([storageRoot])
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomUUID()
  const participant = { username: userInfo().username, machineName: hostname() }
  const execution = { agentName: 'GitHub Copilot', machineName: hostname() }
  const deliveries = options.dispatch ? new VSCodeChatDeliveryService(dirname(options.discoveryDirectory), store, participant, execution, options.dispatch) : undefined
  const remoteGrants = new Map<string, RemoteVSCodeInvitation>()
  const matchesToken = (supplied: string, secret: string) => {
    const expected = `Bearer ${secret}`
    return Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  }
  let opening = false
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Bridge unavailable.')
      const expectedHost = `127.0.0.1:${address.port}`
      if (request.headers.origin !== undefined || request.headers.host !== expectedHost) { response.writeHead(403).end('{}'); return }
      const supplied = request.headers.authorization ?? ''
      const local = matchesToken(supplied, token)
      const invitation = local ? undefined : [...remoteGrants.values()].find((entry) => matchesToken(supplied, entry.token))
      if (!local && (!invitation || Date.parse(invitation.grant.expiresAt) <= Date.now())) {
        response.writeHead(401).end('{}'); return
      }
      const authorized = () => local || Boolean(invitation && remoteGrants.get(invitation.grant.id) === invitation && Date.parse(invitation.grant.expiresAt) > Date.now())
      const assertAuthorized = () => { if (!authorized()) throw new Error('Remote access was revoked or expired before this operation completed.') }
      if (local && request.method === 'GET' && request.url === '/identity') {
        response.end(JSON.stringify({ protocol: 1, instanceId, workspaceStorageId, vscodeVersion: options.vscodeVersion, participant, execution, capabilities: { open: true, send: Boolean(deliveries), remote: true } })); return
      }
      if (invitation && request.method === 'GET' && request.url === '/remote/identity') {
        response.end(JSON.stringify({ instanceId, identity: invitation.identity, grant: invitation.grant, execution, vscodeVersion: options.vscodeVersion })); return
      }
      const routes = local ? ['/open', '/send', '/deliveries', '/remote/grant', '/remote/grants', '/remote/revoke'] : ['/remote/read', '/remote/send', '/remote/open']
      if (request.method !== 'POST' || !routes.includes(request.url ?? '')) { response.writeHead(404).end('{}'); return }
      if (['/send', '/deliveries', '/remote/send'].includes(request.url!) && !deliveries) { response.writeHead(404).end('{}'); return }
      if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end('{}'); return }
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const value = Buffer.from(chunk)
        bytes += value.byteLength
        if (bytes > 32768) { response.writeHead(413).end('{}'); return }
        chunks.push(value)
      }
      if (!authorized()) { response.writeHead(401).end('{}'); return }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (local && request.url === '/remote/grant') {
        const grantRequest = vscodeIdentitySchema.extend({ participant: remoteClientSchema, canSend: z.boolean() }).strict().parse(input)
        if (grantRequest.workspaceStorageId !== workspaceStorageId) { response.writeHead(403).end('{}'); return }
        const identity = { nativeSessionId: grantRequest.nativeSessionId, workspaceStorageId }
        const original = await store.locateOriginal(identity)
        for (const [id, value] of remoteGrants) if (Date.parse(value.grant.expiresAt) <= Date.now()) remoteGrants.delete(id)
        if (remoteGrants.size >= 32) throw new Error('This bridge has reached its 32-invitation limit. Revoke an old invitation first.')
        if (grantRequest.canSend && !deliveries) throw new Error('This bridge cannot authorize remote sending.')
        const value = remoteInvitationSchema.parse({ schemaVersion: 1, provider: 'vscode-copilot', instanceId, identity, execution,
          title: original.snapshot.session.title, port: address.port, vscodeVersion: options.vscodeVersion, token: randomBytes(32).toString('base64url'),
          grant: { id: randomUUID(), participant: grantRequest.participant, canSend: grantRequest.canSend, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
        })
        remoteGrants.set(value.grant.id, value)
        response.end(JSON.stringify(value)); return
      }
      if (local && request.url === '/remote/revoke') {
        const revocation = vscodeIdentitySchema.extend({ grantId: z.uuid() }).strict().parse(input)
        if (revocation.workspaceStorageId !== workspaceStorageId) { response.writeHead(403).end('{}'); return }
        const value = remoteGrants.get(revocation.grantId)
        if (value && value.identity.nativeSessionId !== revocation.nativeSessionId) { response.writeHead(403).end('{}'); return }
        remoteGrants.delete(revocation.grantId)
        if (value) deliveries?.revokeParticipant(value.grant.participant.clientId, value.identity.nativeSessionId)
        response.end(JSON.stringify({ revoked: true })); return
      }
      const submission = request.url === '/send' || request.url === '/remote/send' ? vscodeIdentitySchema.extend({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).strict().parse(input) : undefined
      const identity = submission ? { nativeSessionId: submission.nativeSessionId, workspaceStorageId: submission.workspaceStorageId } : vscodeIdentitySchema.parse(input)
      if (identity.workspaceStorageId !== workspaceStorageId) { response.writeHead(403).end(JSON.stringify({ error: 'This is a different VS Code workspace.' })); return }
      if (invitation && invitation.identity.nativeSessionId !== identity.nativeSessionId) { response.writeHead(403).end(JSON.stringify({ error: 'This invitation does not authorize that conversation.' })); return }
      if (invitation && request.url === '/remote/open' && !invitation.grant.canSend) { response.writeHead(403).end(JSON.stringify({ error: 'Read-only access cannot open a conversation on the execution machine.' })); return }
      if (local && request.url === '/remote/grants') {
        response.end(JSON.stringify([...remoteGrants.values()].filter((value) => value.identity.nativeSessionId === identity.nativeSessionId && Date.parse(value.grant.expiresAt) > Date.now()).map((value) => remoteGrantSchema.parse(value.grant)))); return
      }
      if (submission) {
        if (opening) { response.writeHead(409).end(JSON.stringify({ error: 'An original conversation is opening. Wait before sending.' })); return }
        if (invitation && !invitation.grant.canSend) { response.writeHead(403).end(JSON.stringify({ error: 'This invitation is read-only.' })); return }
        response.end(JSON.stringify(await deliveries!.submit(identity, { id: submission.id, text: submission.text }, invitation?.grant.participant ?? participant, assertAuthorized))); return
      }
      if (invitation && request.url === '/remote/read') {
        const original = await store.locateOriginal(identity)
        const records = deliveries ? await deliveries.list(identity) : []
        if (!authorized()) { response.writeHead(401).end('{}'); return }
        const view = originalChatView(original, records, { connected: true, supportsSending: Boolean(deliveries), participant: invitation.grant.participant, execution, readOnly: !invitation.grant.canSend })
        view.session = { id: identity.nativeSessionId, source: 'vscode', title: original.snapshot.session.title, updatedAt: original.snapshot.session.updatedAt }
        view.canOpenRemote = invitation.grant.canSend
        response.end(JSON.stringify({ instanceId, grantId: invitation.grant.id, identity, view })); return
      }
      if (request.url === '/deliveries') {
        response.end(JSON.stringify(await deliveries!.list(identity))); return
      }
      if (opening) { response.writeHead(409).end(JSON.stringify({ error: 'Another original conversation is being opened. Retry after it finishes.' })); return }
      opening = true
      try {
        const original = await store.locateOriginal(identity)
        if (!original.snapshot.messages.length) throw new Error('The original conversation has no saved history. Open it in VS Code directly.')
        if (invitation && deliveries && (await deliveries.list(identity)).some((record) => record.state === 'pending' || record.state === 'uncertain')) throw new Error('Resolve the pending or uncertain delivery before switching this original conversation.')
        assertAuthorized()
        await options.open(vsCodeChatResource(identity.nativeSessionId))
        assertAuthorized()
        response.end(JSON.stringify({ opened: true, ...identity }))
      } finally { opening = false }
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 1000) : 'The original conversation could not be opened.' }))
      else response.end()
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Bridge failed to bind to loopback.')
  const descriptor = companionSchema.parse({ protocol: 1, instanceId, workspaceStorageId, port: address.port, token, vscodeVersion: options.vscodeVersion, pid: process.pid })
  const file = join(options.discoveryDirectory, `${instanceId}.json`)
  try {
    await mkdir(options.discoveryDirectory, { recursive: true })
    await writeJsonAtomic(file, descriptor, true)
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  return {
    descriptor,
    close: async () => {
      remoteGrants.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try { await deliveries?.close() } finally { await rm(file, { force: true }) }
    },
  }
}