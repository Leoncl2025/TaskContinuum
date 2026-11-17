import { useEffect, useRef, useState } from 'react'
import type { FileDeliverySettings } from '../../shared/fileDelivery'

export function FileMcpSettings({ workspaceReady = true }: { workspaceReady?: boolean }) {
  const bridge = workspaceReady ? window.desktop?.files : undefined
  const [settings, setSettings] = useState<FileDeliverySettings>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [format, setFormat] = useState<'vscode' | 'mcpServers'>('vscode')
  const [copied, setCopied] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (!bridge) return () => { mounted.current = false }
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try {
        const value = await bridge.settings()
        if (mounted.current) { setSettings(value); setError(undefined) }
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure.message : 'MCP settings are unavailable.')
      } finally { reading = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [bridge])
  async function run(action: () => Promise<unknown>): Promise<void> {
    if (!bridge || busy) return
    setBusy(true)
    setCopied(false)
    setError(undefined)
    try {
      await action()
      const value = await bridge.settings()
      if (mounted.current) setSettings(value)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The MCP operation failed.')
    } finally { if (mounted.current) setBusy(false) }
  }
  if (!workspaceReady) return <section className="settings-section"><h3>MCP file delivery</h3><p className="dialog-hint">Open a task workspace to configure MCP and authorize incoming files.</p></section>
  if (!bridge) return <section className="settings-section"><h3>MCP file delivery</h3><p className="dialog-hint">Available in the desktop app after opening a task workspace.</p></section>
  return <section className="settings-section">
    <h3>MCP file delivery</h3>
    <p className="dialog-hint">Use the running TC as a file-transfer backend. Configure MCP in the actual agent Host on this machine; adding an Agent Host session does not install these tools.</p>
    {error && <p className="message-notice error" role="alert">{error}</p>}
    {!settings ? <p role="status">Loading MCP settings...</p> : <>
      <div className="integration-row"><span>Local authenticated bridge</span><span className="integration-state">Running</span></div>
      <p className="dialog-hint">Node on PATH: {settings.nodeVersion}. Node 24 is required. Both TC desktops must remain running.</p>
      {!settings.nodeVersion?.startsWith('v24.') && <p className="message-notice error">Put Node 24 on the agent Host PATH or replace the configuration command with its absolute executable path.</p>}
      <label>Configuration format <select value={format} onChange={(event) => { setFormat(event.target.value === 'vscode' ? 'vscode' : 'mcpServers'); setCopied(false) }}>
        <option value="vscode">VS Code</option><option value="mcpServers">mcpServers clients</option>
      </select></label>
      <pre className="ahp-terminal" aria-label="MCP configuration">{settings.configurations[format]}</pre>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(async () => { await window.desktop!.copyText(settings.configurations[format]); if (mounted.current) setCopied(true) }) }}>Copy MCP configuration</button>
      {copied && <span role="status"> Configuration copied.</span>}
      <h4>Allow incoming files</h4>
      <p className="dialog-hint">Off by default. Allowing a client permits delivery into this workspace's private inbox without per-file prompts, not remote working-directory writes or execution.</p>
      {!settings.senders.length && <p className="dialog-hint">No incoming paired clients are authorized for this workspace. Pair the sender with this TC first.</p>}
      {settings.senders.map((sender) => <label className="integration-row" key={sender.clientId}>
        <span>{sender.machineName} <small>{sender.clientId}</small></span>
        <input type="checkbox" aria-label={`Receive files from ${sender.machineName}`} checked={sender.allowed} disabled={busy}
          onChange={(event) => { const allowed = event.target.checked; void run(() => bridge.setSender(sender.clientId, allowed)) }} />
      </label>)}
      <h4>Authorized local save directories</h4>
      <p className="dialog-hint">Agents may save delivered files only here, using directory IDs and relative paths. Existing files are never overwritten; saved files are never opened or executed automatically.</p>
      {settings.roots.map((root) => <div className="integration-row" key={root.id}><span>{root.path}<br /><small>{root.id}</small></span>
        <button type="button" className="text-button" disabled={busy} onClick={() => { void run(() => bridge.removeDestination(root.id)) }}>Revoke directory</button></div>)}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(() => bridge.addDestination()) }}>Authorize save directory...</button>
      <h4>File deliveries</h4>
      {!settings.transfers.length && <p className="dialog-hint">No deliveries in this workspace.</p>}
      {settings.transfers.map(({ direction, status }) => <div key={status.transferId}>
        <div className="integration-row"><span>{direction === 'incoming' ? 'Incoming' : 'Outgoing'}: {status.files.map((file) => file.name).join(', ') || 'Preparing files'}
          <br /><small>{status.transferId}</small></span><span>{status.state} - {status.receivedBytes.toLocaleString()} bytes</span></div>
        {status.error && <p className="message-notice error">{status.error.code}: {status.error.message}</p>}
        {status.state === 'interrupted' && (direction === 'outgoing'
          ? <button type="button" className="text-button" disabled={busy} onClick={() => { void run(() => bridge.resume(status.transferId)) }}>Resume delivery</button>
          : <p className="dialog-hint">Resume this delivery on the sending TC.</p>)}
        {['transferring', 'interrupted'].includes(status.state) && <button type="button" className="text-button" disabled={busy} onClick={() => { void run(() => bridge.cancel(status.transferId)) }}>Cancel delivery</button>}
      </div>)}
    </>}
  </section>
}
