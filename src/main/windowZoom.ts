import { join } from 'node:path'
import type { BrowserWindow, Input } from 'electron'
import { z } from 'zod'
import { isTrustedRendererUrl } from './security'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export type ZoomCommand = 'in' | 'out' | 'reset'
export const minimumZoomLevel = -8
export const maximumZoomLevel = 8
const preferencesSchema = z.object({ zoomLevel: z.number().int().min(minimumZoomLevel).max(maximumZoomLevel) }).strict()

export function zoomCommand(input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift' | 'isComposing'>, platform: string = process.platform): ZoomCommand | undefined {
  if (input.type !== 'keyDown' || input.isComposing || input.alt) return undefined
  if (platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta) return undefined
  if (input.code === 'Equal' || input.code === 'NumpadAdd' || input.key === '+' || input.key === '=') return 'in'
  if (input.code === 'Minus' || input.code === 'NumpadSubtract' || input.key === '-') {
    if (platform !== 'linux' || !input.shift) return 'out'
  }
  if (!input.shift && (input.code === 'Digit0' || input.code === 'Numpad0' || input.key === '0')) return 'reset'
  return undefined
}

export function nextZoomLevel(level: number, command: ZoomCommand): number {
  const current = Number.isFinite(level) ? Math.round(level) : 0
  return command === 'reset' ? 0 : Math.max(minimumZoomLevel, Math.min(maximumZoomLevel, current + (command === 'in' ? 1 : -1)))
}

export class WindowZoomPreferences {
  private readonly file: string
  private level = 0
  private loading?: Promise<void>
  private writing: Promise<void> = Promise.resolve()

  constructor(directory: string) { this.file = join(directory, 'window-zoom.json') }

  load(): Promise<void> {
    this.loading ??= (async () => {
      try { this.level = preferencesSchema.parse(await readJsonBounded(this.file, 1024)).zoomLevel } catch { this.level = 0 }
    })()
    return this.loading
  }

  getLevel(): number { return this.level }

  change(command: ZoomCommand): number {
    const zoomLevel = nextZoomLevel(this.level, command)
    this.level = zoomLevel
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, { zoomLevel })).catch(() => {
      console.warn('Window zoom could not be saved. It remains active for this desktop session.')
    })
    return zoomLevel
  }

  flush(): Promise<void> { return this.writing }
}

export function registerWindowZoom(window: BrowserWindow, preferences: WindowZoomPreferences, devUrl?: string): void {
  const contents = window.webContents
  contents.on('before-input-event', (event, input) => {
    const command = zoomCommand(input)
    if (!command || !isTrustedRendererUrl(contents.getURL(), devUrl)) return
    event.preventDefault()
    contents.setZoomLevel(preferences.change(command))
  })
  contents.on('did-finish-load', () => {
    if (isTrustedRendererUrl(contents.getURL(), devUrl)) contents.setZoomLevel(preferences.getLevel())
  })
}