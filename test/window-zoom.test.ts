// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maximumZoomLevel, minimumZoomLevel, nextZoomLevel, WindowZoomPreferences, zoomCommand } from '../src/main/windowZoom'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
const input = { type: 'keyDown', key: '=', code: 'Equal', control: true, meta: false, alt: false, shift: false, isComposing: false }

describe('VS Code-style window zoom', () => {
  it('uses the primary platform modifier with plus, minus, and reset keys', () => {
    expect(zoomCommand(input, 'win32')).toBe('in')
    expect(zoomCommand({ ...input, key: '+', shift: true }, 'win32')).toBe('in')
    expect(zoomCommand({ ...input, key: '+', code: 'NumpadAdd' }, 'win32')).toBe('in')
    expect(zoomCommand({ ...input, key: '-', code: 'Minus' }, 'win32')).toBe('out')
    expect(zoomCommand({ ...input, key: '_', code: 'Minus', shift: true }, 'win32')).toBe('out')
    expect(zoomCommand({ ...input, key: '-', code: 'NumpadSubtract' }, 'win32')).toBe('out')
    expect(zoomCommand({ ...input, key: '0', code: 'Digit0' }, 'win32')).toBe('reset')
    expect(zoomCommand({ ...input, key: '0', code: 'Numpad0' }, 'win32')).toBe('reset')
    expect(zoomCommand({ ...input, control: false, meta: true }, 'darwin')).toBe('in')
    expect(zoomCommand(input, 'linux')).toBe('in')
  })

  it('leaves ordinary text, composition, key releases, and unrelated shortcuts alone', () => {
    for (const change of [{ control: false }, { alt: true }, { meta: true }, { type: 'keyUp' }, { isComposing: true }, { key: 'b', code: 'KeyB' }, { key: ')', code: 'Digit0', shift: true }]) {
      expect(zoomCommand({ ...input, ...change }, 'win32')).toBeUndefined()
    }
    expect(zoomCommand(input, 'darwin')).toBeUndefined()
    expect(zoomCommand({ ...input, key: '_', code: 'Minus', shift: true }, 'linux')).toBeUndefined()
  })

  it('increments one native level, caps extremes, and resets to the original size', () => {
    expect(nextZoomLevel(0, 'in')).toBe(1)
    expect(1.2 ** nextZoomLevel(1, 'in')).toBeCloseTo(1.44)
    expect(nextZoomLevel(0, 'out')).toBe(-1)
    expect(nextZoomLevel(maximumZoomLevel, 'in')).toBe(8)
    expect(nextZoomLevel(minimumZoomLevel, 'out')).toBe(-8)
    expect(nextZoomLevel(1.1, 'in')).toBe(2)
    expect(nextZoomLevel(Number.NaN, 'out')).toBe(-1)
    expect(nextZoomLevel(8, 'reset')).toBe(0)
  })

  it('persists only zoom, restores after restart, and serializes rapid changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-window-zoom-'))
    directories.push(directory)
    const preferences = new WindowZoomPreferences(directory)
    await preferences.load()
    expect(preferences.getLevel()).toBe(0)
    expect(await readdir(directory)).toEqual([])
    expect(preferences.change('in')).toBe(1)
    expect(preferences.change('in')).toBe(2)
    expect(preferences.change('out')).toBe(1)
    await preferences.flush()
    expect(JSON.parse(await readFile(join(directory, 'window-zoom.json'), 'utf8'))).toEqual({ zoomLevel: 1 })
    const restarted = new WindowZoomPreferences(directory)
    await restarted.load()
    expect(restarted.getLevel()).toBe(1)
    restarted.change('reset')
    await restarted.flush()
    expect(await readdir(directory)).toEqual(['window-zoom.json'])
  })

  it('starts at 100 percent for invalid preferences without changing the file on read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-invalid-zoom-'))
    directories.push(directory)
    const file = join(directory, 'window-zoom.json')
    for (const text of ['{', 'null', '[]', '{"zoomLevel":"2"}', '{"zoomLevel":99}', '{"zoomLevel":1.5}', '{"zoomLevel":2,"extra":true}', ' '.repeat(1025)]) {
      await writeFile(file, text)
      const preferences = new WindowZoomPreferences(directory)
      await preferences.load()
      expect(preferences.getLevel()).toBe(0)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })

  it('keeps zoom usable if the optional preference cannot be written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-blocked-zoom-'))
    directories.push(directory)
    const blocked = join(directory, 'not-a-directory')
    await writeFile(blocked, '')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preferences = new WindowZoomPreferences(blocked)
    await preferences.load()
    expect(preferences.change('in')).toBe(1)
    await preferences.flush()
    expect(preferences.getLevel()).toBe(1)
    expect(warning).toHaveBeenCalledOnce()
  })
})