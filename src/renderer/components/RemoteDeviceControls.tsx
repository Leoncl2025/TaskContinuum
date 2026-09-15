import { useEffect, useRef, useState } from 'react'
import type { VSCodeChatIdentity } from '../../shared/vscodeChat'
import type { RemoteVSCodeBridge } from '../../shared/remoteVSCode'
import { Icon, IconButton } from './Primitives'
import { WorkspaceGitSyncControls } from './WorkspaceGitSyncControls'

type Device = Awaited<ReturnType<NonNullable<RemoteVSCodeBridge['devices']>['list']>>[number]
type Recipient = Awaited<ReturnType<NonNullable<RemoteVSCodeBridge['devices']>['recipients']>>[number]

export function RemoteDeviceConnections() {
  const api = window.remoteVSCode?.devices
  const [devices, setDevices] = useState<Device[]>([])
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
  return <div className="remote-device-controls">
    <h3>Devices</h3>
    <WorkspaceGitSyncControls />
    <button type="button" className="secondary-button" disabled={!!busy} onClick={() => { void run('import', () => api.import()) }}><Icon name="import" />Import device invitation</button>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {devices.map((device) => <div className="remote-vscode-row" key={device.id}>
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

export function RemoteDeviceAccess({ identity, canSend, hosting }: { identity?: VSCodeChatIdentity; canSend: boolean; hosting: boolean }) {
  const api = window.remoteVSCode?.devices
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()
  const running = useRef(false)
  useEffect(() => {
    let active = true
    void api?.recipients().then((value) => { if (active) setRecipients(value) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Paired devices unavailable.') })
    return () => { active = false }
  }, [api])
  async function run(action: () => Promise<unknown>, notice: string) {
    if (!api || running.current) return
    running.current = true
    setBusy(true); setError(undefined); setMessage(undefined)
    try { const result = await action(); setRecipients(await api.recipients()); if (result !== false) setMessage(notice) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Device access failed.') }
    finally { running.current = false; setBusy(false) }
  }
  if (!api) return null
  return <div className="remote-device-controls">
    <h3>Paired devices</h3>
    <button type="button" className="secondary-button" disabled={busy || !hosting} onClick={() => { void run(() => api.pair(canSend), 'Device invitation saved; linked-session workspace policy enabled.') }}><Icon name="person-add" />Pair device</button>
    {!identity && api.adoptLinks && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => api.adoptLinks!(), 'Local owner links registered. Refresh the workspace before committing.') }}><Icon name="check" />Register existing local links</button>}
    <label className="form-field">Recipient device<select aria-label="Paired recipient device" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}><option value="">Select device</option>{recipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.username} @ {recipient.machineName}</option>)}</select></label>
    <div className="remote-vscode-actions">
      {identity ? <><button type="button" className="primary-button" disabled={busy || !selected} onClick={() => { void run(() => api.share(selected, identity, canSend), 'Session access saved for the paired device.') }}><Icon name="share" />Share session</button><IconButton icon="circle-slash" label="Remove device access to this session" disabled={busy || !selected} onClick={() => { void run(() => api.unshare(selected, identity), 'Session access removed.') }} /></> : <>
        <button type="button" className="primary-button" disabled={busy || !selected || !api.workspace} onClick={() => { void run(() => api.workspace!(selected, canSend ? 'send' : 'read'), 'Linked-session workspace access enabled.') }}><Icon name="link" />Enable linked sessions</button>
        <IconButton icon="circle-slash" label="Disable linked sessions for this workspace" disabled={busy || !selected || !api.workspace} onClick={() => { void run(() => api.workspace!(selected, 'none'), 'Linked-session workspace access disabled.') }} />
      </>}
      <IconButton icon="debug-disconnect" label="Revoke paired device" disabled={busy || !selected} onClick={() => { void run(() => api.revoke(selected), 'Device revoked.'); setSelected('') }} />
    </div>
    {!identity && selected && <p className="muted">Workspace access: {recipients.find((item) => item.id === selected)?.linkedAccess ?? 'none'}</p>}
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {message && <p role="status" className="muted">{message}</p>}
  </div>
}