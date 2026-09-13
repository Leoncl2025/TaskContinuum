import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { AgentHostCreation, AgentHostCreateRequest, AgentHostWorker } from '../../shared/agentHostCreation'
import type { AgentHostSession } from '../../shared/agentHost'
import { Icon } from './Primitives'
import './agent-host-creation.css'

interface CreationControlsProps {
  taskId?: string
  taskUnbound: boolean
  disabled?: boolean
  onCreated?(taskId: string, session: AgentHostSession): Promise<void>
}

type Lifetime = { active: boolean }

const stateLabels: Record<AgentHostCreation['state'], string> = {
  creating: 'Creating',
  uncertain: 'Outcome uncertain',
  failed: 'Creation failed',
  'created-unbound': 'Created, assignment incomplete',
  ready: 'Created and assigned',
}

function pending(operation: AgentHostCreation): boolean {
  return operation.state === 'creating' || operation.state === 'uncertain' || operation.state === 'created-unbound'
}

function sameOperation(left: AgentHostCreation, right: AgentHostCreation): boolean {
  return left.operationId === right.operationId && left.taskId === right.taskId && left.workerId === right.workerId && left.workspaceId === right.workspaceId && left.hostId === right.hostId
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'The remote creation operation could not be checked.'
}

export function AgentHostCreationControls(props: CreationControlsProps) {
  return <CreationControls key={props.taskId ?? 'no-task'} {...props} />
}

