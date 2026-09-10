import { describe, expect, it, vi } from 'vitest'
import { defaultLayout, panelLimits, panelSizes, readLayout, resizePanel, saveLayout } from '../src/renderer/layout'

describe('layout preferences', () => {
  it('starts with both desktop panels and the dark theme', () => expect(readLayout()).toEqual(defaultLayout))
  it('round trips display preferences only', () => {
    const preferences = { ...defaultLayout, sidebar: false, theme: 'light' as const, sidebarWidth: 320, chatWidth: 480 }
    saveLayout(preferences)
    expect(readLayout()).toEqual(preferences)
  })
  it('loads existing settings without widths and validates persisted sizes', () => {
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify({ sidebar: false, chat: true, theme: 'light' }))
    expect(readLayout()).toEqual({ ...defaultLayout, sidebar: false, theme: 'light' })
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify({ sidebarWidth: -10, chatWidth: 9000 }))
    expect(readLayout()).toEqual({ ...defaultLayout, sidebarWidth: panelLimits.sidebar.min, chatWidth: panelLimits.chat.max })
    localStorage.setItem('taskcontinuum:layout:v1', '{"sidebarWidth":"300","chatWidth":1e999}')
    expect(readLayout()).toEqual(defaultLayout)
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

describe('panel width constraints', () => {
  it('preserves the default desktop widths and leaves room for the task editor', () => {
    const sizes = panelSizes(defaultLayout, 1440)
    expect(sizes.sidebar.width).toBe(258)
    expect(sizes.chat.width).toBe(355)
    expect(sizes.sidebar.max).toBe(600)
    expect(sizes.chat.max).toBe(734)
  })

  it('fits oversized preferences without overwriting them on window shrink', () => {
    const preferences = { ...defaultLayout, sidebarWidth: 600, chatWidth: 960 }
    const sizes = panelSizes(preferences, 1001)
    expect(sizes.sidebar.width).toBeGreaterThanOrEqual(220)
    expect(sizes.chat.width).toBeGreaterThanOrEqual(310)
    expect(sizes.sidebar.width + sizes.chat.width + 48 + 400).toBe(1001)
    expect(preferences.sidebarWidth).toBe(600)
    expect(panelSizes(preferences, 2400).chat.width).toBe(960)
  })

  it('limits resizing without moving the other visible panel', () => {
    const resized = resizePanel(defaultLayout, 'chat', 2000, 1440)
    expect(resized).toEqual({ ...defaultLayout, chatWidth: 734 })
    expect(resizePanel(resized, 'sidebar', 10, 1440)).toEqual({ ...resized, sidebarWidth: 220 })
    expect(resizePanel(resized, 'sidebar', 600, 1440).sidebarWidth).toBe(258)
  })

  it('does not reserve space for hidden panels or forget their preferred width', () => {
    const preferences = { ...defaultLayout, sidebar: false, sidebarWidth: 500 }
    expect(panelSizes(preferences, 1440).chat.max).toBe(960)
    expect(resizePanel(preferences, 'chat', 900, 1440)).toEqual({ ...preferences, chatWidth: 900 })
    const resized = resizePanel({ ...defaultLayout, sidebarWidth: 600, chatWidth: 960 }, 'sidebar', 220, 1100)
    expect(resized.chatWidth).toBe(panelSizes({ ...defaultLayout, sidebarWidth: 600, chatWidth: 960 }, 1100).chat.width)
  })
})