import type { WorkspaceState } from '../../shared/workspace'
import { Icon, IconButton } from './Primitives'
import '../workspace.css'

interface Props {
  state: WorkspaceState
  busy: boolean
  locked: boolean
  onOpen(): void
  onSelect(id: string): void
  onRefresh(): void
}

export function WorkspacePicker({ state, busy, locked, onOpen, onSelect, onRefresh }: Props) {
  const current = state.current
  return <div className="workspace-picker" aria-busy={busy}>
    <div className="workspace-picker-row"><span className="workspace-mark"><Icon name={current ? 'folder-opened' : 'layers'} /></span><label className="workspace-choice"><select aria-label="Workspace" value={current?.id ?? 'demo'} disabled={busy || locked} onChange={(event) => onSelect(event.target.value)} title={current?.root ?? 'Local demo workspace'}><option value="demo">Local demo workspace</option>{state.recent.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><span title={current?.root}>{current ? current.root : 'Task Continuum'}</span></label></div>
    <div className="workspace-picker-actions"><span>{busy ? 'Loading workspace...' : current ? 'Read-only tasks' : 'Demo data'}</span><IconButton icon="folder-opened" label="Open workspace folder" title={locked ? 'Stop the active response before switching workspaces' : 'Open workspace folder'} disabled={busy || locked} onClick={onOpen} /><IconButton icon="refresh" label="Refresh workspace" disabled={busy || locked || !current} onClick={onRefresh} /></div>
  </div>
}