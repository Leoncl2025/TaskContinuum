import type { BrowserWindow, Input } from 'electron'
import { isTrustedRendererUrl } from './security'

export function isFullscreenShortcut(input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt' | 'shift' | 'isComposing' | 'isAutoRepeat'>): boolean {
  if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat || input.control || input.meta) return false
  return !input.alt && !input.shift && input.key === 'F11'
    || input.alt && input.shift && (input.code === 'Enter' || input.key === 'Enter')
}

export function toggleWindowFullscreen(window: BrowserWindow): void {
  window.setFullScreen(!window.isFullScreen())
}

export function registerWindowFullscreen(window: BrowserWindow, devUrl?: string): void {
  const contents = window.webContents
  const publish = (fullScreen: boolean) => {
    if (!contents.isDestroyed() && isTrustedRendererUrl(contents.getURL(), devUrl)) {
      contents.send('desktop:full-screen-changed', fullScreen)
    }
  }
  contents.on('before-input-event', (event, input) => {
    if (!isFullscreenShortcut(input) || !isTrustedRendererUrl(contents.getURL(), devUrl)) return
    event.preventDefault()
    toggleWindowFullscreen(window)
  })
  window.on('enter-full-screen', () => publish(true))
  window.on('leave-full-screen', () => publish(false))
  contents.on('did-finish-load', () => publish(window.isFullScreen()))
}
