import { createHash } from 'node:crypto'
import { z } from 'zod'

export const sshPublicKeySchema = z.string().max(100).regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/).refine((value) => {
  const encoded = value.split(' ')[1]
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.length === 51 && bytes.toString('base64') === encoded && bytes.readUInt32BE(0) === 11
    && bytes.subarray(4, 15).toString() === 'ssh-ed25519' && bytes.readUInt32BE(15) === 32
}, 'An Ed25519 SSH public key is required.')

export const devTunnelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}\.[a-z0-9]{2,12}$/)
export const devTunnelRouteSchema = z.object({
  kind: z.literal('dev-tunnel'), tunnelId: devTunnelIdSchema,
  sshPort: z.number().int().min(1024).max(65535),
  hostPublicKey: sshPublicKeySchema, clientPublicKey: sshPublicKeySchema,
}).strict()
export type DevTunnelRoute = z.infer<typeof devTunnelRouteSchema>

export function sshFingerprint(key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(sshPublicKeySchema.parse(key).split(' ')[1], 'base64')).digest('base64url').replaceAll('-', '+').replaceAll('_', '/')}`
}