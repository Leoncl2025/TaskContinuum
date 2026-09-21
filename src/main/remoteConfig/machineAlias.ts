import { z } from 'zod'
import { machineAliasMaxLength } from '../../shared/machineAliases'

const aliasInputSchema = z.string()
  .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), 'Machine aliases must be single-line text without control characters.')
  .trim()
  .max(machineAliasMaxLength, `Machine aliases must be at most ${machineAliasMaxLength} characters.`)

export const machineAliasSchema = aliasInputSchema.min(1, 'A machine alias must not be empty.')
export const machineAliasChangeSchema = aliasInputSchema.nullable().transform((value) => value || null)
