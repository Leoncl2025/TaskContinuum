import type { DesktopBridge } from '../shared/desktop'
import type { CopilotBridge } from '../shared/sessions'
import type { WorkspaceBridge } from '../shared/workspace'
import type { SharedDesktopBridge } from '../shared/sharedSessions'
import type { VSCodeChatBridge } from '../shared/vscodeChat'

declare global {
  interface Window {
    desktop?: DesktopBridge
    copilot?: CopilotBridge
    workspace?: WorkspaceBridge
    sharedSessions?: SharedDesktopBridge
    vscodeChat?: VSCodeChatBridge
  }
}