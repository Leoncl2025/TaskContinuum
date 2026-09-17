import { useEffect, useRef, useState } from 'react'
import { taskCreationDraftSchema } from '../../shared/taskCreation'
import type { WorkspaceTaskCreationContext } from '../../shared/taskCreation'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import type { useWorkspaces } from '../useWorkspaces'
import { Dialog, Icon } from './Primitives'
import '../task-creation.css'

export type TaskCreationMode = 'form' | 'agent'

export function TaskCreationDialog({ workspace, workspaces, initialMode, onCreated, onAgent, onClose }: {
  workspace: WorkspaceSnapshot
  workspaces: ReturnType<typeof useWorkspaces>
  initialMode: 'form' | 'draft'
  onCreated(taskId: string): void
  onAgent(): void
  onClose(): void
}) {
  const bridge = window.workspace
  const [mode, setMode] = useState(initialMode)
  const [context, setContext] = useState<WorkspaceTaskCreationContext>()
  const [contextVersion, setContextVersion] = useState(0)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('')
  const [owner, setOwner] = useState('')
  const [level, setLevel] = useState('')
  const [type, setType] = useState('')
  const [priority, setPriority] = useState('')
  const [slug, setSlug] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [draftText, setDraftText] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'creating' | null>(null)
  const pending = useRef(false)
  const changed = workspaces.state.current?.id !== workspace.id
  const locked = busy !== null

  useEffect(() => {
    let active = true
    void (bridge?.getTaskCreationContext(workspace.id) ?? Promise.reject(new Error('Open the desktop app to create task files.')))
      .then((value) => { if (active) { setContext(value); setError('') } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Task creation options could not be loaded.') })
    return () => { active = false }
  }, [bridge, workspace.id, contextVersion])

  async function run(operation: NonNullable<typeof busy>, action: () => Promise<void>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(operation)
    setError('')
    setNotice('')
    try { await action() } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Task creation failed. Existing task files were retained.')
    } finally { pending.current = false; setBusy(null) }
  }

  function reviewDraft(): void {
    setError('')
    setNotice('')
    try {
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(draftText.trim())
      const value: unknown = JSON.parse(fenced?.[1] ?? draftText)
      const draft = taskCreationDraftSchema.parse(value)
      if (draft.owner && context && !context.members.some((member) => member.id === draft.owner)) throw new Error('The draft owner is not a workspace member.')
      if (draft.parentId && context && !context.parents.some((task) => task.id === draft.parentId)) throw new Error('The draft parent is not an available task.')
      setTitle(draft.title)
      setDescription(draft.description ?? '')
      setParentId(draft.parentId ?? '')
      setOwner(draft.owner ?? '')
      setLevel(draft.level ?? '')
      setType(draft.type ?? '')
      setPriority(draft.priority ?? '')
      setSlug(draft.slug ?? '')
      setAcceptance(draft.acceptance?.join('\n') ?? '')
      setMode('form')
      setNotice('Agent draft loaded for review. No task files have been created yet.')
    } catch (failure) {
      setError(failure instanceof SyntaxError ? 'Paste one valid JSON task draft, not task.json or an array.' : failure instanceof Error ? failure.message : 'The task draft is invalid.')
    }
  }

  const parentPicker = <label className="form-field">Parent task (optional)<select value={parentId} onChange={(event) => { setParentId(event.target.value); setLevel('') }} disabled={!context || locked || changed}>
    <option value="">No parent</option>
    {context?.parents.map((task) => <option key={task.id} value={task.id}>{task.id} - {task.title}</option>)}
  </select></label>

  return <Dialog title="Create task" className="task-create-dialog" closeDisabled={locked} onClose={() => { if (!pending.current) onClose() }}>
    <p className="task-create-workspace"><Icon name="repo" />{workspace.name}<code>{workspace.root}</code></p>
    <div role="tablist" aria-label="Task creation method" className="task-create-tabs">
      <button type="button" role="tab" aria-selected={mode === 'form'} disabled={locked} onClick={() => { setMode('form'); setError(''); setNotice('') }}>Quick create</button>
      <button type="button" role="tab" aria-selected={mode === 'draft'} disabled={locked} onClick={() => { setMode('draft'); setError(''); setNotice('') }}>Review agent draft</button>
    </div>
    <button type="button" className="text-button" disabled={locked || changed} onClick={onAgent}>Create with agent in the chat panel</button>
    {changed && <p className="task-create-error" role="alert">The selected workspace changed. Reopen task creation in the intended workspace.</p>}
    {!context && !error && <p role="status">Loading workspace members and task hierarchy...</p>}
    {error && <p className="task-create-error" role="alert">{error}</p>}
    {notice && <p className="task-create-notice" role="status">{notice}</p>}
    {mode === 'form' ? <form onSubmit={(event) => {
      event.preventDefault()
      void run('creating', async () => {
        if (!context || changed) throw new Error('Refresh workspace options before creating a task.')
        const draft = taskCreationDraftSchema.parse({
          title, description,
          parentId: parentId || null,
          owner: owner || context.defaults.owner,
          type: type || context.defaults.type,
          priority: priority || context.defaults.priority,
          ...(level ? { level } : {}),
          ...(slug ? { slug } : {}),
          acceptance: acceptance.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        })
        const created = await workspaces.createTask({ workspaceId: workspace.id, draft })
        onCreated(created.taskId)
      })
    }}>
      <fieldset disabled={busy !== null || changed} className="task-create-fields">
        <label className="form-field">Task title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} placeholder="What needs to get done?" autoFocus /></label>
        <label className="form-field">Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={8000} rows={4} placeholder="Describe the goal or desired outcome." /></label>
        {parentPicker}
        <details className="task-create-details">
          <summary>More options</summary>
          <div className="task-create-grid">
            <label className="form-field">Owner<select value={owner || context?.defaults.owner || ''} onChange={(event) => setOwner(event.target.value)} disabled={!context}>{context?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <label className="form-field">Priority<select value={priority || context?.defaults.priority || ''} onChange={(event) => setPriority(event.target.value)} disabled={!context}>{context?.priorities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="form-field">Task type<select value={type || context?.defaults.type || ''} onChange={(event) => setType(event.target.value)} disabled={!context}>{context?.types.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="form-field">Hierarchy level<select value={level} onChange={(event) => setLevel(event.target.value)} disabled={!context}><option value="">Automatic for the selected parent</option>{context?.levels.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          </div>
          <label className="form-field">Folder slug (optional)<input value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={40} placeholder="Generated from the title" autoComplete="off" /></label>
          <label className="form-field">Acceptance criteria (one per line)<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} maxLength={15030} rows={3} /></label>
        </details>
      </fieldset>
      <p className="muted">Creates a new task folder with a unique ID, task.json and lifecycle documents. Existing tasks stay untouched. Nothing is committed or pushed.</p>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy !== null} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!context || !title.trim() || busy !== null || changed}>{busy === 'creating' ? 'Creating task...' : 'Create task'}</button></div>
    </form> : <div className="task-create-draft">
        <p>The agent can return a draft rather than writing files. Review it here, then create it using the same safe UI path.</p>
        <label className="form-field">Agent task draft (JSON)<textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} maxLength={32768} rows={6} spellCheck={false} /></label>
        <button type="button" className="secondary-button" disabled={!draftText.trim() || locked || changed} onClick={reviewDraft}>Review draft</button>
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={locked} onClick={onClose}>Done</button></div>
    </div>}
    {!context && error && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => { setError(''); setContextVersion((value) => value + 1) }}>Reload workspace options</button>}
  </Dialog>
}
