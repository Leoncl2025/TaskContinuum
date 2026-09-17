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
  const enabled = status?.enabled === true
  return <section className="remote-device-controls workspace-links-controls" aria-label="Workspace Git synchronization">
    <div className="workspace-links-header">
      <h3>Automatic workspace links</h3>
      {status && <span role="status" className={`workspace-links-status${enabled ? ' is-enabled' : ''}`}>
        <span className="workspace-links-status-dot" aria-hidden="true" />
        <span>{enabled ? (status.state === 'idle' ? 'On' : status.state) : 'Off'}</span>
      </span>}
    </div>
    <p className="muted workspace-links-description">Trusted devices can access linked sessions. Native approvals still apply; no automatic messages or new sessions.</p>
    <div className="remote-vscode-actions workspace-links-actions">
      <button type="button" className={enabled ? 'secondary-button' : 'primary-button workspace-links-enable'} disabled={busy} onClick={() => { void run(() => enabled ? api.disable() : api.enable()) }}>
        <Icon name={enabled ? 'debug-pause' : 'sync'} /><span>{enabled ? 'Pause automatic links' : 'Enable automatic links'}</span>
      </button>
      {enabled && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => api.syncNow()) }}><Icon name="sync" />Sync now</button>}
      {status?.settingsFile && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => api.openSettings()) }}><Icon name="settings-gear" />Edit local configuration</button>}
    </div>
    {status && (status.pending > 0 || status.lastSyncedAt) && <p role="status" className="workspace-links-meta">
      {status.pending > 0 && `${status.pending} pending`}{status.pending > 0 && status.lastSyncedAt && ' · '}{status.lastSyncedAt && `Last synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}`}
    </p>}
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
