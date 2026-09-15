import { z } from 'zod'
import { sshPublicKeySchema } from './devTunnel/protocol'

export const remoteClientSchema = z.object({
  clientId: z.uuid(), username: z.string().trim().min(1).max(300), machineName: z.string().trim().min(1).max(300),
}).strict()
// Keep the public device identity format stable without the retired session protocol.
export const remoteIdentityFileSchema = z.object({ schemaVersion: z.literal(1), provider: z.literal('vscode-copilot'), participant: remoteClientSchema, sshPublicKey: sshPublicKeySchema.optional() }).strict()
export const remoteMachineSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/)