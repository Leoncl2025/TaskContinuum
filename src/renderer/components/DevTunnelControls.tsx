import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DevTunnelStatus } from '../../shared/devTunnel'
import { Icon, IconButton } from './Primitives'

export function DevTunnelControls({ hosting = false, onStatus, onBusy }: {
  hosting?: boolean; onStatus?(value: DevTunnelStatus): void; onBusy?(value: boolean): void
}) {
  const bridge = window.remoteVSCode?.devTunnels
  const [status, setStatus] = useState<DevTunnelStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const running = useRef(false)
  const notify = useEffectEvent((value: DevTunnelStatus) => { onStatus?.(value); onBusy?.(running.current || value.state === 'starting' || value.state === 'signing-in') })
  useEffect(() => {
    let active = true
    let loading = false
    async function refresh(initial = false) {
      if (!bridge || loading) return
      loading = true
      try {
        const value = await bridge.status(initial)
        if (active) { setStatus(value); notify(value) }
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Dev Tunnel status unavailable.') }
      finally { loading = false }
    }
    void refresh(true)
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [bridge])

  async function run(action: () => Promise<void>): Promise<void> {
    if (!bridge || running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    onBusy?.(true)
    try {
      await action()
      const value = await bridge.status(true)
      setStatus(value)
      onStatus?.(value)
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The Dev Tunnel operation failed.') }
    finally { running.current = false; setBusy(false); onBusy?.(false) }
  }
  if (!bridge) return null
  const pending = busy || status?.state === 'starting' || status?.state === 'signing-in'
  const published = status?.state === 'hosting'
  return <section className="dev-tunnel-controls" aria-label="Dev Tunnel service">
    <div className="remote-vscode-row-title"><Icon name="cloud" /><strong>{status?.account ?? 'Microsoft Dev Tunnel'}</strong><span className="muted" role="status">{pending ? status?.state === 'signing-in' ? 'Signing in' : 'Connecting' : published ? 'Hosting' : status?.account ? 'Signed in' : status ? 'Signed out' : 'Checking'}</span><IconButton icon="refresh" label="Refresh Dev Tunnel status" disabled={pending} onClick={() => { void run(async () => {}) }} /></div>
    <div className="remote-vscode-actions">
      {status && !status.installed ? <button type="button" className="secondary-button" onClick={() => { void run(() => bridge.installationGuide()) }}><Icon name="link-external" />Install Dev Tunnel CLI</button> : <button type="button" className="secondary-button" disabled={pending || published || !status} onClick={() => { void run(() => bridge.login()) }}><Icon name="account" />{status?.account ? 'Sign in again' : 'Sign in with Microsoft'}</button>}
      {hosting && <button type="button" className={published ? 'secondary-button' : 'primary-button'} disabled={pending || !status?.installed || !status.account} onClick={() => { void run(() => published ? bridge.stop() : bridge.publish()) }}><Icon name={published ? 'debug-disconnect' : 'broadcast'} />{published ? 'Stop publication' : 'Publish this machine'}</button>}
      {hosting && <IconButton icon="discard" label="Reset saved publication" disabled={pending || !status} onClick={() => { void run(() => bridge.reset()) }} />}
      {pending && <IconButton icon="close" label="Cancel Dev Tunnel operation" onClick={() => { void bridge.cancel().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Cancellation failed.')) }} />}
    </div>
    {hosting && status?.tunnelId && <div className="dev-tunnel-details"><span>Owner only</span><code>{status.tunnelId}</code>{status.hostFingerprint && <code aria-label="SSH host fingerprint">{status.hostFingerprint}</code>}</div>}
    {(error || status?.error) && <p className="copilot-error" role="alert">{error ?? status?.error}</p>}
  </section>
}
