import { useEffect, useRef, useState } from 'react'
import type { WorkspaceGitSyncStatus } from '../../shared/gitSync'
import { Icon } from './Primitives'

export function WorkspaceGitSyncControls() {
  const api = window.remoteVSCode?.gitSync
  const [status, setStatus] = useState<WorkspaceGitSyncStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  useEffect(() => {
    if (!api) return
    let active = true
    const refresh = () => {
      void api.status().then((value) => { if (active) setStatus(value) }).catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Git synchronization status is unavailable.')
      })
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    const unlisten = api.onBindingsChanged(refresh)
    return () => { active = false; clearInterval(timer); unlisten() }
  }, [api])

  async function run(action: () => Promise<unknown>) {
    if (!api || running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    try {
      await action()
      setStatus(await api.status())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Git synchronization failed.')
    } finally { running.current = false; setBusy(false) }
  }

  if (!api) return null
  return <section className="remote-device-controls" aria-label="Workspace Git synchronization">
    <h3>Automatic workspace links</h3>
    <p className="muted">Pull/rebase every 15 seconds. Configuration changes publish immediately; SSH binding notifications apply provisionally until Git catches up.</p>
    <div className="remote-vscode-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => status?.enabled ? api.disable() : api.enable()) }}>
        <Icon name={status?.enabled ? 'debug-pause' : 'sync'} />{status?.enabled ? 'Pause automatic links' : 'Enable automatic links'}
      </button>
      {status?.enabled && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => api.syncNow()) }}>Sync now</button>}
      {status?.settingsFile && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => api.openSettings()) }}>Edit local configuration</button>}
    </div>
    {status && <p role="status">{status.state} · {status.pending} pending{status.lastSyncedAt ? ` · Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : ''}</p>}
    {status?.enabled && status.settings && <div className="form-field">
      <label><input type="checkbox" checked={status.settings.autoLink} disabled={busy} onChange={(event) => { void run(() => api.setSetting('autoLink', event.target.checked, status.revision)) }} />Automatically link enrolled peers</label>
      <label><input type="checkbox" checked={status.settings.tunnelEnabled} disabled={busy} onChange={(event) => { void run(() => api.setSetting('tunnelEnabled', event.target.checked, status.revision)) }} />Enable this workspace's SSH connections</label>
      <label>Connection timeout<select aria-label="Remote connection timeout" value={status.settings.connectTimeoutMs} disabled={busy} onChange={(event) => { void run(() => api.setSetting('connectTimeoutMs', Number(event.target.value), status.revision)) }}>
        {[5000, 15000, 30000, 45000, 60000, 120000, status.settings.connectTimeoutMs].filter((value, index, values) => values.indexOf(value) === index).sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value / 1000} seconds</option>)}
      </select></label>
    </div>}
    {!!status?.provisionalTasks.length && <p role="status">Provisional bindings: {status.provisionalTasks.join(', ')}. Waiting for the same operations in Git.</p>}
    {!!status?.conflicts.length && <p role="alert" className="copilot-error">Configuration needs resolution: {status.conflicts.join(', ')}. Ambiguous bindings are disabled; select the intended session again to resolve.</p>}
    {status?.peers.map((peer) => <div className="remote-vscode-row" key={peer.deviceId}>
      <strong>{peer.machineName}</strong> <span>{peer.state}</span>
      {peer.error && <p className="copilot-error">{peer.error}</p>}
      <button type="button" className="secondary-button" disabled={busy || peer.state === 'blocked'} onClick={() => { void run(() => api.revokeDevice(peer.deviceId)) }}>Revoke automatic link</button>
    </div>)}
    {(error || status?.error) && <p role="alert" className="copilot-error">{error ?? status?.error}</p>}
  </section>
}
