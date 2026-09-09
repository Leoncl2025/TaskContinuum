import { z } from 'zod'
import { remoteClientSchema, remoteInvitationSchema, remoteMachineSchema } from './vscodeRemoteProtocol'
import { devTunnelRouteSchema } from './devTunnel/protocol'

export const deviceInvitationSchema = z.object({
  schemaVersion: z.literal(2), provider: z.literal('vscode-copilot-device'),
  id: z.uuid(), ownerId: z.uuid(), machineName: remoteMachineSchema,
  ownerClientId: z.uuid().optional(),
  participant: remoteClientSchema, expiresAt: z.iso.datetime(),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  port: z.number().int().min(1024).max(65535), devTunnel: devTunnelRouteSchema,
}).strict()
export type DeviceInvitation = z.infer<typeof deviceInvitationSchema>
export const deviceCatalogSchema = z.object({
  ownerId: z.uuid(), deviceId: z.uuid(), sessions: z.array(remoteInvitationSchema).max(32),
}).strict()
