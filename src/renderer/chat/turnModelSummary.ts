import type { ConfigPropertySchema, Message } from '@microsoft/agent-host-protocol'
import { modelConfigValueLabel } from '../../shared/agentHostModelConfig'
import type { AgentHostBridge } from '../../shared/agentHost'

type AgentHostModel = Awaited<ReturnType<AgentHostBridge['models']>>[number]

const KNOWN_LEVEL_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  default: 'Default',
  long_context: 'Long context',
  auto: 'Auto',
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1).toLowerCase() : key
}

function formatCompactNumber(key: string, value: number): string {
  const isContextOrTokens = /context|token/i.test(key)
  if (value >= 1_000_000 && (isContextOrTokens || value % 100_000 === 0)) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (value >= 1_000 && (isContextOrTokens || value % 1_000 === 0)) {
    return `${Math.round(value / 1_000)}K`
  }
  return String(value)
}

function formatFallbackConfigValue(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === 'object') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? formatCompactNumber(key, value) : undefined
  }
  if (typeof value === 'boolean') {
    return value ? humanizeKey(key) : `${humanizeKey(key)}: off`
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const known = KNOWN_LEVEL_LABELS[trimmed.toLowerCase()]
    if (known) return known
    return trimmed.length <= 28 ? trimmed : `${trimmed.slice(0, 27)}…`
  }
  return undefined
}

export interface FormattedModelSummary {
  readonly modelLabel: string
  readonly optionsLabel?: string
  readonly tooltip: string
}

export function formatRequestedModelSummary(
  model: Message['model'] | undefined,
  catalogModels?: readonly AgentHostModel[],
): FormattedModelSummary | undefined {
  if (!model?.id) return undefined
  const catalogModel = catalogModels?.find((entry) => entry.id === model.id)
  const schemaProps = catalogModel?.configSchema?.properties
  const configEntries = Object.entries(model.config ?? {})

  const optionLabels: string[] = []
  const tooltipDetails: string[] = [
    catalogModel && catalogModel.name !== model.id
      ? `Model: ${catalogModel.name} (${model.id})`
      : `Model: ${model.id}`,
  ]

  for (const [key, value] of configEntries) {
    if (value === undefined) continue
    const prop: ConfigPropertySchema | undefined = schemaProps && Object.hasOwn(schemaProps, key) ? schemaProps[key] : undefined
    if (prop) {
      if (typeof value !== 'object' || value === null) {
        optionLabels.push(modelConfigValueLabel(prop, value))
      }
      tooltipDetails.push(`${prop.title || key}: ${modelConfigValueLabel(prop, value)}`)
    } else {
      const compact = formatFallbackConfigValue(key, value)
      if (compact) optionLabels.push(compact)
      tooltipDetails.push(`${humanizeKey(key)}: ${String(value)}`)
    }
  }

  return {
    modelLabel: model.id,
    ...(optionLabels.length > 0 ? { optionsLabel: optionLabels.join(' · ') } : {}),
    tooltip: tooltipDetails.join(' · '),
  }
}
