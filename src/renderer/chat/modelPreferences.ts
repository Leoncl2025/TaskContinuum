import type { ModelSelection } from '@microsoft/agent-host-protocol'
import { agentHostModelSelectionSchema } from '../../shared/agentHostModelConfig'

function preferenceKey(ownerId: string, provider: string): string {
  return `taskcontinuum:model-preference:v1:${JSON.stringify([ownerId, provider])}`
}

export function readModelPreference(ownerId: string, provider: string): { model?: ModelSelection; error?: string } {
  let stored: string | null
  try {
    stored = localStorage.getItem(preferenceKey(ownerId, provider))
  } catch {
    return { error: 'The saved model preference could not be read on this device. Choose a model for this chat.' }
  }
  if (stored === null) return {}
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch {
    return { error: 'The saved model preference is invalid. Choose a model to replace it.' }
  }
  const result = agentHostModelSelectionSchema.safeParse(value)
  return result.success
    ? { model: result.data }
    : { error: 'The saved model preference is invalid. Choose a model to replace it.' }
}

export function saveModelPreference(ownerId: string, provider: string, model: ModelSelection | undefined): string | undefined {
  const result = agentHostModelSelectionSchema.optional().safeParse(model)
  if (!result.success) return 'The model preference was not saved because its options are invalid. Correct the model options to remember them.'
  try {
    const key = preferenceKey(ownerId, provider)
    if (result.data) localStorage.setItem(key, JSON.stringify(result.data))
    else localStorage.removeItem(key)
  } catch {
    return 'The model preference could not be saved on this device. Your change applies only while this chat stays open.'
  }
  return undefined
}
