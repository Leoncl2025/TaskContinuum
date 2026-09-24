import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { AgentHostCreation, AgentHostCreateRequest, AgentHostCreationLocation, AgentHostWorker } from '../../shared/agentHostCreation'
import type { AgentHostSession } from '../../shared/agentHost'
import { Icon } from './Primitives'
import './agent-host-creation.css'

interface CreationControlsProps {
  taskId?: string
  taskReady: boolean
  disabled?: boolean
  onCreated?(taskId: string, session: AgentHostSession): Promise<void>
}

type Lifetime = { active: boolean }
type Activity = 'foreground' | 'background'
type RunScope = Lifetime & { mode: Activity }

const stateLabels: Record<AgentHostCreation['state'], string> = {
  creating: 'Creating',
  uncertain: 'Outcome uncertain',
  failed: 'Creation failed',
  'created-unbound': 'Created, assignment incomplete',
  ready: 'Created and assigned',
  abandoned: 'Creation abandoned',
}

function pending(operation: AgentHostCreation): boolean {
  return operation.state === 'creating' || operation.state === 'uncertain' || operation.state === 'created-unbound'
}

function sameOperation(left: AgentHostCreation, right: AgentHostCreation): boolean {
  return left.operationId === right.operationId && left.taskId === right.taskId && left.workerId === right.workerId && left.workspaceId === right.workspaceId && left.hostId === right.hostId
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'The creation operation could not be checked.'
}

export function AgentHostCreationControls(props: CreationControlsProps) {
  return <CreationControls key={props.taskId ?? 'no-task'} {...props} />
}

