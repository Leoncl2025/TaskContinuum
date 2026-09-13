import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigSchema } from '@microsoft/agent-host-protocol'
import { AgentHostModelConfig } from '../src/renderer/components/AgentHostModelConfig'
import { agentHostModelConfigSchema, modelConfigErrors } from '../src/shared/agentHostModelConfig'
import type { ModelConfig } from '../src/shared/agentHostModelConfig'
import { modelConfigFixture } from './agent-host-model-fixture'

describe('Host model configuration', () => {
  it('preserves schema metadata and validates defaults, required options, types, and enum membership', () => {
    expect(agentHostModelConfigSchema.parse(modelConfigFixture)).toEqual(modelConfigFixture)
    expect(modelConfigErrors(modelConfigFixture, {})).toEqual([])
    expect(modelConfigErrors(modelConfigFixture, { thinkingLevel: 'max', contextSize: 872000 })).toEqual([])
    expect(modelConfigErrors(modelConfigFixture, { contextSize: '872000' })).toEqual([expect.stringContaining('unsupported value')])
    expect(modelConfigErrors(modelConfigFixture, { thinkingLevel: 'ultra' })).toHaveLength(1)
    expect(modelConfigErrors(undefined, { thinkingLevel: 'max' })).toEqual(['Unknown model option: thinkingLevel.'])
    const schema: ConfigSchema = { type: 'object', required: ['count', 'text'], properties: { count: { type: 'number', title: 'Count', default: 0 }, text: { type: 'string', title: 'Text' }, fixed: { type: 'boolean', title: 'Fixed', readOnly: true, default: false } } }
    expect(modelConfigErrors(schema, {})).toEqual(['Text requires an explicit value.'])
    expect(modelConfigErrors(schema, { text: '' })).toEqual([])
    expect(modelConfigErrors(schema, { text: '', count: NaN })).toHaveLength(1)
    expect(modelConfigErrors(schema, { text: '', fixed: false })).toEqual(['Fixed is read-only. Reset it to Default.'])
    expect(modelConfigErrors(schema, { text: '', constructor: 'not a property' })).toEqual(['Unknown model option: constructor.'])
  })

  it('round-trips boolean and null enums, free text and numbers, and reset without coercion', async () => {
    const changed = vi.fn()
    const schema: ConfigSchema = { type: 'object', properties: {
      flag: { type: 'boolean', title: 'Feature flag', default: false },
      mode: { type: 'string', title: 'Mode', enum: [null, 'default'], enumLabels: ['None', 'Literal default'] },
      text: { type: 'string', title: 'Instructions' },
      number: { type: 'number', title: 'Budget' },
      locked: { type: 'string', title: 'Locked', enum: ['fixed'], default: 'fixed', readOnly: true },
    } }
    function Harness() {
      const [config, setConfig] = useState<ModelConfig>({})
      return <AgentHostModelConfig schema={schema} config={config} disabled={false} onChange={(value) => { setConfig(value); changed(value) }} />
    }
    const user = userEvent.setup()
    render(<Harness />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Feature flag' }), screen.getByRole('option', { name: 'false' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mode' }), screen.getByRole('option', { name: 'None' }))
    expect(changed).toHaveBeenLastCalledWith({ flag: false, mode: null })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Mode' }), screen.getByRole('option', { name: 'Literal default' }))
    const defaults = screen.getAllByRole('checkbox')
    await user.click(defaults[0])
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'custom')
    await user.click(defaults[1])
    const budget = screen.getByRole('spinbutton', { name: 'Budget' })
    await user.clear(budget)
    await user.type(budget, '42')
    expect(changed).toHaveBeenLastCalledWith({ flag: false, mode: 'default', text: 'custom', number: 42 })
    expect(screen.getByRole('combobox', { name: 'Locked' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reset model options to defaults' }))
    expect(changed).toHaveBeenLastCalledWith({})
  })

  it('displays unsupported structured options rather than silently offering invalid values', () => {
    const schema: ConfigSchema = { type: 'object', properties: { structured: { type: 'object', title: 'Structured option', default: { enabled: true } } } }
    expect(agentHostModelConfigSchema.parse(schema)).toEqual(schema)
    render(<AgentHostModelConfig schema={schema} config={{}} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByText(/object options cannot be sent/)).toBeInTheDocument()
  })

  it('allows clearing stale overrides when a refreshed model no longer advertises a schema', async () => {
    const changed = vi.fn()
    render(<AgentHostModelConfig config={{ thinkingLevel: 'max' }} disabled={false} onChange={changed} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reset model options to defaults' }))
    expect(changed).toHaveBeenCalledExactlyOnceWith({})
  })
})
