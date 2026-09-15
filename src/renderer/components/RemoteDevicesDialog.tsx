import { useRef, useState } from 'react'
import type { DevTunnelStatus } from '../../shared/devTunnel'
import { Dialog, Icon } from './Primitives'
import { DevTunnelControls } from './DevTunnelControls'
import { RemoteDeviceAccess, RemoteDeviceConnections } from './RemoteDeviceControls'

export function RemoteDevicesDialog({ onClose }: { onClose(): void }) {
  const bridge = window.remoteVSCode
  const [busy, setBusy] = useState(false)
  const [serviceBusy, setServiceBusy] = useState(false)
  const [status, setStatus] = useState<DevTunnelStatus>()
  const [canSend, setCanSend] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const running = useRef(false)

  async function exportIdentity(): Promise<void> {
    if (!bridge) { setError('The remote device desktop API is unavailable.'); return }
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      if (await bridge.exportIdentity(true)) setNotice('Device identity exported.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The device identity could not be exported.')
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return <Dialog title="Remote devices" className="remote-vscode-dialog" onClose={() => { if (!busy && !serviceBusy) onClose() }}>
    {!bridge && <p className="copilot-error" role="alert">The remote device desktop API is unavailable.</p>}
    <DevTunnelControls hosting onStatus={setStatus} onBusy={setServiceBusy} />
    <RemoteDeviceConnections />
    <label className="form-field">Agent Host workspace access<select aria-label="Linked-session workspace access" value={canSend ? 'send' : 'read'} disabled={busy || serviceBusy} onChange={(event) => setCanSend(event.target.value === 'send')}><option value="send">Read and send</option><option value="read">Read only</option></select></label>
    <RemoteDeviceAccess canSend={canSend} hosting={Boolean(status?.account) && !serviceBusy} />
    <div className="remote-vscode-actions"><button type="button" className="secondary-button" disabled={!bridge || busy || serviceBusy} onClick={() => { void exportIdentity() }}><Icon name="export" />Export device identity</button></div>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
  </Dialog>
}
