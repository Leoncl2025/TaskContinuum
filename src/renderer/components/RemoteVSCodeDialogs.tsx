import { useEffect, useRef, useState } from 'react'
import type { RemoteVSCodeConnection, RemoteVSCodeGrant } from '../../shared/remoteVSCode'
import type { VSCodeChatIdentity } from '../../shared/vscodeChat'
import { Dialog, Icon, IconButton } from './Primitives'
import { DevTunnelControls, RemoteTransportPicker } from './DevTunnelControls'
import type { DevTunnelStatus } from '../../shared/devTunnel'
import { RemoteDeviceAccess, RemoteDeviceConnections } from './RemoteDeviceControls'

export function RemoteVSCodeDialog({ taskId, onLink, onClose }: { taskId?: string; onLink(connection: RemoteVSCodeConnection): Promise<void>; onClose(): void }) {
  const bridge = window.remoteVSCode
  const [connections, setConnections] = useState<RemoteVSCodeConnection[]>([])
  const [hostAlias, setHostAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [managed, setManaged] = useState(Boolean(bridge?.devTunnels))
  const [serviceBusy, setServiceBusy] = useState(false)
  const [connectingId, setConnectingId] = useState<string>()
  const [deviceCanSend, setDeviceCanSend] = useState(true)
  const [deviceStatus, setDeviceStatus] = useState<DevTunnelStatus>()
  const running = useRef(false)
  useEffect(() => {
    let active = true
    const refresh = () => { void bridge?.list().then((value) => { if (active) setConnections(value) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Remote connections could not be loaded.') }) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge])
  async function run(action: () => Promise<void>): Promise<void> {
    if (!bridge || running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try { await action(); setConnections(await bridge.list()) } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The remote VS Code operation failed.')
    } finally { running.current = false; setBusy(false) }
  }
  return <Dialog title="Remote VS Code sessions" className="remote-vscode-dialog" onClose={() => { if (!busy && !serviceBusy) onClose() }}>
    {bridge?.devTunnels && <RemoteTransportPicker managed={managed} disabled={busy || serviceBusy} onChange={setManaged} />}
    {managed && <DevTunnelControls hosting onStatus={setDeviceStatus} onBusy={setServiceBusy} />}
    {managed && <RemoteDeviceConnections />}
    {managed && <><label className="form-field">Linked-session access<select aria-label="Linked-session workspace access" value={deviceCanSend ? 'send' : 'read'} onChange={(event) => setDeviceCanSend(event.target.value === 'send')}><option value="send">Read and send</option><option value="read">Read only</option></select></label><RemoteDeviceAccess canSend={deviceCanSend} hosting={Boolean(deviceStatus?.account) && !serviceBusy} /></>}
    <div className="remote-vscode-actions"><button type="button" className="secondary-button" disabled={!bridge || busy || serviceBusy} onClick={() => { void run(async () => { if (await (managed ? bridge!.exportIdentity(true) : bridge!.exportIdentity())) setNotice('Client identity exported.') }) }}><Icon name="export" />Export client identity</button><IconButton icon="refresh" label="Refresh remote connections" disabled={!bridge || busy} onClick={() => { void run(async () => {}) }} /></div>
    <details open={!managed}><summary>Legacy session invitation</summary><form className="remote-vscode-import" onSubmit={(event) => { event.preventDefault(); void run(async () => { const imported = await (managed ? bridge!.importInvitation() : bridge!.importInvitation(hostAlias.trim())); if (imported) setNotice(`Invitation imported for ${imported.execution.machineName}.`) }) }}>
      {!managed && <label className="form-field">SSH host alias<input aria-label="SSH host alias" value={hostAlias} maxLength={150} placeholder="copilot-owner" onChange={(event) => setHostAlias(event.target.value)} /></label>}
      <button type="submit" className="primary-button" disabled={!bridge || busy || serviceBusy || !managed && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(hostAlias.trim())}><Icon name="import" />Import invitation</button>
    </form></details>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
    <div className="remote-vscode-list" aria-busy={busy}>
      {!connections.length && <p className="muted">No remote invitations.</p>}
      {connections.map((connection) => <section className="remote-vscode-row" key={connection.id} aria-label={`Remote ${connection.title}`}>
        <div className="remote-vscode-row-title"><Icon name="remote" /><strong>{connection.title}</strong><span className="muted">{connectingId === connection.id ? 'connecting' : connection.state}</span></div>
        <dl className="remote-vscode-meta"><div><dt>Agent</dt><dd>{connection.execution.agentName} @ {connection.execution.machineName}</dd></div><div><dt>Participant</dt><dd>{connection.participant.username} @ {connection.participant.machineName}</dd></div><div><dt>Transport</dt><dd>{connection.transport === 'dev-tunnel' ? 'Dev Tunnel + SSH' : connection.hostAlias}</dd></div><div><dt>Access</dt><dd>{connection.canSend ? 'Read and send' : 'Read only'}</dd></div><div><dt>Expires</dt><dd><time dateTime={connection.expiresAt}>{new Date(connection.expiresAt).toLocaleString()}</time></dd></div></dl>
        <div className="remote-vscode-actions">{!connection.deviceId && (connectingId === connection.id ? <IconButton icon="close" label={`Cancel connection to ${connection.execution.machineName}`} onClick={() => { void bridge!.disconnect(connection.id).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Disconnect failed.')) }} /> : <IconButton icon={connection.state === 'connected' ? 'debug-disconnect' : 'plug'} label={`${connection.state === 'connected' ? 'Disconnect' : 'Connect'} ${connection.execution.machineName}`} disabled={busy || serviceBusy} onClick={() => { void run(async () => { if (connection.state === 'connected') await bridge!.disconnect(connection.id); else { setConnectingId(connection.id); try { await bridge!.connect(connection.id) } finally { setConnectingId(undefined) } } }) }} />)}<button type="button" className="secondary-button" disabled={busy || !taskId} onClick={() => { void run(() => onLink(connection)) }}><Icon name="link" />{taskId ? `Link to ${taskId}` : 'No task selected'}</button>{!connection.deviceId && <IconButton icon="trash" label={`Forget ${connection.title}`} disabled={busy} onClick={() => { void run(() => bridge!.forget(connection.id)) }} />}</div>
      </section>)}
    </div>
  </Dialog>
}

export function RemoteVSCodeAccessDialog({ identity, onClose }: { identity: VSCodeChatIdentity; onClose(): void }) {
  const bridge = window.remoteVSCode
  const [grants, setGrants] = useState<RemoteVSCodeGrant[]>([])
  const [canSend, setCanSend] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [managed, setManaged] = useState(Boolean(bridge?.devTunnels))
  const [serviceBusy, setServiceBusy] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<DevTunnelStatus>()
  const running = useRef(false)
  const { nativeSessionId, workspaceStorageId } = identity
  useEffect(() => {
    let active = true
    void bridge?.grants({ nativeSessionId, workspaceStorageId }).then((value) => { if (active) setGrants(value) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Remote access could not be loaded.') })
    return () => { active = false }
  }, [bridge, nativeSessionId, workspaceStorageId])
  async function run(action: () => Promise<void>): Promise<void> {
    if (!bridge || running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try { await action(); setGrants(await bridge.grants(identity)) } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Remote access could not be changed.')
    } finally { running.current = false; setBusy(false) }
  }
  return <Dialog title="Remote access to original conversation" className="remote-vscode-dialog" onClose={() => { if (!busy && !serviceBusy) onClose() }}>
    {bridge?.devTunnels && <RemoteTransportPicker managed={managed} disabled={busy || serviceBusy} onChange={setManaged} />}
    {managed && <DevTunnelControls hosting onStatus={setServiceStatus} onBusy={setServiceBusy} />}
    {managed && <RemoteDeviceAccess identity={identity} canSend={canSend} hosting={serviceStatus?.state === 'hosting'} />}
    <form className="remote-vscode-import" onSubmit={(event) => { event.preventDefault(); void run(async () => { if (await (managed ? bridge!.share(identity, canSend, true) : bridge!.share(identity, canSend))) setNotice('Private invitation saved. Expires in 24 hours or when the bridge stops.') }) }}>
      <label className="form-field">Access<select aria-label="Remote invitation access" value={canSend ? 'send' : 'read'} onChange={(event) => setCanSend(event.target.value === 'send')}><option value="read">Read only</option><option value="send">Read and send</option></select></label>
      <button type="submit" className="primary-button" disabled={!bridge || busy || serviceBusy || managed && serviceStatus?.state !== 'hosting'}><Icon name="person-add" />Choose recipient</button>
    </form>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
    <div className="remote-vscode-list" aria-busy={busy}>
      {!grants.length && <p className="muted">No active invitations.</p>}
      {grants.map((grant) => <div className="remote-vscode-row" key={grant.id}><div className="remote-vscode-row-title"><Icon name="account" /><strong>{grant.participant.username} @ {grant.participant.machineName}</strong><IconButton icon="debug-disconnect" label={`Revoke ${grant.participant.username} on ${grant.participant.machineName}`} disabled={busy} onClick={() => { void run(() => bridge!.revoke(identity, grant.id)) }} /></div><span className="muted">{grant.canSend ? 'Read and send' : 'Read only'} / {new Date(grant.expiresAt).toLocaleString()}</span></div>)}
    </div>
  </Dialog>
}