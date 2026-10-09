export type UpdatePhase = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'installing' | 'error'
export type UpdateDistribution = 'nsis' | 'archive' | 'development' | 'unsupported'

export interface UpdateRelease {
  version: string
  name: string
  notes: string
  url: string
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  distribution: UpdateDistribution
  canInstall: boolean
  /** Also downloads verified updates automatically when this installation is eligible. */
  autoCheck: boolean
  release?: UpdateRelease
  progress?: number
  checkedAt?: string
  reason?: string
  error?: string
}

export interface UpdateBridge {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  setAutoCheck(enabled: boolean): Promise<UpdateState>
  openRelease(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  onState(listener: (state: UpdateState) => void): () => void
  onPrepareInstall(listener: (requestId: string) => void): () => void
  respondToInstall(requestId: string, blockers: string[]): Promise<void>
  onInstallAborted(listener: () => void): () => void
}
