import { useState } from 'react'
import type { CopilotStatus, LocalSessionSummary, SessionListing } from '../../shared/sessions'
import { Icon, IconButton } from './Primitives'
import '../sessions.css'

interface Props {
  status: CopilotStatus
  listing?: SessionListing
  busy: string | null
  selectedId?: string
  onConnect(): void
  onDisconnect(): void
  onRefresh(): void
  onNew(): void
  onOpen(session: LocalSessionSummary): void
  onClose(): void
}

export function LocalSessions({ status, listing, busy, selectedId, onConnect, onDisconnect, onRefresh, onNew, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const ready = status.state === 'ready'
  const sessions = (listing?.sessions ?? []).filter((session) => (source === 'all' || session.source === source)
    && `${session.title} ${session.workingDirectory ?? ''} ${session.id}`.toLowerCase().includes(query.toLowerCase().trim()))
  return <aside className="sidebar local-sessions" aria-label="Local sessions">
    <header className="panel-header"><span>LOCAL SESSIONS</span><div className="header-actions"><IconButton icon="refresh" label="Refresh local sessions" disabled={Boolean(busy)} onClick={onRefresh} /><IconButton icon="add" label="New Copilot session" disabled={!ready || Boolean(busy)} onClick={onNew} /><IconButton icon="layout-sidebar-left-off" label="Hide task sidebar" onClick={onClose} /></div></header>
    <div className="copilot-connection"><Icon name="copilot" /><div><strong>GitHub Copilot</strong><span>{ready ? status.login ?? 'Signed in locally' : status.state === 'auth-required' ? 'Sign-in required' : status.state === 'connecting' ? 'Connecting' : 'Disconnected'}</span></div>{ready ? <IconButton icon="debug-disconnect" label="Disconnect Copilot" disabled={Boolean(busy)} onClick={onDisconnect} /> : <IconButton icon="plug" label="Connect Copilot" disabled={Boolean(busy)} onClick={onConnect} />}</div>
    <div className="sidebar-search"><Icon name="search" /><input aria-label="Filter local sessions" placeholder="Filter sessions" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="session-filter"><select aria-label="Session source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All local sources</option><option value="copilot">Copilot CLI</option><option value="vscode">VS Code history</option></select><span>{sessions.length}</span></div>
    <div className="sidebar-scroll" aria-busy={Boolean(busy)}>
      {sessions.map((session) => <button type="button" key={session.id} className={`session-row ${selectedId === session.id ? 'is-selected' : ''}`} disabled={Boolean(busy) || session.source === 'copilot' && !ready} onClick={() => onOpen(session)} aria-label={`${session.source === 'copilot' ? 'Resume' : 'Preview'} ${session.title}`} aria-current={selectedId === session.id ? 'true' : undefined}>
        <Icon name={session.source === 'copilot' ? 'terminal' : 'vscode'} /><span className="session-copy"><strong>{session.title}</strong><span className="session-source">{session.source === 'copilot' ? 'Copilot CLI' : 'VS Code history'}<time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString()}</time></span><span className="session-directory" title={session.workingDirectory}>{session.workingDirectory ?? 'Working directory not recorded'}</span></span><Icon name={session.source === 'copilot' ? 'arrow-right' : 'preview'} />
      </button>)}
      {!sessions.length && <div className="empty-sidebar"><Icon name="history" /><strong>{busy ? busy : listing ? 'No matching sessions' : 'Sessions not loaded'}</strong></div>}
    </div>
    {Boolean(listing?.warnings.length) && <details className="session-warnings"><summary>{listing!.warnings.length} sessions or locations skipped</summary>{listing!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
    <footer className="session-footer"><Icon name="lock" /><span>{ready ? `Local runtime ${status.version ?? ''}` : 'Local history remains read-only'}</span></footer>
  </aside>
}