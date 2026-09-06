import type { DesktopBridge } from '../shared/desktop'
import type { CopilotBridge } from '../shared/sessions'

declare global {
  interface Window {
    desktop?: DesktopBridge
    copilot?: CopilotBridge
  }
}