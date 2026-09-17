import { useEffect, useRef, useState } from 'react'
import type { AgentHostCreationHost } from '../../shared/agentHostCreation'
import type { LocalAgentHostCreation, LocalAgentHostCreateRequest } from '../../shared/localAgentHostCreation'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import type { useWorkspaces } from '../useWorkspaces'
import { AgentHostPanel } from './AgentHostPanel'
import { IconButton } from './Primitives'

export function LocalTaskAgent({ workspace, workspaces, onCreated, onReviewDraft, onTaskChat, onBusy, onClose }: {
  workspace: WorkspaceSnapshot
  workspaces: ReturnType<typeof useWorkspaces>
  onCreated(taskId: string): void
  onReviewDraft(): void
  onTaskChat?(): void
  onBusy(busy: boolean): void
  onClose(): void
}) {
  const bridge = window.agentHost
  const [hosts, setHosts] = useState<AgentHostCreationHost[]>([])
  const [hostId, setHostId] = useState('')
  const [creation, setCreation] = useState<LocalAgentHostCreation>()
  const [operationId, setOperationId] = useState<string>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const request = useRef<LocalAgentHostCreateRequest | undefined>(undefined)
  const initialIds = useRef(new Set(workspace.tasks.map((task) => task.id)))
  const locked = loading || busy || chatBusy || refreshing || creation?.state === 'creating'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { onBusy(locked); return () => onBusy(false) }, [locked, onBusy])

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!bridge) throw new Error('Open the desktop app to create a local Agent Host session.')
      const [hosts, saved] = await Promise.all([bridge.localCreationHosts(), bridge.localCreations()])
      if (!active) return
      setHosts(hosts)
      const available = hosts.filter((host) => host.available)
      setHostId(available.length === 1 ? available[0].hostId : '')
      const existing = saved.find((item) => item.state !== 'failed') ?? saved[0]
      if (existing) {
        request.current = { operationId: existing.operationId, hostId: existing.hostId }
        setOperationId(existing.operationId)
        const current = existing.state === 'failed' ? existing : await bridge.localCreationStatus(existing.operationId)
        if (active) setCreation(current)
      } else if (!request.current && available.length === 1) {
        // Entering agent mode is the explicit creation action; Strict Mode and reloads must not replay it.
        request.current = { operationId: crypto.randomUUID(), hostId: available[0].hostId }
        setOperationId(request.current.operationId)
        const result = await bridge.createLocal(request.current)
        if (active) setCreation(result)
      }
    }
    void load().catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Local Agent Host discovery or creation failed.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, workspace.id, version])

  useEffect(() => {
    if (!bridge || creation?.state !== 'creating') return
    let active = true
    const timer = setTimeout(() => {
      void bridge.localCreationStatus(creation.operationId).then((value) => { if (active) setCreation(value) })
        .catch((failure: unknown) => {
          if (active) {
            setCreation({ ...creation, state: 'uncertain' })
            setError(failure instanceof Error ? failure.message : 'The local session outcome is unknown. Check its status before trying again.')
          }
        })
    }, 1000)
    return () => { active = false; clearTimeout(timer) }
  }, [bridge, creation])

  async function run(action: () => Promise<LocalAgentHostCreation>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (mounted.current) setCreation(result)
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Local Agent Host creation failed.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function refreshTasks(): Promise<void> {
    if (pending.current) return
    pending.current = true
    setRefreshing(true)
    setError('')
    setNotice('')
    try {
      const state = await workspaces.refreshCreatedTasks()
      if (!mounted.current) return
      const created = state.current?.tasks.find((task) => !initialIds.current.has(task.id))
      initialIds.current = new Set(state.current?.tasks.map((task) => task.id))
      if (created) { onCreated(created.id); setNotice(`Opened ${created.id}. You can keep chatting here.`) }
      else setNotice('Tasks refreshed. No new task found yet.')
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Created tasks could not be refreshed.')
    } finally {
      pending.current = false
      if (mounted.current) setRefreshing(false)
    }
  }

  const session = creation?.state === 'ready' ? creation.session : undefined
  return <section className="chat-panel task-creation-chat" aria-label="Task creation">
    <header className="panel-header"><span>CREATE TASKS</span><div className="header-actions">
      {onTaskChat && <IconButton icon="comment-discussion" label="Show task conversation" disabled={locked} onClick={onTaskChat} />}
      <IconButton icon="layout-sidebar-right-off" label="Hide chat panel" onClick={onClose} />
    </div></header>
    <div className="local-task-actions">
      <button type="button" className="secondary-button" disabled={locked} onClick={() => { void refreshTasks() }}>{refreshing ? 'Refreshing...' : 'Refresh created tasks'}</button>
      <button type="button" className="secondary-button" disabled={locked} onClick={onReviewDraft}>Review agent draft</button>
    </div>
    {notice && <p className="task-create-notice" role="status">{notice}</p>}
    {error && <p className="task-create-error" role="alert">{error}</p>}
    {session ? <AgentHostPanel
      key={session.sessionId}
      workspace={workspace}
      target={{ hostId: session.hostId, sessionId: session.sessionId, chatId: session.chatId, owner: session.owner }}
      onClose={onClose}
      onBusy={setChatBusy}
      beforeReconnect={async () => {
        if (!bridge || !operationId) throw new Error('The original local creation operation is unavailable.')
        const current = await bridge.localCreationStatus(operationId)
        if (!mounted.current) return
        if (current.state !== 'ready' && current.state !== 'failed') throw new Error(current.error || 'The original local session is not currently available. Check its status after reconnecting the Host.')
        if (current.state === 'failed') setNotice('')
        setCreation(current)
      }}
      prepareFirstMessage={async (text) => {
        if (!window.workspace) throw new Error('The desktop workspace API is unavailable.')
        const instructions = await window.workspace.getTaskAgentInstructions({
          workspaceId: workspace.id, goal: text || 'Create tasks from the attached requirements.', parentId: null,
        })
        if (instructions.length > 4000) throw new Error('Task creation guidance and your first message exceed the chat limit. Shorten the first request, then provide details in follow-up messages.')
        return instructions
      }}
    /> : <section className="local-task-agent" aria-label="Local Agent Host session">
    {loading && <p role="status">Opening a local Agent Host session for this repository...</p>}
    {!loading && !hosts.some((host) => host.available) && <p role="status">No supported local Agent Host is available. Start VS Code with a signed-in Copilot provider and AHP 0.9.0, then reload local hosts.</p>}
    {hosts.filter((host) => !host.available).map((host) => <p key={host.hostId} className="muted">{host.name}: {host.error || 'Unavailable'}</p>)}
    {creation && <p role="status">{creation.state === 'creating' ? 'Creating the local session...' : creation.state === 'uncertain' ? 'Session creation outcome is uncertain. Only the original session will be checked; creation is not replayed.' : creation.session ? 'The saved local session is no longer available.' : 'Local session creation failed.'} {creation.error}</p>}
    {!loading && (!operationId || creation?.state === 'failed') && <>
      <label className="form-field">Local Agent Host<select aria-label="Local Agent Host" value={hostId} disabled={busy} onChange={(event) => setHostId(event.target.value)}>
        <option value="">Select a local Host</option>
        {hosts.filter((host) => host.available).map((host) => <option key={host.hostId} value={host.hostId}>{host.name}</option>)}
      </select></label>
      <button type="button" className="primary-button" disabled={!bridge || !hostId || busy} onClick={() => {
        if (!bridge) return
        void run(() => {
          request.current = { operationId: crypto.randomUUID(), hostId }
          setOperationId(request.current.operationId)
          return bridge.createLocal(request.current)
        })
      }}>Create local agent session</button>
    </>}
    {!loading && operationId && creation?.state !== 'failed' && <button type="button" className="secondary-button" disabled={!bridge || busy} onClick={() => {
      if (bridge && operationId) void run(() => bridge.localCreationStatus(operationId))
    }}>Check session status</button>}
    <button type="button" className="secondary-button" disabled={loading || busy} onClick={() => { setLoading(true); setError(''); setVersion((value) => value + 1) }}>Reload local hosts</button>
    </section>}
  </section>
}
