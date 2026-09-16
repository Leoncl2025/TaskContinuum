import { useEffect, useRef, useState } from 'react'
import type { WorkspaceRepositoryStatus, WorkspaceSnapshot } from '../../shared/workspace'
import { workspaceRepositoryNameLimit } from '../../shared/workspace'
import type { useWorkspaces } from '../useWorkspaces'
import { Dialog, Icon } from './Primitives'
import '../workspace.css'

function nativeWorkspace() {
  if (!window.workspace) throw new Error('Open Task Continuum in the desktop app to manage local repositories.')
  return window.workspace
}

export function RepositorySetup({ workspace, workspaces, onClose }: {
  workspace: WorkspaceSnapshot | null
  workspaces: ReturnType<typeof useWorkspaces>
  onClose(): void
}) {
  const [repository, setRepository] = useState(workspace)
  const [parentPath, setParentPath] = useState('')
  const [name, setName] = useState('')
  const [isPrivate, setPrivate] = useState(true)
  const [status, setStatus] = useState<WorkspaceRepositoryStatus | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState<'choosing' | 'creating' | 'publishing' | null>(null)
  const [checkVersion, setCheckVersion] = useState(0)
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)
  const pending = useRef(false)

  useEffect(() => {
    if (!repository) return
    const workspaceId = repository.id
    let active = true
    async function check(): Promise<void> {
      try {
        const value = await nativeWorkspace().getRepositoryStatus(workspaceId)
        if (active) setStatus(value)
      } catch (failure) {
        if (active) setIssue(failure instanceof Error ? failure.message : 'Repository status could not be checked.')
      }
    }
    void check()
    return () => { active = false }
  }, [repository, checkVersion])

  async function act(operation: NonNullable<typeof busy>, action: () => Promise<void>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(operation)
    setIssue(null)
    try { await action() } catch (failure) {
      setIssue(failure instanceof Error ? failure.message : 'The repository operation failed. Your local files have been retained.')
    } finally {
      pending.current = false
      setBusy(null)
    }
  }

  function recheck(): void {
    setStatus(null)
    setIssue(null)
    setCheckVersion((value) => value + 1)
  }

  const changed = repository !== null && workspaces.state.current?.id !== repository.id
  const url = publishedUrl ?? (status?.published ? status.remoteUrl : null)
  const checking = repository !== null && status === null && issue === null
  const target = parentPath.trim() && name.trim()
    ? `${parentPath.trim().replace(/[\\/]+$/, '')}${parentPath.includes('\\') ? '\\' : '/'}${name.trim()}`
    : null
  const canPublish = Boolean(repository && status?.github.authenticated && !url && !changed && !busy)

  return <Dialog title={repository ? 'Publish task repository' : 'Create task repository'} className="repository-setup" closeDisabled={busy !== null} onClose={() => { if (!pending.current) onClose() }}>
    <ol className="repository-steps" aria-label="Repository setup">
      <li aria-current={!repository ? 'step' : undefined}><span>{repository ? <Icon name="check" /> : '1'}</span>Local repository</li>
      <li aria-current={repository ? 'step' : undefined}><span>2</span>Publish to GitHub</li>
    </ol>
    {!repository ? <form onSubmit={(event) => {
      event.preventDefault()
      void act('creating', async () => {
        const next = await workspaces.createRepository({ parentPath: parentPath.trim(), name: name.trim() })
        if (!next.current) throw new Error('The new repository was not selected. Open its folder to continue.')
        setRepository(next.current)
      })
    }}>
      <p>Choose where to keep your task files and configuration. We will create a new, empty Git repository with an initial commit. Existing folders are never overwritten.</p>
      <fieldset className="repository-fields" disabled={busy !== null}>
        <label className="form-field" htmlFor="repository-parent">Parent directory</label>
        <div className="repository-path-row">
          <input id="repository-parent" value={parentPath} onChange={(event) => setParentPath(event.target.value)} required maxLength={4096} placeholder="C:\Users\you\Projects" spellCheck={false} autoFocus />
          <button type="button" className="secondary-button" onClick={() => {
            void act('choosing', async () => {
              const chosen = await nativeWorkspace().chooseParentFolder()
              if (chosen !== null) setParentPath(chosen)
            })
          }}><Icon name="folder-opened" />Browse</button>
        </div>
        <label className="form-field">Repository name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={workspaceRepositoryNameLimit} placeholder="my-tasks" spellCheck={false} autoComplete="off" /></label>
      </fieldset>
      {target && <p className="repository-path" aria-label="New repository location"><code>{target}</code></p>}
      <p className="dialog-hint">Includes .agentdesk/config.json and an empty tasks folder. No tasks, conversations, or remote device settings are preloaded. GitHub is optional in the next step.</p>
      {issue && <p className="repository-error" role="alert">{issue}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy !== null} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy !== null || workspaces.busy}>{busy === 'creating' ? 'Creating repository...' : 'Create repository'}</button></div>
    </form> : <>
      <div className="repository-created"><Icon name="repo" /><div><strong>{repository.name}</strong><code>{repository.root}</code><span>Local task files and configuration are ready.</span></div></div>
      {changed && <p className="repository-error" role="alert">The selected workspace changed. Close this guide and reopen it for the intended repository.</p>}
      {url ? <div className="repository-published" role="status"><Icon name="pass" /><h3>Repository is on GitHub</h3><p className="repository-path"><code>{url}</code></p><p>Your local repository is retained. Future task changes are not uploaded by this guide automatically.</p></div> : <>
        {checking && <p role="status">Checking GitHub CLI and repository status...</p>}
        {status && <div className="repository-github">
          <p>{!status.github.installed ? 'GitHub CLI (gh) is not installed. Install it from cli.github.com, then restart Task Continuum to update PATH.' : !status.github.authenticated ? 'Sign in with GitHub CLI in a terminal, then check again.' : `GitHub CLI is signed in${status.github.login ? ` as ${status.github.login}` : ''}.`}</p>
          {status.github.installed && !status.github.authenticated && <pre><code>gh auth login --hostname github.com</code></pre>}
          {status.github.login && <p>Repository: <strong>{status.github.login}/{status.name}</strong></p>}
          {status.remoteUrl && <p className="repository-path">Remote: <code>{status.remoteUrl}</code></p>}
          {status.branch && <p>Branch: <strong>{status.branch}</strong></p>}
        </div>}
        <fieldset className="repository-visibility" disabled={busy !== null}>
          <legend>Repository visibility</legend>
          <label><input type="radio" name="repository-visibility" checked={isPrivate} onChange={() => setPrivate(true)} /><span><strong>Private (recommended)</strong><small>Only you and people you grant access can see it.</small></span></label>
          <label><input type="radio" name="repository-visibility" checked={!isPrivate} onChange={() => setPrivate(false)} /><span><strong>Public</strong><small>Anyone can read the published task files and configuration.</small></span></label>
        </fieldset>
        {!isPrivate && <p className="repository-warning">Public repositories are visible to everyone. Review the committed files for private information before publishing.</p>}
        <p className="dialog-hint">Nothing is uploaded until you choose Publish to GitHub. Only committed files are pushed. Do not commit credentials or private session history.</p>
      </>}
      {issue && <p className="repository-error" role="alert">{issue}</p>}
      <div className="dialog-actions">
        {!url && <button type="button" className="secondary-button" disabled={busy !== null || checking || changed} onClick={recheck}>Check again</button>}
        <button type="button" className="secondary-button" disabled={busy !== null} onClick={onClose}>{url ? 'Done' : 'Keep local for now'}</button>
        {!url && <button type="button" className="primary-button" disabled={!canPublish} onClick={() => {
          void act('publishing', async () => {
            const result = await nativeWorkspace().publishRepository({ workspaceId: repository.id, private: isPrivate })
            setPublishedUrl(result.url)
          })
        }}><Icon name="github" />{busy === 'publishing' ? 'Publishing...' : 'Publish to GitHub'}</button>}
      </div>
    </>}
  </Dialog>
}
