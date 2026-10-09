import { useEffect, useRef, useState } from 'react'
import type { UpdateBridge, UpdateState } from '../../shared/updates'
import { Dialog, Icon } from './Primitives'
import './updates.css'

type UpdateOperation = 'refresh' | 'check' | 'preferences' | 'release' | 'download' | 'install'

export interface UpdatesController {
  state?: UpdateState
  available: boolean
  loading: boolean
  busy?: UpdateOperation
  error?: string
  refresh(): Promise<boolean>
  check(): Promise<boolean>
  setAutoCheck(enabled: boolean): Promise<boolean>
  openRelease(): Promise<boolean>
  download(): Promise<boolean>
  install(): Promise<boolean>
}

function errorMessage(failure: unknown) {
  return failure instanceof Error ? failure.message : 'The update operation failed. Please try again.'
}

function isWorking(state?: UpdateState) {
  return state?.phase === 'checking' || state?.phase === 'downloading' || state?.phase === 'installing'
}

// Mount once in App and pass the same controller to the settings and status bar.
// eslint-disable-next-line react-refresh/only-export-components
export function useUpdates(api: UpdateBridge | undefined = window.updates): UpdatesController {
  const [state, setState] = useState<UpdateState>()
  const [loading, setLoading] = useState(!!api)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<UpdateOperation>()
  const stateRef = useRef<UpdateState | undefined>(undefined)
  const session = useRef<{ active: boolean; revision: number; running: boolean } | undefined>(undefined)

  useEffect(() => {
    if (!api) return
    const current = { active: true, revision: 0, running: false }
    session.current = current
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = api.onState((next) => {
        if (!current.active) return
        current.revision++
        stateRef.current = next
        setState(next)
        setError(undefined)
        setLoading(false)
      })
      const revision = current.revision
      void api.getState().then((next) => {
        if (!current.active || revision !== current.revision) return
        stateRef.current = next
        setState(next)
      }).catch((failure: unknown) => {
        if (current.active && revision === current.revision) setError(errorMessage(failure))
      }).finally(() => { if (current.active) setLoading(false) })
    } catch (failure) {
      // A missing/disconnected bridge must not crash the settings panel.
      void Promise.resolve().then(() => {
        if (current.active) {
          setError(errorMessage(failure))
          setLoading(false)
        }
      })
    }
    return () => { current.active = false; unsubscribe?.() }
  }, [api])

  async function run(operation: UpdateOperation, action: (bridge: UpdateBridge) => Promise<UpdateState | void>) {
    const current = session.current
    if (!api || !current?.active || current.running || isWorking(stateRef.current)) return false
    const latest = stateRef.current
    if (operation === 'download' && (!latest?.canInstall || latest.distribution !== 'nsis' ||
        (latest.phase !== 'available' && !(latest.phase === 'error' && latest.release)))) return false
    if (operation === 'install' && (!latest?.canInstall || latest.distribution !== 'nsis' || latest.phase !== 'downloaded')) return false
    current.running = true
    // Invalidate any outstanding initial read before starting an explicit action.
    const revision = ++current.revision
    setBusy(operation)
    setError(undefined)
    try {
      const next = await action(api)
      if (!current.active) return false
      if (next && revision === current.revision) {
        stateRef.current = next
        setState(next)
      }
      // Void actions may change backend state without emitting an event.
      if (!next && operation !== 'release' && operation !== 'install') {
        const refreshRevision = current.revision
        const refreshed = await api.getState()
        if (current.active && refreshRevision === current.revision) {
          stateRef.current = refreshed
          setState(refreshed)
        }
      }
      return true
    } catch (failure) {
      if (current.active) setError(errorMessage(failure))
      return false
    } finally {
      current.running = false
      if (current.active) {
        setBusy(undefined)
        setLoading(false)
      }
    }
  }

  return {
    state, available: !!api, loading, busy, error,
    refresh: () => run('refresh', (bridge) => bridge.getState()),
    check: () => run('check', (bridge) => bridge.check()),
    setAutoCheck: (enabled) => run('preferences', (bridge) => bridge.setAutoCheck(enabled)),
    openRelease: () => run('release', (bridge) => bridge.openRelease()),
    download: () => run('download', (bridge) => bridge.download()),
    install: () => run('install', (bridge) => bridge.install()),
  }
}

function statusText(state?: UpdateState) {
  switch (state?.phase) {
    case 'checking': return 'Checking for updates...'
    case 'available': return `Update ${state.release?.version ?? ''} available`.replace('  ', ' ')
    case 'up-to-date': return 'You are up to date.'
    case 'downloading': return 'Downloading update...'
    case 'downloaded': return 'Restart to update'
    case 'installing': return 'Preparing to restart and update...'
    case 'error': return 'Unable to complete the update operation.'
    default: return 'Check for a newer version of Task Continuum.'
  }
}

