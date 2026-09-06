export interface DesktopInfo {
  name: string
  version: string
  platform: string
  security: { contextIsolated: boolean; sandboxed: boolean }
}

export interface DesktopBridge {
  getInfo(): Promise<DesktopInfo>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}