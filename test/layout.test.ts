import { describe, expect, it, vi } from 'vitest'
import { defaultLayout, panelLimits, panelSizes, readLayout, resizePanel, saveLayout } from '../src/renderer/layout'

describe('layout preferences', () => {
  it('starts with Explorer, central chat, task details, and the dark theme', () => expect(readLayout()).toEqual(defaultLayout))
  it('round trips display preferences only', () => {
    const preferences = { ...defaultLayout, sidebar: false, details: false, theme: 'light' as const, sidebarWidth: 320, detailsWidth: 480 }
    saveLayout(preferences)
    expect(readLayout()).toEqual(preferences)
  })
  it('migrates the old right-panel width without overwriting legacy preferences', () => {
    const legacy = { sidebar: false, chat: false, theme: 'light', sidebarWidth: 320, chatWidth: 480 }
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify(legacy))
    const preferences = { ...defaultLayout, sidebar: false, chat: false, theme: 'light' as const, sidebarWidth: 320, detailsWidth: 480 }
    expect(readLayout()).toEqual(preferences)
    saveLayout(preferences)
    expect(JSON.parse(localStorage.getItem('taskcontinuum:layout:v1')!)).toEqual(legacy)
    localStorage.setItem('taskcontinuum:layout:v1', '{}')
    expect(readLayout()).toEqual(preferences)
  })
  it('loads existing settings without widths and validates persisted sizes', () => {
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify({ sidebar: false, chat: true, theme: 'light' }))
    expect(readLayout()).toEqual({ ...defaultLayout, sidebar: false, theme: 'light' })
    localStorage.setItem('taskcontinuum:layout:v2', JSON.stringify({ sidebarWidth: -10, detailsWidth: 9000 }))
    expect(readLayout()).toEqual({ ...defaultLayout, sidebarWidth: panelLimits.sidebar.min, detailsWidth: panelLimits.details.max })
    localStorage.setItem('taskcontinuum:layout:v2', '{"sidebarWidth":"300","detailsWidth":1e999}')
    expect(readLayout()).toEqual(defaultLayout)
  })
  it('handles malformed or untrusted stored shapes', () => {
    localStorage.setItem('taskcontinuum:layout:v2', '{')
    expect(readLayout()).toEqual(defaultLayout)
    localStorage.setItem('taskcontinuum:layout:v2', JSON.stringify({ sidebar: 'false', chat: null, details: 'false', theme: 'other' }))
    expect(readLayout()).toEqual(defaultLayout)
  })
  it('always restores at least one content pane', () => {
    localStorage.setItem('taskcontinuum:layout:v2', JSON.stringify({ chat: false, details: false }))
    expect(readLayout()).toEqual({ ...defaultLayout, details: false })
  })
  it('remains usable when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(readLayout()).toEqual(defaultLayout)
    expect(() => saveLayout(defaultLayout)).not.toThrow()
  })
})

describe('panel width constraints', () => {
  it('preserves the side-panel widths and leaves the remaining space for chat', () => {
    const sizes = panelSizes(defaultLayout, 1440)
    expect(sizes.sidebar.width).toBe(258)
    expect(sizes.details.width).toBe(380)
    expect(sizes.sidebar.max).toBe(600)
    expect(sizes.details.max).toBe(734)
  })

  it('fits oversized preferences without overwriting them on window shrink', () => {
    const preferences = { ...defaultLayout, sidebarWidth: 600, detailsWidth: 960 }
    const sizes = panelSizes(preferences, 1001)
    expect(sizes.sidebar.width).toBeGreaterThanOrEqual(220)
    expect(sizes.details.width).toBeGreaterThanOrEqual(320)
    expect(sizes.sidebar.width + sizes.details.width + 48 + 400).toBe(1001)
    expect(preferences.sidebarWidth).toBe(600)
    expect(panelSizes(preferences, 2400).details.width).toBe(960)
  })

  it('limits resizing without moving the other visible panel', () => {
    const resized = resizePanel(defaultLayout, 'details', 2000, 1440)
    expect(resized).toEqual({ ...defaultLayout, detailsWidth: 734 })
    expect(resizePanel(resized, 'sidebar', 10, 1440)).toEqual({ ...resized, sidebarWidth: 220 })
    expect(resizePanel(resized, 'sidebar', 600, 1440).sidebarWidth).toBe(258)
  })

  it('does not reserve space for hidden panels or forget their preferred width', () => {
    const preferences = { ...defaultLayout, sidebar: false, sidebarWidth: 500 }
    expect(panelSizes(preferences, 1440).details.max).toBe(960)
    expect(resizePanel(preferences, 'details', 900, 1440)).toEqual({ ...preferences, detailsWidth: 900 })
    const oversized = { ...defaultLayout, sidebarWidth: 600, detailsWidth: 960 }
    const resized = resizePanel(oversized, 'sidebar', 220, 1100)
    expect(resized.detailsWidth).toBe(panelSizes(oversized, 1100).details.width)
    for (const layout of [{ ...oversized, details: false }, { ...oversized, chat: false }]) {
      expect(panelSizes(layout, 1100).sidebar.width).toBe(600)
      expect(resizePanel(layout, 'sidebar', 500, 1100).detailsWidth).toBe(960)
    }
  })
})