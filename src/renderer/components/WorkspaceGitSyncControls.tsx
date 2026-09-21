import { useId, useRef, useState } from 'react'
import { machineAliasMaxLength, machineDisplayName } from '../../shared/machineAliases'
import { useMachineAliases, useWorkspaceGitSync } from '../machineAliases'
import { Icon } from './Primitives'

const invalidAliasCharacters = /[\p{Cc}\u2028\u2029]/u
const invalidAliasMessage = 'Machine aliases cannot contain control characters or multiple lines.'

export function WorkspaceGitSyncControls() {
  const api = window.remoteVSCode?.gitSync
  const { status, error: statusError, refresh } = useWorkspaceGitSync()
  const aliases = useMachineAliases()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ deviceId: string; value: string; revision: string | null; error?: string }>()
  const aliasInputId = useId()
  const running = useRef(false)

  async function run(action: () => Promise<unknown>, aliasRetryFor?: string): Promise<boolean> {
    if (!api || running.current) return false
    running.current = true
    setBusy(true)
    setError(undefined)
    try {
      await action()
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Git synchronization failed.')
      return false
    } finally {
      const latest = await refresh()
      if (latest && aliasRetryFor) setEditor((current) => current?.deviceId === aliasRetryFor ? { ...current, revision: latest.revision } : current)
      running.current = false
      setBusy(false)
    }
  }

  async function saveAlias(clear = false): Promise<void> {
    if (!api?.setMachineAlias || !status?.enabled || !editor || running.current) return
    const value = clear ? '' : editor.value
    const alias = value.trim()
    const validation = invalidAliasCharacters.test(value) ? invalidAliasMessage : alias.length > machineAliasMaxLength ? `Machine aliases must be ${machineAliasMaxLength} characters or fewer.` : undefined
    if (validation) { setEditor({ ...editor, error: validation }); return }
    setEditor({ ...editor, error: undefined })
    if (await run(() => api.setMachineAlias(editor.deviceId, alias || null, editor.revision), editor.deviceId)) setEditor(undefined)
    else setError((message) => message ? `${message} Review the current machine name, then save or clear again.` : message)
  }

  if (!api) return null
  const enabled = status?.enabled === true
  const machines = [
    ...(status?.localDevice ? [{ ...status.localDevice, local: true, state: 'This device', error: undefined }] : []),
    ...(status?.peers.map((peer) => ({ ...peer, local: false })) ?? []),
  ]
  const aliasConflicts = status?.conflicts.some((conflict) => conflict.startsWith('alias:'))
  const otherConflicts = status?.conflicts.some((conflict) => !conflict.startsWith('alias:'))
  return <section className="remote-device-controls workspace-links-controls" aria-label="Workspace Git synchronization" aria-busy={busy}>
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
    {!!status?.conflicts.length && <p role="alert" className="copilot-error">Configuration needs resolution: {status.conflicts.join(', ')}.{otherConflicts && ' Ambiguous bindings are disabled; select the intended session again to resolve.'}{aliasConflicts && ' Rename the affected machines, then explicitly save or clear each conflicting alias.'}</p>}
    {!!machines.length && <p className="muted workspace-links-description">Machine aliases sync with this workspace in its public configuration. Do not include secrets. Hostnames and connection identities stay unchanged.{!enabled && ' Enable automatic links to edit aliases.'}</p>}
    {machines.map((machine) => {
      const name = machineDisplayName({ clientId: machine.deviceId, machineName: machine.machineName }, aliases)
      const editing = editor?.deviceId === machine.deviceId ? editor : undefined
      return <div className="remote-vscode-row" role="group" aria-label={`Workspace machine ${machine.machineName}`} key={machine.deviceId}>
        <div className="remote-vscode-row-title"><strong title={machine.machineName}>{name}</strong><span className="muted">{machine.state}</span></div>
        {name !== machine.machineName && <p className="muted workspace-links-meta">Hostname: {machine.machineName}</p>}
        {machine.error && <p className="copilot-error">{machine.error}</p>}
        {status?.conflicts.includes(`alias:${machine.deviceId}`) && <p className="copilot-error" role="alert">This machine's alias has conflicting changes. Save or clear its alias to resolve.</p>}
        <div className="remote-vscode-actions">
          <button type="button" className="secondary-button" aria-label={`Rename ${machine.machineName}`} disabled={busy || !enabled || !api.setMachineAlias} onClick={() => {
            setError(undefined)
            setEditor({ deviceId: machine.deviceId, value: status?.machineAliases?.[machine.deviceId] ?? '', revision: status?.revision ?? null })
          }}><Icon name="edit" />Rename</button>
          {!machine.local && <button type="button" className="secondary-button" disabled={busy || machine.state === 'blocked'} onClick={() => { void run(() => api.revokeDevice(machine.deviceId)) }}>Revoke automatic link</button>}
        </div>
        {editing && <form className="machine-alias-editor" aria-label={`Rename ${machine.machineName}`} onSubmit={(event) => { event.preventDefault(); void saveAlias() }} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setEditor(undefined) }
        }}>
          <div className="form-field">
            <label htmlFor={aliasInputId}>Machine alias for {machine.machineName}</label>
            <input id={aliasInputId} value={editing.value} autoFocus maxLength={machineAliasMaxLength} disabled={busy || !enabled} aria-invalid={Boolean(editing.error)} aria-describedby={`${aliasInputId}-hint${editing.error ? ` ${aliasInputId}-error` : ''}`} onChange={(event) => setEditor({ ...editing, value: event.target.value, error: undefined })} onPaste={(event) => {
              if (invalidAliasCharacters.test(event.clipboardData.getData('text'))) { event.preventDefault(); setEditor({ ...editing, error: invalidAliasMessage }) }
            }} />
            <span className="muted" id={`${aliasInputId}-hint`}>Up to {machineAliasMaxLength} characters. Leave blank or clear to use the hostname.</span>
          </div>
          {editing.error && <p className="copilot-error" role="alert" id={`${aliasInputId}-error`}>{editing.error}</p>}
          <div className="remote-vscode-actions">
            <button type="submit" className="primary-button" disabled={busy || !enabled}>Save alias</button>
            <button type="button" className="secondary-button" disabled={busy || !enabled} onClick={() => { void saveAlias(true) }}>Clear alias</button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditor(undefined)}>Cancel</button>
          </div>
        </form>}
      </div>
    })}
    {(error || statusError || status?.error) && <p role="alert" className="copilot-error">{error ?? statusError ?? status?.error}</p>}
  </section>
}
