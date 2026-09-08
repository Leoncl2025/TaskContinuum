export interface DevTunnelStatus {
  installed: boolean
  account?: string
  state: 'idle' | 'signing-in' | 'starting' | 'hosting' | 'offline'
  tunnelId?: string
  hostFingerprint?: string
  error?: string
}

export interface DevTunnelBridge {
  status(refresh?: boolean): Promise<DevTunnelStatus>
  login(): Promise<void>
  publish(): Promise<void>
  stop(): Promise<void>
  cancel(): Promise<void>
  reset(): Promise<void>
  installationGuide(): Promise<void>
}