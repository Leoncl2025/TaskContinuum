import { useEffect, useRef, useState } from 'react'
import type { WorkspaceRepositoryPushPlan, WorkspaceRepositoryStatus, WorkspaceSnapshot } from '../../shared/workspace'
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
  const [remoteUrl, setRemoteUrl] = useState('')
  const [plan, setPlan] = useState<WorkspaceRepositoryPushPlan | null>(null)
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<WorkspaceRepositoryStatus | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState<'choosing' | 'creating' | 'opening' | 'planning' | 'copying' | 'verifying' | null>(null)
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
        if (active) {
          setStatus(value)
          setRemoteUrl((current) => current || value.remoteUrl || '')
        }
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
    setPlan(null)
    setCopied(false)
    setCheckVersion((value) => value + 1)
  }

  const changed = repository !== null && workspaces.state.current?.id !== repository.id
  const url = publishedUrl
  const checking = repository !== null && status === null && issue === null
  const target = parentPath.trim() && name.trim()
    ? `${parentPath.trim().replace(/[\\/]+$/, '')}${parentPath.includes('\\') ? '\\' : '/'}${name.trim()}`
    : null
  const canPlan = Boolean(repository && status && remoteUrl.trim() && !url && !changed && !busy)

  return <Dialog title={repository ? 'Publish task repository' : 'Create task repository'} className="repository-setup" closeDisabled={busy !== null} onClose={() => { if (!pending.current) onClose() }}>
    <ol className="repository-steps" aria-label="Repository setup">
      <li aria-current={!repository ? 'step' : undefined}><span>{repository ? <Icon name="check" /> : '1'}</span>Local repository</li>
      <li aria-current={repository && !plan ? 'step' : undefined}><span>{plan ? <Icon name="check" /> : '2'}</span>GitHub website</li>
      <li aria-current={plan && !url ? 'step' : undefined}><span>{url ? <Icon name="check" /> : '3'}</span>Terminal push</li>
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
        {checking && <p role="status">Checking local Git configuration...</p>}
        {status && <div className="repository-github">
          <p>No GitHub CLI or separate app sign-in is needed. If you can already git push from your terminal, reuse that setup.</p>
          <p>{status.credentialHelper === 'gcm' ? 'Git Credential Manager is configured. Terminal Git can reuse your saved credentials or open your enterprise sign-in when needed.' : status.credentialHelper === 'configured' ? 'Git has a credential helper configured. The terminal uses your existing credentials; Task Continuum does not replace them.' : 'No HTTPS credential helper was detected. Use an existing SSH setup, or configure Git Credential Manager before pushing over HTTPS.'}</p>
          {status.remoteUrl && <p className="repository-path">Remote: <code>{status.remoteUrl}</code></p>}
          {status.branch && <p>Branch: <strong>{status.branch}</strong></p>}
        </div>}
        <section className="repository-web-step" aria-label="Create a GitHub repository">
          <h3>Create on GitHub</h3>
          <p>Use your Enterprise Managed User (EMU) account and choose a personal or organization owner allowed by your enterprise. Personal EMU repositories must be private; organizations may allow private or internal repositories. GitHub applies your enterprise policy.</p>
          <p className="repository-warning">Create an empty repository: do not add a README, .gitignore or license. Keep task data private. Already created it? Skip this step and paste its URL below.</p>
          <button type="button" className="secondary-button" disabled={busy !== null || changed} onClick={() => {
            void act('opening', () => nativeWorkspace().openRepositoryCreation(repository.id))
          }}><Icon name="link-external" />Create on GitHub</button>
        </section>
        <form className="repository-push-form" onSubmit={(event) => {
          event.preventDefault()
          void act('planning', async () => {
            setPlan(null)
            setCopied(false)
            const next = await nativeWorkspace().getRepositoryPushPlan({ workspaceId: repository.id, remoteUrl: remoteUrl.trim() })
            setPlan(next)
          })
        }}>
          <label className="form-field">GitHub repository URL<input value={remoteUrl} onChange={(event) => {
            setRemoteUrl(event.target.value)
            setPlan(null)
            setCopied(false)
            setIssue(null)
          }} required maxLength={2048} disabled={busy !== null || changed} placeholder="https://github.com/yourname_enterprise/my-tasks.git" spellCheck={false} autoComplete="off" /></label>
          <p className="dialog-hint">Paste the HTTPS or SSH URL from GitHub. Existing remotes are checked, never overwritten.</p>
          <button type="submit" className="primary-button" disabled={!canPlan}>{busy === 'planning' ? 'Preparing commands...' : 'Get push commands'}</button>
        </form>
        {plan && <section className="repository-terminal" aria-label="Terminal push">
          <h3>Run in {plan.shell === 'powershell' ? 'PowerShell' : 'your shell'}</h3>
          <p>Review and run these commands in your terminal. Task Continuum does not run them or push files for you.</p>
          <pre aria-label="Git push commands"><code>{plan.commands}</code></pre>
          <button type="button" className="secondary-button" disabled={busy !== null || changed} onClick={() => {
            void act('copying', async () => {
              setCopied(false)
              if (window.desktop) await window.desktop.copyText(plan.commands)
              else {
                if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable. Select and copy the commands above.')
                await navigator.clipboard.writeText(plan.commands)
              }
              setCopied(true)
            })
          }}><Icon name="copy" />{copied ? 'Copied' : 'Copy commands'}</button>
          <p className="dialog-hint">A GitHub browser login does not sign terminal Git in. If prompted by GCM, use the same EMU account and enterprise SSO. No token needs to be pasted into this app.</p>
          <button type="button" className="primary-button" disabled={busy !== null || changed} onClick={() => {
            void act('verifying', async () => {
              const result = await nativeWorkspace().verifyRepositoryPublication({ workspaceId: repository.id, remoteUrl: plan.remoteUrl })
              setPublishedUrl(result.url)
            })
          }}>{busy === 'verifying' ? 'Checking push...' : "I've pushed - Check"}</button>
        </section>}
        <p className="dialog-hint">Only committed files are pushed. Review them first; never commit credentials or private session history. Push verification is read-only and runs only when you click Check.</p>
      </>}
      {issue && <p className="repository-error" role="alert">{issue}</p>}
      <div className="dialog-actions">
        {!url && <button type="button" className="secondary-button" disabled={busy !== null || checking || changed} onClick={recheck}>Refresh Git status</button>}
        <button type="button" className="secondary-button" disabled={busy !== null} onClick={onClose}>{url ? 'Done' : 'Keep local for now'}</button>
      </div>
    </>}
  </Dialog>
}
