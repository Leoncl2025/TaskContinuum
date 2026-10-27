import type { ChatLinkBridge } from './chatLinks'

export interface DesktopInfo {
  name: string
  version: string
  platform: string
  security: { contextIsolated: boolean; sandboxed: boolean }
}

export interface DesktopBridge {
  links?: ChatLinkBridge
  getInfo(): Promise<DesktopInfo>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  getFullScreen(): Promise<boolean>
  toggleFullScreen(): Promise<void>
  onFullScreenChanged(listener: (fullScreen: boolean) => void): () => void
  close(): Promise<void>
  copyText(text: string): Promise<void>
}
