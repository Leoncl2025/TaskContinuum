import { lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { VSCodeChatDelivery, VSCodeChatIdentity, VSCodeChatView } from '../shared/vscodeChat'
import { vsCodeBridgeConnectUri } from '../shared/vscodeChat'
import { companionSchema, vscodeIdentitySchema } from './vscodeChatCompanion'
import { readJsonBounded } from './shared/storage'
import type { VSCodeSessionStore } from './vscodeSessions'
import { deliverySchema, executionIdentitySchema, participantSchema } from './vscodeChatDelivery'
import { originalChatView } from './vscodeChatView'
import { remoteClientSchema, remoteGrantSchema, remoteInvitationSchema } from './vscodeRemoteProtocol'
import type { RemoteVSCodeClientIdentity, RemoteVSCodeGrant } from '../shared/remoteVSCode'
import type { RemoteVSCodeInvitation } from './vscodeRemoteProtocol'

const identityResponse = z.object({ protocol: z.literal(1), instanceId: z.uuid(), workspaceStorageId: z.string(), vscodeVersion: z.string(), participant: participantSchema.optional(), execution: executionIdentitySchema.optional(), capabilities: z.object({ open: z.literal(true), send: z.boolean(), remote: z.boolean().optional() }).strict() }).strict()
interface CompanionConnection { descriptor: z.infer<typeof companionSchema>; actual: z.infer<typeof identityResponse> }

async function responseJson(response: Response, maximum = 8192): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The VS Code bridge returned an empty response.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maximum) throw new Error('The VS Code bridge response exceeds its size limit.')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => undefined) }
}

