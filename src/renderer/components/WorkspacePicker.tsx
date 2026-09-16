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
  onPublish(): void
}

export function WorkspacePicker({ state, busy, locked, onOpen, onSelect, onRefresh, onPublish }: Props) {
  const current = state.current
  const choices = current ? [current, ...state.recent.filter((workspace) => workspace.id !== current.id)] : state.recent
  return <div className="workspace-picker" aria-busy={busy}>
    <div className="workspace-picker-row"><span className="workspace-mark"><Icon name={current ? 'folder-opened' : 'repo'} /></span><label className="workspace-choice"><select aria-label="Workspace" value={current?.id ?? ''} disabled={busy || locked} onChange={(event) => onSelect(event.target.value)} title={current?.root ?? 'No workspace selected'}><option value="">No workspace</option>{choices.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><span title={current?.root}>{current ? current.root : 'Create or open a task repository'}</span></label></div>
    <div className="workspace-picker-actions"><span>{busy ? 'Loading workspace...' : current ? 'Read-only tasks' : 'No tasks yet'}</span>{current && <IconButton icon="github" label="Publish workspace to GitHub" disabled={busy || locked} onClick={onPublish} />}<IconButton icon="folder-opened" label="Open workspace folder" title={locked ? 'Finish the active operation before switching workspaces' : 'Open workspace folder'} disabled={busy || locked} onClick={onOpen} /><IconButton icon="refresh" label="Refresh workspace" disabled={busy || locked || !current} onClick={onRefresh} /></div>
  </div>
}