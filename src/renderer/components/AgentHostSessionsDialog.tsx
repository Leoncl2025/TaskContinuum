import { useEffect, useRef, useState } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostSession } from '../../shared/agentHost'
import { Dialog, Icon, IconButton } from './Primitives'
import { AgentHostCreationControls } from './AgentHostCreationControls'

export function AgentHostSessionsDialog({ taskId, taskUnbound = false, onLink, onCreated, onDevices, onClose }: { taskId?: string; taskUnbound?: boolean; onLink(session: AgentHostSession): Promise<void>; onCreated?(taskId: string, session: AgentHostSession): Promise<void>; onDevices(): void; onClose(): void }) {
  const bridge = window.agentHost
  const [sessions, setSessions] = useState<AgentHostSession[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const running = useRef(false)
  useEffect(() => {
    let active = true
    void (bridge?.list() ?? Promise.reject(new Error('The Agent Host desktop API is unavailable.'))).then((result) => { if (active) { setSessions(result.sessions); setWarnings(result.warnings); setError(undefined) } }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Agent Host sessions could not be read.') }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [bridge, revision])
  async function link(session: AgentHostSession): Promise<void> {
    if (running.current || busy) return
    running.current = true
    setBusy(true)
    setError(undefined)
    try { await onLink(session) } catch (failure) { setError(failure instanceof Error ? failure.message : 'The session could not be linked.') }
    finally { running.current = false; setBusy(false) }
  }
  const filtered = sessions.filter((session) => `${session.title} ${session.owner.machineName} ${session.provider}`.toLowerCase().includes(query.toLowerCase()))
  return <Dialog title="Agent Host sessions" className="remote-vscode-dialog" onClose={() => { if (!running.current) onClose() }}>
    <div className="ahp-catalog-toolbar"><input aria-label="Find Agent Host session" placeholder="Find session" value={query} onChange={(event) => setQuery(event.target.value)} /><IconButton icon="refresh" label="Refresh Agent Host sessions" disabled={busy} onClick={() => { setBusy(true); setRevision((value) => value + 1) }} /><IconButton icon="remote" label="Manage devices" disabled={busy} onClick={onDevices} /></div>
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {warnings.map((warning, index) => <p key={index} className="muted" role="status">{warning}</p>)}
    <div className="remote-vscode-list" aria-busy={busy}>
      {busy && <p className="muted" role="status">Loading sessions...</p>}
      {!busy && !filtered.length && <p className="muted">No available Agent Host sessions.</p>}
      {filtered.map((session) => <section key={agentHostKey(session)} className="ahp-catalog-item" aria-label={`Host session ${session.title}`}><div><strong><Icon name="copilot" />{session.title}</strong><p className="muted">{session.owner.machineName} / {session.provider} / {session.canSend ? 'Read and send' : 'Read only'}</p><span className="muted ahp-session-id" title={session.sessionId}>{session.sessionId}</span></div><IconButton icon="link" label={`Link ${session.title} to ${taskId ?? 'task'}`} disabled={busy || !taskId} onClick={() => { void link(session) }} /></section>)}
    </div>
    <AgentHostCreationControls taskId={taskId} taskUnbound={taskUnbound} disabled={busy} onCreated={onCreated} />
  </Dialog>
}