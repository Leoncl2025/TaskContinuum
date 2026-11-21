import type { AgentHostTarget } from './agentHost'
import type { ChatLinkBridge } from './chatLinks'
import type { PersistedPaneTreeState } from './paneTreeSchema'
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
  readonly target?: AgentHostTarget
  readonly sessionKey?: string | null
  readonly draft?: string
  readonly mode?: SessionWindowMode
}

export interface SessionWindowSummary {
  readonly key: string
  readonly taskId: string
  readonly target?: AgentHostTarget
  readonly mode: SessionWindowMode
}

export interface DockedTaskPage {
  readonly taskId: string
  readonly sessionKey?: string | null
  readonly target?: AgentHostTarget
  readonly draft?: string
}

export interface SessionWindowActivatedEvent {
  readonly taskId: string
  readonly target?: AgentHostTarget
  readonly sessionKey?: string | null
  readonly draft?: string
  readonly pages?: readonly DockedTaskPage[]
}

export interface SessionWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly maximized?: boolean
}

export type DesktopWindowContext =
  | { readonly kind: 'main' }
  | {
      readonly kind: 'session'
      readonly windowId: string
      readonly workspaceId: string
      readonly workspaceName: string
      readonly workspaceRoot: string
      readonly task: TaskRecord
      readonly target?: AgentHostTarget
      readonly sessionKey?: string | null
      readonly initialDraft?: string
      readonly initialPaneTree?: PersistedPaneTreeState
    }

export interface DesktopSessionWindowsBridge {
  getContext(): Promise<DesktopWindowContext>
  open(request: SessionWindowOpenRequest): Promise<{ opened: boolean; reused: boolean; windowId?: string }>
  focus(request: { windowId?: string; taskId?: string; target?: AgentHostTarget }): Promise<boolean>
  dock(request?: { windowId?: string; taskId?: string; target?: AgentHostTarget; sessionKey?: string | null; draft?: string; pages?: readonly DockedTaskPage[] }): Promise<void>
  savePaneTree?(tree: PersistedPaneTreeState): Promise<void>
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
