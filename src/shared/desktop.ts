import type { AgentHostTarget } from './agentHost'
import type { ChatLinkBridge } from './chatLinks'
import type { TaskRecord } from './tasks'

export interface DesktopInfo {
  name: string
  version: string
  platform: string
  security: { contextIsolated: boolean; sandboxed: boolean }
}

export type SessionWindowMode = 'move' | 'copy'

export interface SessionWindowOpenRequest {
  readonly taskId: string
  readonly target: AgentHostTarget
  readonly draft?: string
  readonly mode?: SessionWindowMode
}

export interface SessionWindowSummary {
  readonly key: string
  readonly taskId: string
  readonly target: AgentHostTarget
  readonly mode: SessionWindowMode
}

export interface SessionWindowActivatedEvent {
  readonly taskId: string
  readonly target: AgentHostTarget
  readonly draft?: string
}

export type DesktopWindowContext =
  | { readonly kind: 'main' }
  | {
      readonly kind: 'session'
      readonly workspaceId: string
      readonly workspaceName: string
      readonly workspaceRoot: string
      readonly task: TaskRecord
      readonly target: AgentHostTarget
      readonly initialDraft?: string
    }

export interface DesktopSessionWindowsBridge {
  getContext(): Promise<DesktopWindowContext>
  open(request: SessionWindowOpenRequest): Promise<{ opened: boolean; reused: boolean }>
  focus(request: Pick<SessionWindowOpenRequest, 'taskId' | 'target'>): Promise<boolean>
  dock(request?: { taskId?: string; target?: AgentHostTarget; draft?: string }): Promise<void>
  list(): Promise<SessionWindowSummary[]>
  onChanged(listener: (windows: SessionWindowSummary[]) => void): () => void
  onActivateSession(listener: (event: SessionWindowActivatedEvent) => void): () => void
}

export interface DesktopBridge {
  links?: ChatLinkBridge
  windows?: DesktopSessionWindowsBridge
  getInfo(): Promise<DesktopInfo>
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  getFullScreen(): Promise<boolean>
  toggleFullScreen(): Promise<void>
  onFullScreenChanged(listener: (fullScreen: boolean) => void): () => void
  close(): Promise<void>
  copyText(text: string): Promise<void>
}
