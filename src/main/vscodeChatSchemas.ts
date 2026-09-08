import { z } from 'zod'

export const vscodeIdentitySchema = z.object({ nativeSessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
export const companionSchema = z.object({
  protocol: z.literal(1), instanceId: z.uuid(), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/),
  port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  vscodeVersion: z.string().min(1).max(100), pid: z.number().int().positive(),
}).strict()