async function discoverCompanion(directory: string, identity: VSCodeChatIdentity): Promise<CompanionConnection> {
  const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const candidates = files.filter((entry) => entry.isFile() && /^[a-f0-9-]{36}\.json$/.test(entry.name))
  if (candidates.length > 32) throw new Error('Too many VS Code bridge records. Stop old bridges before reconnecting.')
  const live: CompanionConnection[] = []
  for (const entry of candidates) {
    try {
      const file = join(directory, entry.name)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) continue
      const descriptor = companionSchema.parse(await readJsonBounded(file, 8192))
      if (descriptor.workspaceStorageId !== identity.workspaceStorageId) continue
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/identity`, { headers: { Authorization: `Bearer ${descriptor.token}` }, redirect: 'error', signal: AbortSignal.timeout(1000) })
      if (!response.ok) { await response.body?.cancel(); continue }
      const actual = identityResponse.parse(await responseJson(response))
      if (actual.instanceId === descriptor.instanceId && actual.workspaceStorageId === identity.workspaceStorageId && actual.vscodeVersion === descriptor.vscodeVersion) live.push({ descriptor, actual })
    } catch { continue }
  }
  if (!live.length) throw new Error('The original VS Code workspace is not connected.')
  if (live.length > 1) throw new Error('More than one VS Code window owns this workspace bridge. Stop the extra bridge before opening the conversation.')
  return live[0]
}

async function post(connection: CompanionConnection, path: '/open' | '/send' | '/deliveries' | '/remote/grant' | '/remote/grants' | '/remote/revoke', value: unknown, maximum = 32768): Promise<unknown> {
  const { descriptor } = connection
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value), redirect: 'error', signal: AbortSignal.timeout(30000),
  })
  const body = await responseJson(response, maximum)
  if (!response.ok) {
    const message = z.object({ error: z.string().max(1000) }).safeParse(body)
    throw new Error(message.success ? message.data.error : 'The VS Code bridge rejected the operation.')
  }
  return body
}

export async function connectOriginalVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity, openExternal: (uri: string) => Promise<void>): Promise<void> {
  const identity = vscodeIdentitySchema.parse(value)
  const original = await store.locateOriginal(identity)
  await openExternal(vsCodeBridgeConnectUri(identity, original.uriScheme))
}

async function remoteAdministration(store: VSCodeSessionStore, value: VSCodeChatIdentity): Promise<CompanionConnection> {
  const identity = vscodeIdentitySchema.parse(value)
  const original = await store.locateOriginal(identity)
  const connection = await discoverCompanion(original.bridgeDirectory, identity)
  if (!connection.actual.capabilities.remote) throw new Error('Update and reconnect the execution machine\'s VS Code bridge before sharing this conversation.')
  return connection
}

export async function grantRemoteVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity, participant: RemoteVSCodeClientIdentity, canSend: boolean): Promise<RemoteVSCodeInvitation> {
  const identity = vscodeIdentitySchema.parse(value)
  return remoteInvitationSchema.parse(await post(await remoteAdministration(store, identity), '/remote/grant', { ...identity, participant: remoteClientSchema.parse(participant), canSend: z.boolean().parse(canSend) }))
}

export async function listRemoteVSCodeGrants(store: VSCodeSessionStore, value: VSCodeChatIdentity): Promise<RemoteVSCodeGrant[]> {
  const identity = vscodeIdentitySchema.parse(value)
  return z.array(remoteGrantSchema).max(32).parse(await post(await remoteAdministration(store, identity), '/remote/grants', identity))
}

export async function revokeRemoteVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity, grantId: string): Promise<void> {
  const identity = vscodeIdentitySchema.parse(value)
  z.object({ revoked: z.literal(true) }).strict().parse(await post(await remoteAdministration(store, identity), '/remote/revoke', { ...identity, grantId: z.uuid().parse(grantId) }))
}

export async function openOriginalVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity): Promise<void> {
  const identity = vscodeIdentitySchema.parse(value)
  const original = await store.locateOriginal(identity)
  const body = await post(await discoverCompanion(original.bridgeDirectory, identity), '/open', identity)
  const opened = vscodeIdentitySchema.extend({ opened: z.literal(true) }).strict().parse(body)
  if (opened.nativeSessionId !== identity.nativeSessionId || opened.workspaceStorageId !== identity.workspaceStorageId) throw new Error('VS Code returned a different conversation identity.')
}

export async function sendOriginalVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity, commandId: string, text: string): Promise<VSCodeChatDelivery> {
  const identity = vscodeIdentitySchema.parse(value)
  const request = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).strict().parse({ id: commandId, text })
  const original = await store.locateOriginal(identity)
  const connection = await discoverCompanion(original.bridgeDirectory, identity)
  if (!connection.actual.capabilities.send || !connection.actual.participant || !connection.actual.execution) throw new Error('This VS Code bridge does not support attributed sending. Update the companion and restart its bridge.')
  const result = deliverySchema.parse(await post(connection, '/send', { ...identity, ...request }))
  if (result.id !== request.id || result.text !== request.text || result.nativeSessionId !== identity.nativeSessionId
    || result.participant.username !== connection.actual.participant.username || result.participant.machineName !== connection.actual.participant.machineName
    || result.execution.machineName !== connection.actual.execution.machineName) throw new Error('VS Code returned a different submission identity. Inspect the original conversation before retrying.')
  return result
}

export async function readOriginalVSCode(store: VSCodeSessionStore, value: VSCodeChatIdentity): Promise<VSCodeChatView> {
  const identity = vscodeIdentitySchema.parse(value)
  const original = await store.locateOriginal(identity)
  let connection: CompanionConnection | undefined
  let bridgeError: string | undefined
  let deliveries: VSCodeChatDelivery[] = []
  try {
    connection = await discoverCompanion(original.bridgeDirectory, identity)
    if (connection.actual.capabilities.send) deliveries = z.array(deliverySchema).max(500).parse(await post(connection, '/deliveries', identity, 4 * 1024 * 1024))
  } catch (error) {
    connection = undefined
    bridgeError = error instanceof Error ? error.message : 'The original VS Code bridge is unavailable.'
    try {
      deliveries = z.array(deliverySchema).max(500).parse(await readJsonBounded(join(dirname(original.bridgeDirectory), 'deliveries.json'), 4 * 1024 * 1024))
        .filter((record) => record.nativeSessionId === identity.nativeSessionId)
        .map((record) => record.state === 'pending' ? { ...record, state: 'uncertain', error: 'The bridge is offline before delivery was confirmed. This message will not be resent automatically.' } : record)
    } catch { deliveries = [] }
  }
  if (deliveries.some((delivery) => delivery.nativeSessionId !== identity.nativeSessionId)) throw new Error('The VS Code bridge returned deliveries from a different conversation.')
  const supportsSending = Boolean(connection?.actual.capabilities.send && connection.actual.participant && connection.actual.execution)
  return originalChatView(original, deliveries, { connected: Boolean(connection), supportsSending, bridgeError,
    participant: connection?.actual.participant, execution: connection?.actual.execution,
  })
}