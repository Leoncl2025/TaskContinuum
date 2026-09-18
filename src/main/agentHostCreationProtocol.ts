import { z } from 'zod'
import { agentHostIdSchema, agentHostSessionSchema, agentHostTargetSchema } from './agentHostProtocol'

export const creationTaskIdSchema = z.string().regex(/^T-\d{4,}$/)
export const creationWorkspaceIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const creationRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable()
const errorSchema = z.string().min(1).max(2000)

export const agentHostCreationHostSchema = z.object({
  hostId: agentHostIdSchema, name: z.string().min(1).max(200),
  available: z.boolean(), error: errorSchema.optional(),
}).strict()
export const agentHostCreationWorkspaceSchema = z.object({
  id: creationWorkspaceIdSchema, name: z.string().min(1).max(300), canSend: z.boolean(),
  taskState: z.enum(['available', 'missing', 'bound', 'unavailable']),
  expectedRevision: creationRevisionSchema, error: errorSchema.optional(),
}).strict()
export const agentHostWorkerCatalogSchema = z.object({
  ownerId: z.uuid(), deviceId: z.uuid(), owner: agentHostTargetSchema.shape.owner,
  hosts: z.array(agentHostCreationHostSchema).max(128),
  workspaces: z.array(agentHostCreationWorkspaceSchema).max(10),
}).strict()
export const agentHostCreateCommandSchema = z.object({
  operationId: z.uuid(), taskId: creationTaskIdSchema, workspaceId: creationWorkspaceIdSchema,
  hostId: agentHostIdSchema, expectedRevision: creationRevisionSchema,
}).strict()
export const agentHostCreateRequestSchema = agentHostCreateCommandSchema.extend({ workerId: z.uuid() }).strict()
export const agentHostCreationLookupSchema = z.object({
  operationId: z.uuid(), workspaceId: creationWorkspaceIdSchema,
}).strict()
export const agentHostCreationBindSchema = agentHostCreationLookupSchema.extend({ expectedRevision: creationRevisionSchema }).strict()
export const agentHostCreationResultSchema = agentHostCreateCommandSchema.omit({ expectedRevision: true }).extend({
  state: z.enum(['creating', 'uncertain', 'failed', 'created-unbound', 'ready']),
  nativeLifecycle: z.enum(['creating', 'ready', 'failed']).optional(),
  session: agentHostSessionSchema.extend({ provider: z.literal('copilotcli') }).optional(), error: errorSchema.optional(),
}).strict().superRefine((result, context) => {
  if ((result.state === 'ready' || result.state === 'created-unbound') && !result.session) context.addIssue({ code: 'custom', message: 'A created session requires its verified identity.' })
})
export const agentHostCreationSchema = agentHostCreationResultSchema.safeExtend({ workerId: z.uuid() }).strict()
