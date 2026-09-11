import { useEffect, useRef, useState } from 'react'
import type { SessionLink, SessionLinksSnapshot } from '../../shared/sessionBindings'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { clearSessionBindings, readSessionBindings, saveSessionBindings, sessionBindingKey } from './sessionBindings'
import type { SessionBinding, SessionBindings } from './sessionBindings'

function uiBindings(snapshot: SessionLinksSnapshot): SessionBindings {
  return Object.fromEntries(Object.entries(snapshot.document.bindings).map(([taskId, link]) => {
    if (link.provider === 'agent-host') return [taskId, { id: link.sessionId, title: 'Agent Host', owner: link.owner, ownerIsRemote: link.owner.clientId !== snapshot.localOwner?.clientId, agentHost: { hostId: link.hostId, sessionId: link.sessionId, chatId: link.chatId, owner: link.owner } }]
    const machine = link.owner ? link.owner.clientId !== snapshot.localOwner?.clientId ? link.owner.machineName : undefined : link.provider === 'vscode-copilot' ? link.remoteMachineName : undefined
    return [taskId, { id: link.sessionId, title: 'GitHub Copilot', ...(link.owner ? { owner: link.owner, ownerIsRemote: link.owner.clientId !== snapshot.localOwner?.clientId } : {}), ...(link.provider === 'vscode-copilot' ? { vscodeWorkspaceStorageId: link.workspaceStorageId, ...(machine ? { remoteMachineName: machine } : {}) } : {}) }]
  }))
}

function repositoryLink(binding: SessionBinding): SessionLink {
  if (binding.agentHost) return { provider: 'agent-host', ...binding.agentHost }
  return binding.vscodeWorkspaceStorageId
    ? { provider: 'vscode-copilot', sessionId: binding.id, workspaceStorageId: binding.vscodeWorkspaceStorageId, ...(binding.remoteMachineName ? { remoteMachineName: binding.remoteMachineName } : {}) }
    : { provider: 'github-copilot', sessionId: binding.id }
}

export function useSessionLinks(workspace: WorkspaceSnapshot | null) {
  const bridge = window.workspace
  const [bindings, setBindings] = useState<SessionBindings>(() => workspace ? {} : readSessionBindings())
  const [legacy] = useState<SessionBindings>(() => workspace ? Object.fromEntries(Object.entries(readSessionBindings(workspace.id)).filter(([taskId]) => workspace.tasks.some((task) => task.id === taskId))) : {})
  const [snapshot, setSnapshot] = useState<SessionLinksSnapshot | null>(null)
  const [busy, setBusy] = useState(Boolean(workspace))
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef(Boolean(workspace))

  useEffect(() => {
    mounted.current = true
    if (!workspace) return () => { mounted.current = false }
    pending.current = true
    let cancelled = false
    let lastRevision: string | null | undefined
    let refreshing = false
    const load = bridge ? bridge.getSessionLinks(workspace.id) : Promise.reject(new Error('The workspace session link bridge is unavailable.'))
    void load.then((value) => {
      if (cancelled) return
      lastRevision = value.revision
      setSnapshot(value)
      setBindings(uiBindings(value))
      setError(null)
    }).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : 'Repository session links could not be read.')
    }).finally(() => {
      if (!cancelled) { pending.current = false; setBusy(false) }
    })
    const timer = setInterval(() => {
      if (!bridge || pending.current || refreshing || cancelled) return
      refreshing = true
      void bridge.getSessionLinks(workspace.id).then((value) => {
        if (cancelled || pending.current) return
        if (value.revision !== lastRevision) { lastRevision = value.revision; setSnapshot(value); setBindings(uiBindings(value)) }
        setError(null)
      }).catch((failure: unknown) => { if (!cancelled && !pending.current) setError(failure instanceof Error ? failure.message : 'Repository session links could not be refreshed.') }).finally(() => { refreshing = false })
    }, 5000)
    return () => { cancelled = true; mounted.current = false; clearInterval(timer) }
  }, [bridge, workspace])

  useEffect(() => { if (!workspace) saveSessionBindings(bindings) }, [bindings, workspace])

  function ready(): void {
    if (pending.current) throw new Error('Session links are still loading or saving.')
    if (workspace && (!bridge || !snapshot || error)) throw new Error('Reload repository session links before changing the connection.')
  }

  async function run(action: () => Promise<SessionLinksSnapshot>): Promise<void> {
    ready()
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const value = await action()
      if (mounted.current) { setSnapshot(value); setBindings(uiBindings(value)) }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The session link could not be saved.')
      throw failure
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function attach(taskId: string, binding: SessionBinding): Promise<void> {
    ready()
    if (!workspace) {
      setBindings((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([id, link]) => id === taskId || sessionBindingKey(link) !== sessionBindingKey(binding))), [taskId]: binding }))
      return
    }
    await run(() => bridge!.updateSessionLink({ workspaceId: workspace.id, taskId, sessionId: binding.id, expectedRevision: snapshot!.revision, ...(binding.owner ? { owner: binding.owner } : {}), ...(binding.agentHost ? { agentHost: { hostId: binding.agentHost.hostId, chatId: binding.agentHost.chatId }, owner: binding.agentHost.owner } : {}), ...(binding.vscodeWorkspaceStorageId ? { vscodeWorkspaceStorageId: binding.vscodeWorkspaceStorageId, ...(binding.remoteMachineName ? { vscodeRemoteMachineName: binding.remoteMachineName } : {}) } : {}) }))
  }

  async function detach(taskId: string): Promise<void> {
    ready()
    if (!workspace) {
      setBindings((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== taskId)))
      return
    }
    await run(() => bridge!.updateSessionLink({ workspaceId: workspace.id, taskId, sessionId: null, expectedRevision: snapshot!.revision }))
  }

  async function migrate(): Promise<void> {
    if (!workspace || !bridge || !snapshot || snapshot.revision !== null) throw new Error('Local bindings can only be migrated before a repository link file exists.')
    await run(() => bridge.migrateSessionLinks({ workspaceId: workspace.id, bindings: Object.fromEntries(Object.entries(legacy).map(([taskId, binding]) => [taskId, repositoryLink(binding)])) }))
    clearSessionBindings(workspace.id)
  }

  async function reload(): Promise<void> {
    if (!workspace || !bridge || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const value = await bridge.getSessionLinks(workspace.id)
      if (mounted.current) { setSnapshot(value); setBindings(uiBindings(value)); setError(null) }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Repository session links could not be read.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    bindings, busy, error, legacy, attach, detach, migrate, reload,
    ready: !busy && !error && (!workspace || snapshot !== null),
    needsMigration: Boolean(workspace && snapshot?.revision === null && Object.keys(legacy).length),
  }
}