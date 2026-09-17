import { useEffect, useRef, useState } from 'react'
import type { RemoteVSCodeBridge } from '../../shared/remoteVSCode'
import { Icon, IconButton } from './Primitives'

type Device = Awaited<ReturnType<NonNullable<RemoteVSCodeBridge['devices']>['list']>>[number]

export function RemoteDeviceConnections() {
  const api = window.remoteVSCode?.devices
  const [devices, setDevices] = useState<Device[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const running = useRef(false)
  useEffect(() => {
    let active = true
    const refresh = () => { void api?.list().then((value) => { if (active) setDevices(value) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Device list unavailable.') }) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [api])
  async function run(id: string, action: () => Promise<unknown>) {
    if (!api || running.current) return
    running.current = true
    setBusy(id)
    setError(undefined)
    try { await action(); setDevices(await api.list()) } catch (failure) { setError(failure instanceof Error ? failure.message : 'Device operation failed.') }
    finally { running.current = false; setBusy(undefined) }
  }
  if (!api) return null
  return <div className="remote-device-controls remote-connections">
    <h3>Devices</h3>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {!devices && !error && <p className="remote-device-empty" role="status">Loading devices...</p>}
    {devices?.length === 0 && !error && <p className="remote-device-empty"><Icon name="device-desktop" />No linked devices</p>}
    {devices?.map((device) => <div className="remote-vscode-row" key={device.id}>
      <div className="remote-vscode-row-title"><Icon name="device-desktop" /><strong>{device.machineName}</strong><span className="muted">{device.state}</span></div>
      {device.error && <p className="copilot-error">{device.error}</p>}
      <div className="remote-vscode-actions">
        <IconButton icon={device.enabled ? 'debug-disconnect' : 'plug'} label={`${device.enabled ? 'Disconnect device' : 'Connect device'} ${device.machineName}`} disabled={!!busy && busy !== device.id} onClick={() => {
          if (device.enabled || busy === device.id) void api.disconnect(device.id).then(() => api.list()).then(setDevices).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Disconnect failed.'))
          else void run(device.id, () => api.connect(device.id))
        }} />
        <IconButton icon="refresh" label={`Reconnect device ${device.machineName}`} disabled={!!busy} onClick={() => { void run(device.id, () => api.connect(device.id)) }} />
        <IconButton icon="trash" label={`Forget device ${device.machineName}`} disabled={!!busy} onClick={() => { void run(device.id, () => api.forget(device.id)) }} />
      </div>
    </div>)}
  </div>
}