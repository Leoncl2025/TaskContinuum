import { describe, expect, it, vi } from 'vitest'
import { readModelPreference, saveModelPreference } from '../src/renderer/chat/modelPreferences'

describe('local model preferences', () => {
  it('requires an explicit choice when no preference exists', () => {
    expect(readModelPreference('owner', 'copilotcli')).toEqual({})
    expect(localStorage.length).toBe(0)
  })

  it('round-trips the model and typed options without storing conversation data', () => {
    const model = { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000, enabled: false, budget: 0, optional: null } }
    expect(saveModelPreference('owner', 'copilotcli', model)).toBeUndefined()
    expect(readModelPreference('owner', 'copilotcli')).toEqual({ model })
    expect(localStorage.length).toBe(1)
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual(model)
  })

  it('separates owners and providers and clears only the chosen preference', () => {
    saveModelPreference('owner-a', 'copilotcli', { id: 'model-a' })
    saveModelPreference('owner-b', 'copilotcli', { id: 'model-b' })
    saveModelPreference('owner-a', 'another-provider', { id: 'model-c' })
    expect(readModelPreference('owner-a', 'copilotcli')).toEqual({ model: { id: 'model-a' } })
    expect(readModelPreference('owner-b', 'copilotcli')).toEqual({ model: { id: 'model-b' } })
    expect(readModelPreference('owner-a', 'another-provider')).toEqual({ model: { id: 'model-c' } })
    expect(saveModelPreference('owner-a', 'copilotcli', undefined)).toBeUndefined()
    expect(readModelPreference('owner-a', 'copilotcli')).toEqual({})
    expect(readModelPreference('owner-b', 'copilotcli')).toEqual({ model: { id: 'model-b' } })
    expect(readModelPreference('owner-a', 'another-provider')).toEqual({ model: { id: 'model-c' } })
  })

  it.each([
    '{',
    'null',
    '[]',
    '{"id":""}',
    '{"id":42}',
    '{"id":"gpt-6","config":{"contextSize":1e999}}',
    '{"id":"gpt-6","config":{"option":{"nested":true}}}',
    '{"id":"gpt-6","prompt":"must not become a preference"}',
  ])('reports invalid stored preferences rather than using them: %s', (stored) => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(stored)
    expect(readModelPreference('owner', 'copilotcli')).toEqual({ error: expect.stringContaining('invalid') })
  })

  it('keeps the prior preference when a numeric edit cannot be serialized faithfully', () => {
    saveModelPreference('owner', 'copilotcli', { id: 'gpt-6', config: { budget: 42 } })
    expect(saveModelPreference('owner', 'copilotcli', { id: 'gpt-6', config: { budget: NaN } })).toContain('not saved')
    expect(readModelPreference('owner', 'copilotcli')).toEqual({ model: { id: 'gpt-6', config: { budget: 42 } } })
  })

  it('reports storage read, write, and clear failures without discarding the current UI choice', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(readModelPreference('owner', 'copilotcli')).toEqual({ error: expect.stringContaining('could not be read') })
    expect(saveModelPreference('owner', 'copilotcli', { id: 'gpt-6' })).toContain('could not be saved')
    expect(saveModelPreference('owner', 'copilotcli', undefined)).toContain('could not be saved')
  })
})
