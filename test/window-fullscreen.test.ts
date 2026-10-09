// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isFullscreenShortcut } from '../src/main/windowFullscreen'

const input = { type: 'keyDown', key: 'F11', code: 'F11', control: false, meta: false, alt: false, shift: false, isComposing: false, isAutoRepeat: false }

describe('native full-screen shortcuts', () => {
  it('accepts F11 and the Visual Studio Shift+Alt+Enter shortcut', () => {
    expect(isFullscreenShortcut(input)).toBe(true)
    expect(isFullscreenShortcut({ ...input, key: 'Enter', code: 'Enter', alt: true, shift: true })).toBe(true)
  })

  it('does not intercept typing, Escape, composition, repeats or unrelated modifier combinations', () => {
    for (const change of [
      { type: 'keyUp' }, { isAutoRepeat: true }, { isComposing: true }, { control: true }, { meta: true },
      { alt: true }, { shift: true }, { key: 'Escape', code: 'Escape' }, { key: 'Enter', code: 'Enter' },
      { key: 'Enter', code: 'Enter', alt: true }, { key: 'Enter', code: 'Enter', shift: true },
      { key: 'Enter', code: 'Enter', alt: true, shift: true, control: true },
    ]) expect(isFullscreenShortcut({ ...input, ...change })).toBe(false)
  })
})