function CreationControls({ taskId, taskUnbound, disabled = false, onCreated }: CreationControlsProps) {
  const bridge = window.agentHost
  const supported = Boolean(bridge && ['creationWorkers', 'creations', 'create', 'creationStatus', 'bindCreation'].every((name) => typeof bridge[name as keyof typeof bridge] === 'function'))
  const [workers, setWorkers] = useState<AgentHostWorker[]>([])
  const [operations, setOperations] = useState<AgentHostCreation[]>([])
  const savedOperations = useRef<AgentHostCreation[]>([])
  const [workerId, setWorkerId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [hostId, setHostId] = useState('')
  const [catalogueLoaded, setCatalogueLoaded] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [catalogueError, setCatalogueError] = useState<string>()
  const [historyError, setHistoryError] = useState<string>()
  const [error, setError] = useState<string>()
  const [completedOperation, setCompletedOperation] = useState<string>()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const lifetime = useRef<Lifetime>({ active: false })
  const worker = workers.find((item) => item.id === workerId)
  const workspace = worker?.workspaces.find((item) => item.id === workspaceId)
  const host = worker?.hosts.find((item) => item.hostId === hostId)
  const unresolved = operations.some(pending)
  const canCreate = Boolean(taskId && taskUnbound && supported && !disabled && !busy && catalogueLoaded && historyLoaded && !catalogueError && !historyError && !unresolved && !completedOperation && worker?.state === 'connected' && workspace?.canSend && workspace.taskState === 'available' && host?.available)

  function save(operation: AgentHostCreation): void {
    if (operation.taskId !== taskId) throw new Error('The creation response belongs to a different task.')
    const previous = savedOperations.current.find((item) => item.operationId === operation.operationId)
    if (previous && !sameOperation(previous, operation)) throw new Error('The creation response does not match the original worker, workspace, and Host.')
    savedOperations.current = [...savedOperations.current.filter((item) => item.operationId !== operation.operationId), operation]
    setOperations(savedOperations.current)
  }

  async function openCreated(operation: AgentHostCreation, scope: Lifetime): Promise<void> {
    if (!scope.active || !onCreated) return
    try {
      if (!operation.session) throw new Error('The created chat identity has not been confirmed.')
      await onCreated(operation.taskId, operation.session)
    } catch (failure) {
      if (scope.active) setError(`The chat is saved, but could not be opened. ${failureMessage(failure)} Use Open created chat to try again.`)
    }
  }

  async function check(operation: AgentHostCreation, scope: Lifetime): Promise<void> {
    try {
      const result = await bridge!.creationStatus(operation.operationId)
      if (!scope.active) return
      if (!sameOperation(operation, result)) throw new Error('The status response does not match the original creation operation.')
      save(result)
      if (result.state === 'ready') { setCompletedOperation(result.operationId); await openCreated(result, scope) }
    } catch (failure) {
      if (scope.active) save({ ...operation, state: operation.state === 'creating' ? 'uncertain' : operation.state, error: failureMessage(failure) })
    }
  }

  async function run(action: (scope: Lifetime) => Promise<void>, clearError = true): Promise<void> {
    const scope = lifetime.current
    if (!scope.active || !supported || !taskId || running.current) return
    running.current = true
    setBusy(true)
    if (clearError) setError(undefined)
    try { await action(scope) } catch (failure) {
      if (scope.active) setError(failureMessage(failure))
    } finally {
      if (scope.active) { running.current = false; setBusy(false) }
    }
  }

  async function refresh(clearError = false): Promise<void> {
    await run(async (scope) => {
      const previouslyPending = new Set(savedOperations.current.filter(pending).map((operation) => operation.operationId))
      const [catalogue, history] = await Promise.allSettled([bridge!.creationWorkers(taskId!), bridge!.creations(taskId!)])
      if (!scope.active) return
      if (catalogue.status === 'fulfilled') { setWorkers(catalogue.value); setCatalogueLoaded(true); setCatalogueError(undefined) }
      else { setCatalogueError(failureMessage(catalogue.reason)); setCatalogueLoaded(false) }
      if (history.status === 'fulfilled') {
        for (const operation of history.value) save(operation)
        setHistoryLoaded(true)
        setHistoryError(undefined)
      } else { setHistoryError(failureMessage(history.reason)); setHistoryLoaded(false) }
      for (const operation of savedOperations.current.filter((item) => pending(item) || previouslyPending.has(item.operationId))) {
        if (!scope.active) return
        await check(operation, scope)
      }
    }, clearError)
  }

  const refreshFromEffect = useEffectEvent(() => { void refresh() })
  useEffect(() => {
    const scope = { active: true }
    lifetime.current = scope
    running.current = false
    const tick = () => { if (scope.active) refreshFromEffect() }
    void Promise.resolve().then(tick)
    const timer = setInterval(tick, 5000)
    window.addEventListener('online', tick)
    return () => { scope.active = false; clearInterval(timer); window.removeEventListener('online', tick) }
  }, [bridge, taskId, supported])

  async function create(): Promise<void> {
    if (!canCreate || running.current || !worker || !workspace || !host || !taskId) return
    const request: AgentHostCreateRequest = { operationId: crypto.randomUUID(), taskId, workerId: worker.id, workspaceId: workspace.id, hostId: host.hostId, expectedRevision: workspace.expectedRevision }
    await run(async (scope) => {
      const operation: AgentHostCreation = { ...request, state: 'creating' }
      save(operation)
      try {
        const result = await bridge!.create(request)
        if (!scope.active) return
        if (!sameOperation(operation, result)) throw new Error('The response does not match the original creation operation.')
        save(result)
        if (result.state === 'ready') { setCompletedOperation(result.operationId); await openCreated(result, scope) }
      } catch (failure) {
        if (scope.active) save({ ...operation, state: 'uncertain', error: failureMessage(failure) })
      }
    })
  }

  async function retryBinding(operation: AgentHostCreation): Promise<void> {
    await run(async (scope) => {
      const result = await bridge!.bindCreation(operation.operationId)
      if (!scope.active) return
      if (!sameOperation(operation, result)) throw new Error('The assignment response does not match the original creation operation.')
      save(result)
      if (result.state === 'ready') { setCompletedOperation(result.operationId); await openCreated(result, scope) }
    })
  }

  return <section className="ah-creation" aria-label="Create on remote worker" aria-busy={busy}>
    <h3><Icon name="server-environment" />Create on remote worker</h3>
    <p className="muted">Read and send access includes creation in the same shared workspace. Creates in the selected workspace folder (no worktree). Native tool approvals remain on the worker. No prompt is sent. Other Host settings keep their native defaults. The native agent may initialize on the first explicit send. Choose a model when sending.</p>
    {!supported && <p role="status">Remote creation is unavailable in this version of the desktop Agent Host API.</p>}
    {!taskId ? <p role="status">Select a task in a real workspace to create and assign a chat.</p> : !taskUnbound && <p role="status">Creation requires an unbound task. Detach its current conversation first, or wait for session links to finish loading.</p>}
    {supported && taskId && <>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void refresh(true) }}><Icon name="refresh" />Refresh workers and creation status</button>
      {(!catalogueLoaded || !historyLoaded) && !catalogueError && !historyError && <p className="muted" role="status">Loading workers and saved creation operations...</p>}
      {catalogueError && <p className="copilot-error" role="alert">Workers could not be loaded: {catalogueError}</p>}
      {historyError && <p className="copilot-error" role="alert">Saved creations could not be loaded. Creation is disabled to avoid duplicates. {historyError}</p>}
      {catalogueLoaded && !workers.length && <p className="muted">No paired remote workers are available. Manage devices to connect a worker.</p>}
    </>}
    <div className="ah-creation-pickers">
      <label className="form-field">Remote worker<select aria-label="Remote worker" value={workerId} disabled={!supported || busy || disabled || !taskId} onChange={(event) => { setWorkerId(event.target.value); setWorkspaceId(''); setHostId('') }}><option value="">Choose a worker</option>{workers.map((item) => <option key={item.id} value={item.id}>{item.owner.machineName} — {item.state} ({item.id})</option>)}</select></label>
      <label className="form-field">Shared worker workspace<select aria-label="Shared worker workspace" value={workspaceId} disabled={!worker || busy || disabled} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">Choose a workspace</option>{worker?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.canSend ? 'Read and send' : 'Read only'} / task {item.taskState} ({item.id})</option>)}</select></label>
      <label className="form-field">Exact Agent Host<select aria-label="Exact Agent Host" value={hostId} disabled={!worker || busy || disabled} onChange={(event) => setHostId(event.target.value)}><option value="">Choose a Host</option>{worker?.hosts.map((item) => <option key={item.hostId} value={item.hostId}>{item.name} — {item.available ? 'available' : 'unavailable'} ({item.hostId})</option>)}</select></label>
    </div>
    {worker && <div className="ah-creation-selection">
      <p>Machine: <strong>{worker.owner.machineName}</strong> · Worker: <code>{worker.id}</code> · Owner: <code>{worker.owner.clientId}</code></p>
      {worker.state !== 'connected' && <p role="status">{worker.state === 'offline' ? 'This worker is offline. Reconnect it in Manage devices, then check the saved operation.' : 'This worker does not support remote chat creation. Update the worker before creating.'}</p>}
      {worker.error && <p className="copilot-error" role="alert">{worker.error}</p>}
      {!worker.workspaces.length && <p role="status">This worker exposes no shared workspaces.</p>}
      {!worker.hosts.length && <p role="status">This worker exposes no Agent Hosts.</p>}
      {workspace && !workspace.canSend && <p role="status">This shared workspace is read only. Read and send access is required to create.</p>}
      {workspace && workspace.taskState !== 'available' && <p role="status">{workspace.taskState === 'bound' ? 'This task already has a conversation on the worker.' : workspace.taskState === 'missing' ? 'This task is missing from the worker workspace.' : 'The task state on this worker could not be verified.'}</p>}
      {workspace?.error && <p className="copilot-error" role="alert">{workspace.error}</p>}
      {host && !host.available && <p role="status">The selected Agent Host is unavailable.</p>}
      {host?.error && <p className="copilot-error" role="alert">{host.error}</p>}
    </div>}
    <button type="button" className="primary-button" disabled={!canCreate} onClick={() => { void create() }}>Create and assign{taskId ? ` to ${taskId}` : ''}</button>
    {unresolved && <p className="muted" role="status">Resolve the saved creation below before starting another. Status checks never create a second chat.</p>}
    {completedOperation && <p className="muted" role="status">A chat is already saved for this task. Open the created chat instead of creating another.</p>}
    {error && <p className="copilot-error" role="alert">{error}</p>}
    <div className="ah-creation-operations" aria-live="polite">
      {operations.map((operation) => {
        const source = workers.find((item) => item.id === operation.workerId)
        const owner = operation.session?.owner ?? source?.owner
        return <section className="ah-creation-operation" key={operation.operationId} aria-label={`Creation ${operation.operationId}`}>
          <h4>{stateLabels[operation.state]} · {operation.taskId}</h4>
          <dl><div><dt>Machine</dt><dd>{owner?.machineName ?? 'Machine unavailable'}{owner && <> · <code>{owner.clientId}</code></>}</dd></div><div><dt>Worker</dt><dd>{operation.workerId}</dd></div><div><dt>Workspace</dt><dd>{operation.workspaceId}</dd></div><div><dt>Host</dt><dd>{operation.hostId}</dd></div><div><dt>Operation</dt><dd>{operation.operationId}</dd></div>{operation.session && <><div><dt>Session</dt><dd>{operation.session.sessionId}</dd></div><div><dt>Chat</dt><dd>{operation.session.chatId}</dd></div></>}</dl>
          {operation.state === 'uncertain' && <p>The worker may have created the chat. Check this same operation after reconnecting; do not create again.</p>}
          {operation.state === 'created-unbound' && <p>The chat exists. Retry only its assignment; no new chat or prompt will be created.</p>}
          {operation.nativeLifecycle === 'creating' && operation.session && <p>The Host acknowledged this chat. Its native agent initializes on the first explicit send; no warm-up prompt was sent.</p>}
          {operation.error && <p className="copilot-error" role="alert">{operation.error}</p>}
          <div className="ah-creation-actions">
            {pending(operation) && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run((scope) => check(operation, scope)) }}>Check status</button>}
            {operation.state === 'created-unbound' && <button type="button" className="primary-button" disabled={busy || !taskUnbound} onClick={() => { void retryBinding(operation) }}>Retry binding</button>}
            {operation.state === 'ready' && onCreated && <button type="button" className="primary-button" disabled={busy} onClick={() => { void run((scope) => openCreated(operation, scope)) }}>Open created chat</button>}
          </div>
        </section>
      })}
    </div>
  </section>
}
