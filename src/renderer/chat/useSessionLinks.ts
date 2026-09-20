import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionLinksSnapshot } from '../../shared/sessionBindings'
import { taskSessionLinks } from '../../shared/sessionBindings'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import type { SessionBinding, SessionBindings } from './sessionBindings'

function uiBindings(snapshot: SessionLinksSnapshot): SessionBindings {
  if (snapshot.document.schemaVersion !== '2.1') throw new Error('Workspace session bindings require schema v2.1. Previous bindings are unsupported and are not migrated. Use a fresh workspace binding configuration and link existing native sessions again.')
  return Object.fromEntries(Object.keys(snapshot.document.bindings).map((taskId) => [taskId, taskSessionLinks(snapshot.document.bindings, taskId).map((link) => {
    if (link.provider !== 'agent-host' || 'hostId' in link || !link.sessionId || !link.chatId || !link.owner?.clientId || !link.owner.machineName) throw new Error('Workspace session bindings must contain owned logical Agent Host targets. Host-pinned bindings are not supported.')
    return { id: link.sessionId, title: 'Agent Host', owner: link.owner, ownerIsRemote: link.owner.clientId !== snapshot.localOwner?.clientId, agentHost: { sessionId: link.sessionId, chatId: link.chatId, owner: link.owner } }
  })]))
}

export function useSessionLinks(workspace: WorkspaceSnapshot | null) {
  const bridge = window.workspace
  const [bindings, setBindings] = useState<SessionBindings>({})
  const [snapshot, setSnapshot] = useState<SessionLinksSnapshot | null>(null)
  const [busy, setBusy] = useState(Boolean(workspace))
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef(Boolean(workspace))
  const flushRefresh = useRef<(() => void) | undefined>(undefined)
  const lastRevision = useRef<string | null | undefined>(undefined)
  const readGeneration = useRef(0)
  const applySnapshot = useCallback((value: SessionLinksSnapshot) => {
    const next = uiBindings(value)
    lastRevision.current = value.revision
    setSnapshot(value)
    setBindings(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!workspace) return () => { mounted.current = false }
    pending.current = true
    let cancelled = false
    let refreshing = false
    let refreshRequested = false
    const refresh = () => {
      if (!bridge || cancelled) return
      if (pending.current || refreshing) { refreshRequested = true; return }
      refreshRequested = false
      refreshing = true
      const generation = readGeneration.current
      void bridge.getSessionLinks(workspace.id).then((value) => {
        if (cancelled || pending.current || generation !== readGeneration.current) { refreshRequested = true; return }
        if (value.revision !== lastRevision.current) applySnapshot(value)
        setError(null)
      }).catch((failure: unknown) => {
        if (cancelled) return
        if (pending.current || generation !== readGeneration.current) { refreshRequested = true; return }
        setError(failure instanceof Error ? failure.message : 'Repository session links could not be refreshed.')
      }).finally(() => {
        refreshing = false
        if (refreshRequested && !pending.current && !cancelled) refresh()
      })
    }
    flushRefresh.current = () => { if (refreshRequested) refresh() }
    const load = bridge ? bridge.getSessionLinks(workspace.id) : Promise.reject(new Error('The workspace session link bridge is unavailable.'))
    void load.then((value) => {
      if (cancelled) return
      applySnapshot(value)
      setError(null)
    }).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : 'Repository session links could not be read.')
    }).finally(() => {
      if (!cancelled) { pending.current = false; setBusy(false); flushRefresh.current?.() }
    })
    const timer = setInterval(refresh, 5000)
    const unsubscribe = window.remoteVSCode?.gitSync?.onBindingsChanged(refresh)
    return () => { cancelled = true; mounted.current = false; flushRefresh.current = undefined; clearInterval(timer); unsubscribe?.() }
  }, [applySnapshot, bridge, workspace])

  function ready() {
    if (!workspace) throw new Error('Open a task workspace before changing an Agent Host binding.')
    if (pending.current) throw new Error('Session links are still loading or saving.')
    if (!bridge || !snapshot || error) throw new Error('Reload repository session links before changing the connection.')
    return { workspace, bridge, snapshot }
  }

  async function run(action: (context: ReturnType<typeof ready>) => Promise<SessionLinksSnapshot>): Promise<void> {
    const context = ready()
    readGeneration.current += 1
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const value = await action(context)
      if (mounted.current) applySnapshot(value)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The session link could not be saved.')
      throw failure
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
      flushRefresh.current?.()
    }
  }

  async function attach(taskId: string, binding: SessionBinding): Promise<void> {
    await run(({ workspace, bridge, snapshot }) => {
      const target = binding.agentHost
      if (!target || 'hostId' in target || !target.sessionId || !target.chatId || !target.owner?.clientId || !target.owner.machineName || 'vscodeWorkspaceStorageId' in binding || 'remoteMachineName' in binding) throw new Error('Workspace session links require an owned logical Agent Host target. Host-pinned, Local Copilot and VS Code session bindings are not supported.')
      if (binding.id !== target.sessionId || binding.owner && (binding.owner.clientId !== target.owner.clientId || binding.owner.machineName !== target.owner.machineName)) throw new Error('The selected session and owner must match the Agent Host target.')
      return bridge.updateSessionLink({ workspaceId: workspace.id, taskId, sessionId: target.sessionId, agentHost: { chatId: target.chatId }, owner: target.owner, expectedRevision: snapshot.revision })
    })
  }

  async function detach(taskId: string, binding?: SessionBinding): Promise<void> {
    await run(({ workspace, bridge, snapshot }) => bridge.updateSessionLink({ workspaceId: workspace.id, taskId, sessionId: null, ...(binding ? { detachTarget: binding.agentHost } : {}), expectedRevision: snapshot.revision }))
  }

  async function reload(): Promise<SessionLinksSnapshot | undefined> {
    if (!workspace || !bridge || pending.current) return
    readGeneration.current += 1
    pending.current = true
    setBusy(true)
    try {
      const value = await bridge.getSessionLinks(workspace.id)
      if (mounted.current) { applySnapshot(value); setError(null) }
      return value
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Repository session links could not be read.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
      flushRefresh.current?.()
    }
  }

  return {
    bindings, busy, error, attach, detach, reload, localOwner: snapshot?.localOwner,
    ready: !busy && !error && workspace !== null && snapshot !== null,
  }
}