function CreationControls({ taskId, taskReady, disabled = false, onCreated }: CreationControlsProps) {
  const bridge = window.agentHost
  const supported = Boolean(bridge && ['creationWorkers', 'creations', 'create', 'creationStatus', 'bindCreation'].every((name) => typeof bridge[name as keyof typeof bridge] === 'function'))
  const [location, setLocation] = useState<AgentHostCreationLocation>('remote')
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
  const [busy, setBusy] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState<string>()
  const running = useRef<RunScope | undefined>(undefined)
  const lifetime = useRef<Lifetime>({ active: false })
  const local = location === 'local'
  const heading = local ? 'Create on this computer' : 'Create on remote worker'
  const worker = workers.find((item) => item.id === workerId)
  const workspace = worker?.workspaces.find((item) => item.id === workspaceId)
  const host = worker?.hosts.find((item) => item.hostId === hostId)
  const unresolved = operations.some(pending)
  const canCreate = Boolean(taskId && taskReady && supported && !disabled && !busy && catalogueLoaded && historyLoaded && !catalogueError && !historyError && !unresolved && (!local || (worker?.local === true && worker.workspaces.length === 1)) && worker?.state === 'connected' && workspace?.canSend && (workspace.taskState === 'available' || workspace.taskState === 'bound') && host?.available)
  const missingChoice = !local && !worker ? 'Choose a remote worker to enable creation.'
    : !local && worker && !workspace ? 'Choose a shared worker workspace to enable creation.'
      : worker && workspace && !host ? 'Choose the exact Agent Host to enable creation.' : undefined

  function save(operation: AgentHostCreation): void {
    if (operation.taskId !== taskId) throw new Error('The creation response belongs to a different task.')
    const previous = savedOperations.current.find((item) => item.operationId === operation.operationId)
    if (previous && !sameOperation(previous, operation)) throw new Error('The creation response does not match the original worker, workspace, and Host.')
    savedOperations.current = [...savedOperations.current.filter((item) => item.operationId !== operation.operationId), ...(operation.state === 'abandoned' ? [] : [operation])]
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
      if (result.state === 'ready') await openCreated(result, scope)
    } catch (failure) {
      if (scope.active) save({ ...operation, state: operation.state === 'creating' ? 'uncertain' : operation.state, error: failureMessage(failure) })
    }
  }

  async function run(action: (scope: Lifetime) => Promise<void>, clearError = true, mode: Activity = 'foreground'): Promise<void> {
    const previous = running.current
    if (!lifetime.current.active || !supported || !taskId || (previous && (previous.mode === 'foreground' || mode === 'background'))) return
    // User actions supersede polling; its late results must not overwrite the new action.
    if (previous) previous.active = false
    const scope: RunScope = { active: true, mode }
    running.current = scope
    setBusy(mode === 'foreground')
    if (clearError) setError(undefined)
    try { await action(scope) } catch (failure) {
      if (scope.active) setError(failureMessage(failure))
    } finally {
      if (scope.active) { scope.active = false; running.current = undefined; setBusy(false) }
    }
  }

  async function loadCatalogue(scope: Lifetime): Promise<AgentHostWorker[] | undefined> {
    let value: AgentHostWorker[]
    try { value = await (local ? bridge!.creationWorkers(taskId!, 'local') : bridge!.creationWorkers(taskId!)) }
    catch (failure) { if (scope.active) { setCatalogueError(failureMessage(failure)); setCatalogueLoaded(false) }; return }
    if (!scope.active) return
    const localWorkers = value.filter((item) => item.local === true)
    const availableWorkers = local ? (localWorkers.length === 1 ? localWorkers : []) : value
    setWorkers(availableWorkers)
    if (local) {
      const localWorker = availableWorkers[0]
      setWorkerId(localWorker?.id ?? '')
      setWorkspaceId(localWorker?.workspaces.length === 1 ? localWorker.workspaces[0].id : '')
    }
    setCatalogueLoaded(true)
    setCatalogueError(undefined)
    return availableWorkers
  }

  async function refresh(clearError = false, mode: Activity = 'foreground'): Promise<void> {
    await run(async (scope) => {
      const previouslyPending = new Set(savedOperations.current.filter(pending).map((operation) => operation.operationId))
      const catalogue = loadCatalogue(scope)
      const history = (async () => {
        let operations: AgentHostCreation[]
        try { operations = await bridge!.creations(taskId!) }
        catch (failure) { if (scope.active) { setHistoryError(failureMessage(failure)); setHistoryLoaded(false) }; return }
        if (!scope.active) return
        for (const operation of operations) save(operation)
        setHistoryLoaded(true)
        setHistoryError(undefined)
        for (const operation of savedOperations.current.filter((item) => pending(item) || previouslyPending.has(item.operationId))) {
          if (!scope.active) return
          await check(operation, scope)
        }
      })()
      await Promise.all([catalogue, history])
    }, clearError, mode)
  }

  const refreshFromEffect = useEffectEvent((mode: Activity) => { void refresh(false, mode) })
  useEffect(() => {
    const scope = { active: true }
    lifetime.current = scope
    running.current = undefined
    const tick = () => { if (scope.active) refreshFromEffect('background') }
    void Promise.resolve().then(() => { if (scope.active) refreshFromEffect('foreground') })
    const timer = setInterval(tick, 5000)
    window.addEventListener('online', tick)
    return () => {
      scope.active = false
      if (running.current) running.current.active = false
      clearInterval(timer)
      window.removeEventListener('online', tick)
    }
  }, [bridge, taskId, supported, location])

  function changeLocation(nextLocation: AgentHostCreationLocation): void {
    if (running.current?.mode === 'foreground' || disabled || nextLocation === location) return
    setLocation(nextLocation)
    setWorkers([])
    setWorkerId('')
    setWorkspaceId('')
    setHostId('')
    setCatalogueLoaded(false)
    setCatalogueError(undefined)
  }

  async function create(): Promise<void> {
    if (!canCreate || running.current?.mode === 'foreground' || savedOperations.current.some(pending) || !worker || !workspace || !host || !taskId) return
    const request: AgentHostCreateRequest = { operationId: crypto.randomUUID(), taskId, workerId: worker.id, workspaceId: workspace.id, hostId: host.hostId, expectedRevision: workspace.expectedRevision }
    let completed = false
    await run(async (scope) => {
      const operation: AgentHostCreation = { ...request, state: 'creating' }
      save(operation)
      try {
        const result = await bridge!.create(request)
        if (!scope.active) return
        if (!sameOperation(operation, result)) throw new Error('The response does not match the original creation operation.')
        save(result)
        if (result.state === 'ready') { completed = true; await openCreated(result, scope) }
      } catch (failure) {
        if (scope.active) save({ ...operation, state: 'uncertain', error: failureMessage(failure) })
      }
    })
    if (completed) await refresh()
  }

  async function retryBinding(operation: AgentHostCreation): Promise<void> {
    await run(async (scope) => {
      const result = await bridge!.bindCreation(operation.operationId)
      if (!scope.active) return
      if (!sameOperation(operation, result)) throw new Error('The assignment response does not match the original creation operation.')
      save(result)
      if (result.state === 'ready') await openCreated(result, scope)
    })
  }

  async function abandon(operation: AgentHostCreation): Promise<void> {
    await run(async (scope) => {
      const result = await bridge!.abandonCreation(operation.operationId)
      if (!scope.active) return
      if (!sameOperation(operation, result) || result.state !== 'abandoned') throw new Error('Abandonment was not confirmed for this creation operation. The record was not cleared.')
      save(result)
      setConfirmAbandon(undefined)
    })
  }

  async function reuseChoices(operation: AgentHostCreation): Promise<void> {
    if (disabled || !historyLoaded || historyError || savedOperations.current.some(pending) || operation.state !== 'failed') return
    await run(async (scope) => {
      setWorkerId('')
      setWorkspaceId('')
      setHostId('')
      const available = await loadCatalogue(scope)
      if (!scope.active || !available) return
      const source = available.find((item) => item.id === operation.workerId)
      if (!source) throw new Error('The original worker is not available in this execution location. Check the location and connection, or choose another worker explicitly. No replacement was selected.')
      setWorkerId(source.id)
      if (!source.workspaces.some((item) => item.id === operation.workspaceId)) throw new Error('The original workspace is no longer shared by this worker. Restore access or choose another workspace explicitly. No replacement was selected.')
      setWorkspaceId(operation.workspaceId)
      if (!source.hosts.some((item) => item.hostId === operation.hostId)) throw new Error('The original Agent Host is no longer listed. Start it or choose another Host explicitly. No replacement was selected.')
      setHostId(operation.hostId)
    })
  }

  return <section className="ah-creation" aria-label={heading} aria-busy={busy}>
    <h3><Icon name="server-environment" />{heading}</h3>
    <label className="form-field">Execution location<select aria-label="Execution location" value={location} disabled={!supported || busy || disabled || !taskId} onChange={(event) => { if (event.target.value === 'local' || event.target.value === 'remote') changeLocation(event.target.value) }}><option value="remote">Remote worker</option><option value="local">This computer</option></select></label>
    <p className="muted">{local ? 'Creates and assigns a native chat in this task\'s current workspace using Folder isolation (no worktree). Local Host access and the same authoritative workspace binding backend as Link are required. No networking or remote pairing is enabled. Native tool approvals remain on this computer.' : 'Read and send access includes creation in the same shared workspace. Creates in the selected workspace folder (no worktree). Native tool approvals remain on the worker.'} No prompt is sent. Other Host settings keep their native defaults. The native agent may initialize on the first explicit send. Choose a model when sending.</p>
    {!supported && <p role="status">{local ? 'Local' : 'Remote'} creation is unavailable in this version of the desktop Agent Host API.</p>}
    {!taskId ? <p role="status">Select a task in a real workspace to create and assign a chat.</p> : !taskReady && <p role="status">Wait for the selected task and its session links to finish loading before creating a chat.</p>}
    {supported && taskId && <>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void refresh(true) }}><Icon name="refresh" />Refresh workers and creation status</button>
      {(!catalogueLoaded || !historyLoaded) && !catalogueError && !historyError && <p className="muted" role="status">Loading workers and saved creation operations...</p>}
      {catalogueError && <p className="copilot-error" role="alert">Workers could not be loaded: {catalogueError}</p>}
      {historyError && <p className="copilot-error" role="alert">Saved creations could not be loaded. Creation is disabled to avoid duplicates. {historyError}</p>}
      {catalogueLoaded && !workers.length && (local ? <p role="status">Local task creation is unavailable: the desktop API did not provide a trusted local worker. Update the desktop and check local Host access.</p> : <p className="muted">No paired remote workers are available. Manage devices to connect a worker.</p>)}
    </>}
    <div className="ah-creation-pickers">
      {!local && <><label className="form-field">Remote worker<select aria-label="Remote worker" value={workerId} disabled={!supported || busy || disabled || !taskId} onChange={(event) => { setWorkerId(event.target.value); setWorkspaceId(''); setHostId('') }}><option value="">Choose a worker</option>{workers.map((item) => <option key={item.id} value={item.id}>{item.owner.machineName} — {item.state} ({item.id})</option>)}</select></label>
      <label className="form-field">Shared worker workspace<select aria-label="Shared worker workspace" value={workspaceId} disabled={!worker || busy || disabled} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">Choose a workspace</option>{worker?.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.canSend ? 'Read and send' : 'Read only'} / task {item.taskState} ({item.id})</option>)}</select></label></>}
      {local && workspace && <p>Current workspace: <strong>{workspace.name}</strong> · <code>{workspace.id}</code></p>}
      <label className="form-field">Exact Agent Host<select aria-label="Exact Agent Host" value={hostId} disabled={!worker || busy || disabled} onChange={(event) => setHostId(event.target.value)}><option value="">Choose a Host</option>{worker?.hosts.map((item) => <option key={item.hostId} value={item.hostId}>{item.name} — {item.available ? 'available' : 'unavailable'} ({item.hostId})</option>)}</select></label>
    </div>
    {worker && <div className="ah-creation-selection">
      <p>Machine: <strong>{worker.owner.machineName}</strong> · Worker: <code>{worker.id}</code> · Owner: <code>{worker.owner.clientId}</code></p>
      {worker.state !== 'connected' && <p role="status">{local ? 'Local task creation is unavailable. Resolve the local Host or workspace error before creating.' : worker.state === 'blocked' ? 'This worker is connected, but its creation records must be repaired before creating.' : worker.state === 'offline' ? 'This worker is offline. Reconnect it in Manage devices, then check the saved operation.' : 'This worker does not support remote chat creation. Update the worker before creating.'}</p>}
      {worker.error && <p className="copilot-error" role="alert">{worker.error}</p>}
      {local && worker.workspaces.length !== 1 && <p role="status">Local task creation requires exactly one verified current workspace. No workspace can be selected manually.</p>}
      {!local && worker.state !== 'blocked' && !worker.workspaces.length && <p role="status">This worker exposes no shared workspaces.</p>}
      {worker.state !== 'blocked' && !worker.hosts.length && <p role="status">This worker exposes no Agent Hosts.</p>}
      {workspace && !workspace.canSend && <p role="status">{local ? 'Local Host read and send access is required to create.' : 'This shared workspace is read only. Read and send access is required to create.'}</p>}
      {workspace && workspace.taskState !== 'available' && workspace.taskState !== 'bound' && <p role="status">{workspace.taskState === 'missing' ? 'This task is missing from the worker workspace.' : 'The task state on this worker could not be verified.'}</p>}
      {workspace?.error && <p className="copilot-error" role="alert">{workspace.error}</p>}
      {host && !host.available && <p role="status">The selected Agent Host is unavailable.</p>}
      {host?.error && <p className="copilot-error" role="alert">{host.error}</p>}
    </div>}
    {catalogueLoaded && historyLoaded && !catalogueError && !historyError && !busy && !unresolved && workers.length > 0 && missingChoice && <p className="muted" role="status">{missingChoice}</p>}
    <button type="button" className="primary-button" disabled={!canCreate} onClick={() => { void create() }}>Create and assign{taskId ? ` to ${taskId}` : ''}</button>
    {unresolved && <p className="muted" role="status">Resolve the saved creation below before starting another. Status checks never create a second chat.</p>}
    {error && <p className="copilot-error" role="alert">{error}</p>}
    <div className="ah-creation-operations" aria-live="polite">
      {[...operations].sort((left, right) => Number(pending(right)) - Number(pending(left))).map((operation) => {
        const source = workers.find((item) => item.id === operation.workerId)
        const owner = operation.session?.owner ?? source?.owner
        return <section className="ah-creation-operation" key={operation.operationId} aria-label={`Creation ${operation.operationId}`}>
          <h4>{stateLabels[operation.state]} · {operation.taskId}</h4>
          <dl><div><dt>Machine</dt><dd>{owner?.machineName ?? 'Machine unavailable'}{owner && <> · <code>{owner.clientId}</code></>}</dd></div><div><dt>Worker</dt><dd>{operation.workerId}</dd></div><div><dt>Workspace</dt><dd>{operation.workspaceId}</dd></div><div><dt>Host</dt><dd>{operation.hostId}</dd></div><div><dt>Operation</dt><dd>{operation.operationId}</dd></div>{operation.session && <><div><dt>Session</dt><dd>{operation.session.sessionId}</dd></div><div><dt>Chat</dt><dd>{operation.session.chatId}</dd></div></>}</dl>
          {operation.state === 'uncertain' && <p>The worker may have created the chat. Check this same operation after reconnecting; do not create again.</p>}
          {operation.state === 'failed' && <p>This is a saved failed attempt, not a new creation request. Reuse its choices or select a target above, then click Create and assign to start a new operation. Reusing choices never creates a chat.</p>}
          {operation.state === 'created-unbound' && <p>The chat exists. Retry only its assignment; no new chat or prompt will be created.</p>}
          {operation.nativeLifecycle === 'creating' && operation.session && <p>The Host acknowledged this chat. Its native agent initializes on the first explicit send; no warm-up prompt was sent.</p>}
          {operation.error && <p className="copilot-error" role="alert">{operation.error}</p>}
          <div className="ah-creation-actions">
            {operation.state === 'failed' && <button type="button" className="secondary-button" disabled={busy || disabled || !historyLoaded || Boolean(historyError) || unresolved} onClick={() => { void reuseChoices(operation) }}>Use these choices again</button>}
            {pending(operation) && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run((scope) => check(operation, scope)) }}>Check status</button>}
            {operation.state === 'created-unbound' && <button type="button" className="primary-button" disabled={busy || !taskReady} onClick={() => { void retryBinding(operation) }}>Retry binding</button>}
            {operation.state === 'ready' && onCreated && <button type="button" className="primary-button" disabled={busy} onClick={() => { void run((scope) => openCreated(operation, scope)) }}>Open created chat</button>}
            {typeof bridge?.abandonCreation === 'function' && <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => setConfirmAbandon(operation.operationId)}>Abandon and clear</button>}
          </div>
          {confirmAbandon === operation.operationId && <div role="group" aria-label="Confirm creation abandonment">
            <p>Clear this creation record and allow a new creation? Any existing chat and task links will be kept. This does not cancel native creation or delete a chat. An uncertain operation may already have created one; starting another can create a duplicate. Private audit records are retained to prevent replay.</p>
            <div className="ah-creation-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmAbandon(undefined)}>Keep record</button>
              <button type="button" className="primary-button" disabled={busy || disabled} onClick={() => { void abandon(operation) }}>Confirm abandonment</button>
            </div>
          </div>}
        </section>
      })}
    </div>
  </section>
}