export function UpdateStatus({ updates, onOpen }: { updates: UpdatesController; onOpen(): void }) {
  const { state, error } = updates
  if (!updates.available || (!error && (!state || state.phase === 'idle' || state.phase === 'up-to-date'))) return null
  return <span className="update-status" role="status" aria-live="polite">
    <button type="button" className="statusbar-item" onClick={onOpen} title="Open update settings">
      <Icon name={error || state?.phase === 'error' ? 'warning' : 'cloud-download'} />
      <span>{error ? 'Update needs attention' : statusText(state)}</span>
    </button>
  </span>
}

export function UpdateSettings({ updates }: { updates: UpdatesController }) {
  const { state, loading, busy, error } = updates
  const [confirmVersion, setConfirmVersion] = useState<string>()
  const disabled = !!busy || loading || isWorking(state)
  const canInstall = state?.canInstall && state.distribution === 'nsis'
  const confirmationOpen = confirmVersion !== undefined && state?.phase === 'downloaded' && canInstall && confirmVersion === (state.release?.version ?? '')
  const failure = error ?? state?.error
  const distribution = state && {
    nsis: 'Windows installer (NSIS)',
    archive: 'Portable archive',
    development: 'Development build',
    unsupported: 'Unsupported distribution',
  }[state.distribution]

  return <section className="settings-section update-settings" aria-label="Application updates">
    <h3>Application updates</h3>
    {!updates.available ? <p className="muted">Updates are unavailable in browser preview. Open the desktop app to check for updates.</p> : <>
      {state && <>
        <p className="update-version">Current version: <strong>{state.currentVersion}</strong><span className="muted">{distribution}</span></p>
        {!canInstall && <p className="muted">Manual updates only. {state.reason ?? 'This distribution cannot install updates in the app. Download the appropriate build from the release page.'}</p>}
        {canInstall && state.reason && <p className="muted">{state.reason}</p>}
        {state.distribution !== 'development' && <label className="update-auto-check"><input type="checkbox" checked={state.autoCheck} disabled={disabled} onChange={(event) => { void updates.setAutoCheck(event.target.checked) }} />{canInstall ? 'Automatically check and download updates' : 'Automatically check for updates'}</label>}
        <p className="muted">{canInstall
          ? 'When enabled, new stable releases download in the background. You choose when to restart. Updates are never installed automatically, including when you quit.'
          : state.distribution === 'development'
            ? 'Development builds only check when you choose Check for updates. Download and install releases manually.'
            : 'Automatic checks only notify you. Download and install updates manually from the release page.'}</p>
      </>}
      <p role="status" aria-live="polite">{loading ? 'Loading update settings...' : statusText(state)}</p>
      {state?.phase === 'downloading' && <div className="update-progress">
        <progress aria-label="Update download progress" max={100} value={typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.min(100, Math.max(0, state.progress)) : undefined} />
        {typeof state.progress === 'number' && Number.isFinite(state.progress) && <span>{Math.round(Math.min(100, Math.max(0, state.progress)))}%</span>}
      </div>}
      {failure && <p className="copilot-error" role="alert">{failure}</p>}
      <div className="update-actions">
        <button type="button" className="secondary-button" disabled={disabled || state?.phase === 'downloaded'} onClick={() => { void (state ? updates.check() : updates.refresh()) }}>
          <Icon name="refresh" />{!state && failure ? 'Retry loading updates' : failure && state?.phase !== 'downloaded' ? 'Retry check' : 'Check for updates'}
        </button>
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => { void updates.openRelease() }}>Open release page</button>
        {canInstall && (state.phase === 'available' || (state.phase === 'error' && state.release)) && <button type="button" className="primary-button" disabled={disabled} onClick={() => { void updates.download() }}><Icon name="cloud-download" />{state.phase === 'error' ? 'Retry download' : 'Download update'}</button>}
        {canInstall && state.phase === 'downloaded' && <button type="button" className="primary-button" disabled={disabled} onClick={() => setConfirmVersion(state.release?.version ?? '')}>Restart and update</button>}
      </div>
      {state?.release && <details className="update-release-notes">
        <summary>Release notes - {state.release.version}</summary>
        <pre>{state.release.notes || 'No release notes were provided.'}</pre>
      </details>}
      {confirmationOpen && <Dialog title="Restart and update?" onClose={() => setConfirmVersion(undefined)} closeDisabled={busy === 'install'}>
        <p>Task Continuum will close and restart to install the update, disconnecting remote clients. Wait for running operations to finish before continuing.</p>
        <p>Empty native chats with no sent messages may disappear after their last subscriber disconnects. Task Continuum will not send a warm-up message or replay prompts to preserve them.</p>
        <p>Send or clear unsent text and image attachments, and finish or close task creation forms before updating, including drafts in hidden panes. Installation is blocked while these drafts or forms remain.</p>
        <p className="muted">Choose Cancel to update later. Quitting the app will not install the update.</p>
        {failure && <p className="copilot-error" role="alert">{failure}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy === 'install'} onClick={() => setConfirmVersion(undefined)}>Cancel</button>
          <button type="button" className="primary-button" disabled={disabled} onClick={() => {
            void updates.install().then((installed) => { if (installed) setConfirmVersion(undefined) })
          }}>Confirm restart and update</button>
        </div>
      </Dialog>}
    </>}
  </section>
}
