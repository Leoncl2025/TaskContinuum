import { describe, expect, it, vi } from 'vitest'
import { defaultLayout, readLayout, saveLayout } from '../src/renderer/layout'

describe('layout preferences', () => {
  it('starts with both desktop panels and the dark theme', () => expect(readLayout()).toEqual(defaultLayout))
  it('round trips display preferences only', () => {
    saveLayout({ sidebar: false, chat: true, theme: 'light' })
    expect(readLayout()).toEqual({ sidebar: false, chat: true, theme: 'light' })
  })
  it('handles malformed or untrusted stored shapes', () => {
    localStorage.setItem('taskcontinuum:layout:v1', '{')
    expect(readLayout()).toEqual(defaultLayout)
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify({ sidebar: 'false', chat: null, theme: 'other' }))
    expect(readLayout()).toEqual(defaultLayout)
  })
  it('remains usable when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(readLayout()).toEqual(defaultLayout)
    expect(() => saveLayout(defaultLayout)).not.toThrow()
  })
})