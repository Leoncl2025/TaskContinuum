import { useState } from 'react'
import { Dialog } from './Primitives'
import { DevTunnelControls } from './DevTunnelControls'
import { RemoteDeviceConnections } from './RemoteDeviceControls'
import { WorkspaceGitSyncControls } from './WorkspaceGitSyncControls'

export function RemoteDevicesDialog({ onClose }: { onClose(): void }) {
  const bridge = window.remoteVSCode
  const [serviceBusy, setServiceBusy] = useState(false)

  return <Dialog title="Remote devices" className="remote-vscode-dialog" onClose={() => { if (!serviceBusy) onClose() }}>
    {!bridge && <p className="copilot-error" role="alert">The remote device desktop API is unavailable.</p>}
    <DevTunnelControls hosting onBusy={setServiceBusy} />
    <WorkspaceGitSyncControls />
    <RemoteDeviceConnections />
  </Dialog>
}
