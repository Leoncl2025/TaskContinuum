import type { ConfigSchema } from '@microsoft/agent-host-protocol'
import { modelConfigValueLabel } from '../../shared/agentHostModelConfig'
import type { ModelConfig } from '../../shared/agentHostModelConfig'

export function AgentHostModelConfig({ schema, config, disabled, onChange }: { schema?: ConfigSchema; config: ModelConfig; disabled: boolean; onChange(config: ModelConfig): void }) {
  function update(key: string, value: ModelConfig[string] | undefined): void {
    const next = { ...config }
    if (value === undefined) delete next[key]
    onChange(value === undefined ? next : { ...next, [key]: value })
  }
  const properties = Object.entries(schema?.properties ?? {})
  if (!properties.length && !Object.keys(config).length) return <p className="message-notice">The Host advertises no configuration options for this model.</p>
  return <fieldset className="ahp-model-config" disabled={disabled}>
    <legend>Model options</legend>
    {properties.map(([key, property]) => {
      const hasValue = Object.hasOwn(config, key)
      const value = hasValue ? config[key] : undefined
      const defaultLabel = property.default === undefined ? 'Default (Host)' : `Default (${modelConfigValueLabel(property, property.default)})`
      const choices = property.enum ?? (property.type === 'boolean' ? [true, false] : undefined)
      const unsupported = !choices && property.type !== 'string' && property.type !== 'number'
      const selectedIndex = choices?.findIndex((choice) => choice === value) ?? -1
      return <div className="ahp-model-option" key={key}>
        {choices ? <label title={property.description}>{property.title}<select aria-label={property.title} value={!hasValue ? '' : selectedIndex < 0 ? 'unavailable' : String(selectedIndex)} disabled={property.readOnly} onChange={(event) => update(key, event.target.value === '' ? undefined : choices[Number(event.target.value)])}>
          <option value="">{defaultLabel}</option>
          {hasValue && selectedIndex < 0 && <option value="unavailable" disabled>{String(value)} (unavailable)</option>}
          {choices.map((choice, index) => <option key={index} value={String(index)} title={property.enumDescriptions?.[index]}>{modelConfigValueLabel(property, choice)}</option>)}
        </select></label> : unsupported ? <p className="message-notice">{property.title}: {defaultLabel}. {property.type} options cannot be sent as model configuration.</p> : <>
          <label title={property.description}>{property.title}<input aria-label={property.title} type={property.type === 'number' ? 'number' : 'text'} step={property.type === 'number' ? 'any' : undefined} maxLength={property.type === 'string' ? 2000 : undefined} disabled={!hasValue || property.readOnly} value={value === undefined || value === null || typeof value === 'number' && !Number.isFinite(value) ? '' : String(value)} onChange={(event) => update(key, property.type === 'number' ? event.target.value === '' ? NaN : Number(event.target.value) : event.target.value)} /></label>
          <label className="ahp-model-default"><input type="checkbox" checked={!hasValue} disabled={property.readOnly} onChange={(event) => update(key, event.target.checked ? undefined : property.type === 'number' ? typeof property.default === 'number' ? property.default : 0 : typeof property.default === 'string' ? property.default : '')} />{defaultLabel}</label>
        </>}
        {property.readOnly && <span className="muted">Read only</span>}
      </div>
    })}
    <button type="button" className="text-button" disabled={!Object.keys(config).length} onClick={() => onChange({})}>Reset model options to defaults</button>
  </fieldset>
}
