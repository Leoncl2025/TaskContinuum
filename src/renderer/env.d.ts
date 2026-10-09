import type { DesktopBridge } from '../shared/desktop'
import type { WorkspaceBridge } from '../shared/workspace'
import type { RemoteVSCodeBridge } from '../shared/remoteVSCode'
import type { AgentHostBridge } from '../shared/agentHost'
import type { UpdateBridge } from '../shared/updates'

declare global {
  interface Window {
    desktop?: DesktopBridge
    workspace?: WorkspaceBridge
    remoteVSCode?: RemoteVSCodeBridge
    agentHost?: AgentHostBridge
    updates?: UpdateBridge
  }
}