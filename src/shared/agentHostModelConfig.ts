import { z } from 'zod'
import type { ConfigPropertySchema, ConfigSchema, ModelSelection } from '@microsoft/agent-host-protocol'

export const modelConfigValueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
export const agentHostModelSelectionSchema = z.object({
  id: z.string().trim().min(1).max(512),
  config: z.record(z.string().min(1).max(200), modelConfigValueSchema).refine((config) => Object.keys(config).length <= 32, 'Too many model configuration values.').optional(),
}).strict()

const propertySchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  title: z.string().max(512),
  description: z.string().max(4000).optional(),
  default: z.json().optional(),
  enum: z.array(modelConfigValueSchema).max(100).optional(),
  enumLabels: z.array(z.string().max(512)).max(100).optional(),
  enumDescriptions: z.array(z.string().max(4000)).max(100).optional(),
  readOnly: z.boolean().optional(),
})

export const agentHostModelConfigSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string().min(1).max(200), propertySchema).refine((properties) => Object.keys(properties).length <= 32, 'Too many model configuration properties.'),
  required: z.array(z.string().min(1).max(200)).max(32).optional(),
})

export type ModelConfig = NonNullable<ModelSelection['config']>

export function modelConfigValueLabel(property: ConfigPropertySchema, value: unknown): string {
  const index = property.enum?.findIndex((item) => item === value) ?? -1
  return (index >= 0 ? property.enumLabels?.[index] : undefined) ?? String(value)
}

export function modelConfigErrors(schema: ConfigSchema | undefined, config: ModelConfig): string[] {
  const errors: string[] = []
  for (const [key, value] of Object.entries(config)) {
    const property = schema?.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
    if (!property) { errors.push(`Unknown model option: ${key}.`); continue }
    if (property.readOnly) { errors.push(`${property.title} is read-only. Reset it to Default.`); continue }
    if (!modelConfigValueSchema.safeParse(value).success) { errors.push(`${property.title} must be a valid ${property.type} value.`); continue }
    if (property.enum ? !property.enum.includes(value) : typeof value !== property.type || value === null) errors.push(`${property.title} has an unsupported value. Choose a value advertised by the Host.`)
  }
  for (const key of schema?.required ?? []) {
    const property = schema?.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
    if (!Object.hasOwn(config, key) && property?.default === undefined) errors.push(`${property?.title || key} requires an explicit value.`)
  }
  return errors
}
