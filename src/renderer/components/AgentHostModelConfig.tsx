import { useEffect, useId, useRef, useState } from 'react'
import type { ConfigSchema } from '@microsoft/agent-host-protocol'
import { modelConfigValueLabel } from '../../shared/agentHostModelConfig'
import type { ModelConfig } from '../../shared/agentHostModelConfig'
import { Icon, IconButton } from './Primitives'

type ModelConfigProps = { schema?: ConfigSchema; config: ModelConfig; disabled: boolean; onChange(config: ModelConfig): void }

export function AgentHostModelOptions({ schema, config, disabled, onChange }: ModelConfigProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const properties = Object.entries(schema?.properties ?? {})
  const summary = properties.flatMap(([key, property]) => {
    const value = Object.hasOwn(config, key) ? config[key] : property.default
    return value === undefined || typeof value === 'object' && value !== null ? [] : [modelConfigValueLabel(property, value)]
  }).join(' · ') || 'Model options'
  useEffect(() => {
    if (!open) return
    popup.current?.focus()
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  if (!properties.length && !Object.keys(config).length) return null
  function close() {
    setOpen(false)
    trigger.current?.focus()
  }
  return <div className="ahp-model-options" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }} onKeyDown={(event) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
  }}>
    <button ref={trigger} type="button" className="ahp-options-trigger" aria-label="Model options" title={summary}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <span>{summary}</span><Icon name="chevron-down" />
    </button>
    {open && <div ref={popup} id={id} className="ahp-options-popup" role="dialog" aria-label="Model options" tabIndex={-1}>
      <header><strong>Model options</strong><IconButton icon="close" label="Close model options" onClick={close} /></header>
      <AgentHostModelConfig schema={schema} config={config} disabled={disabled} onChange={onChange} />
    </div>}
  </div>
}

export function AgentHostModelConfig({ schema, config, disabled, onChange }: ModelConfigProps) {
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
