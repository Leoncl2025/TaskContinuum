import type { DesktopBridge } from '../shared/desktop'
import type { CopilotBridge } from '../shared/sessions'
import type { WorkspaceBridge } from '../shared/workspace'
import type { SharedDesktopBridge } from '../shared/sharedSessions'

declare global {
  interface Window {
    desktop?: DesktopBridge
    copilot?: CopilotBridge
    workspace?: WorkspaceBridge
    sharedSessions?: SharedDesktopBridge
  }
}