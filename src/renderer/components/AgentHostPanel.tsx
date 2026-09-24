import { useEffect, useEffectEvent, useRef, useState } from 'react'
import stripAnsi from 'strip-ansi'
import type { ResponsePart, TerminalState, Turn, ActiveTurn } from '@microsoft/agent-host-protocol'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostBridge, AgentHostTarget, AgentHostView } from '../../shared/agentHost'
import type { TaskRecord } from '../../shared/tasks'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { CHAT_IMAGE_TYPES } from '../../shared/chatAttachments'
import type { ChatImageAttachment } from '../../shared/chatAttachments'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatImagePicker, ChatImages, ChatImageStatus } from './ChatImages'
import { useChatImageInput } from '../chat/useChatImageInput'
import { readModelPreference, saveModelPreference } from '../chat/modelPreferences'
import { Icon, IconButton } from './Primitives'
import { AgentHostModelOptions } from './AgentHostModelConfig'
import { modelConfigErrors } from '../../shared/agentHostModelConfig'
import type { ModelConfig } from '../../shared/agentHostModelConfig'

function terminalText(state: TerminalState | undefined): string {
  return state ? stripAnsi(state.content.map((part) => part.type === 'command' ? part.output : part.value).join('')) : ''
}

type TerminalStatus = NonNullable<AgentHostView['terminalStatus']>

function ToolResponse({ part, terminals, terminalStatus, owner, bridge, watchId }: {
  part: Extract<ResponsePart, { kind: 'toolCall' }>
  terminals: Record<string, TerminalState>
  terminalStatus: TerminalStatus
  owner: string
  bridge: AgentHostBridge | undefined
  watchId: string | undefined
}) {
  const tool = part.toolCall
  const content = 'content' in tool ? tool.content ?? [] : []
  const pending = tool.status === 'pending-confirmation' || tool.status === 'pending-result-confirmation' || tool.status === 'auth-required'
  const [openChoice, setOpenChoice] = useState<boolean>()
  const expanded = openChoice ?? (tool.status === 'running' || pending)
  const [requests, setRequests] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; error?: string }>>({})
  const [leaseId] = useState(() => crypto.randomUUID())
  const resources = [...new Set(content.flatMap((item) => item.type === 'terminal' ? [item.resource] : []))]
  const resourcesKey = JSON.stringify(resources)

  useEffect(() => {
    if (!expanded || !bridge || !watchId) return
    const resources = JSON.parse(resourcesKey) as string[]
    let cancelled = false
    for (const resource of resources) {
      void bridge.terminal(watchId, resource, leaseId).then(() => {
        if (!cancelled) setRequests((current) => ({ ...current, [resource]: { state: 'ready' } }))
      }).catch((failure: unknown) => {
        if (!cancelled) setRequests((current) => ({ ...current, [resource]: { state: 'error', error: failure instanceof Error ? failure.message : 'Terminal output is unavailable.' } }))
      })
    }
    return () => {
      cancelled = true
      for (const resource of resources) void bridge.releaseTerminal(watchId, resource, leaseId).catch(() => { console.error('Could not release Agent Host terminal output.') })
    }
  }, [bridge, watchId, expanded, resourcesKey, leaseId])

  const retry = (resource: string) => {
    if (!bridge || !watchId) return
    setRequests((current) => ({ ...current, [resource]: { state: 'loading' } }))
    void bridge.terminal(watchId, resource, leaseId, true).then(() => {
      setRequests((current) => ({ ...current, [resource]: { state: 'ready' } }))
    }).catch((failure: unknown) => {
      setRequests((current) => ({ ...current, [resource]: { state: 'error', error: failure instanceof Error ? failure.message : 'Terminal output is unavailable.' } }))
    })
  }

  return <details className="ahp-tool" open={expanded}>
    <summary onClick={(event) => {
      event.preventDefault()
      if (!expanded) setRequests((current) => Object.fromEntries(resources.map((resource) => [resource, current[resource]?.state === 'error' ? current[resource] : { state: 'loading' as const }])))
      setOpenChoice(!expanded)
    }}><Icon name={tool.status === 'completed' ? 'check' : pending ? 'shield' : 'tools'} /><strong>{tool.displayName || tool.toolName}</strong><span>{tool.status.replaceAll('-', ' ')}</span></summary>
    {pending && <p className="message-notice">Awaiting confirmation on {owner}</p>}
    {content.map((item, index) => {
      if (item.type === 'text') return <ChatMarkdown key={index} source={item.text} />
      if (item.type !== 'terminal') return <p key={index} className="message-notice">{item.type}</p>
      const state = terminals[item.resource]
      const status = terminalStatus[item.resource]
      const request = requests[item.resource]
      const preview = stripAnsi(item.result?.preview ?? '')
      const failure = status?.state === 'error' ? status.error : request?.state === 'error' ? request.error : undefined
      const loading = status?.state === 'loading' || request?.state === 'loading' && !state || !state && !failure && !request && expanded && Boolean(watchId)
      const needsRetry = !state && request?.state === 'ready' && !loading
      return <div key={`${item.resource}:${index}`} className="ahp-terminal-output">
        <pre className="ahp-terminal" aria-label={item.title || 'Terminal output'}>{terminalText(state) || preview || (state ? 'No terminal output yet.' : 'No terminal output loaded.')}</pre>
        {!state && preview && <p className="message-notice">Preview only - full terminal output has not loaded.</p>}
        {loading && <p className="message-notice" role="status">Loading terminal output...</p>}
        {failure && <p className="message-notice error" role="alert">{failure}</p>}
        {needsRetry && !failure && <p className="message-notice" role="status">Terminal output was not restored after reconnect.</p>}
        {(failure || needsRetry) && <button type="button" className="text-button" disabled={!watchId || loading} onClick={() => retry(item.resource)}>Retry terminal output</button>}
      </div>
    })}
    {'error' in tool && tool.error && <p className="message-notice error">{tool.error.message}</p>}
  </details>
}

function Response({ part, terminals, terminalStatus, owner, bridge, watchId }: {
  part: ResponsePart; terminals: Record<string, TerminalState>; terminalStatus: TerminalStatus
  owner: string; bridge: AgentHostBridge | undefined; watchId: string | undefined
}) {
  if (part.kind === 'markdown') return <ChatMarkdown source={part.content} />
  if (part.kind === 'reasoning') return <details className="ahp-tool"><summary><Icon name="lightbulb" />Reasoning</summary><ChatMarkdown source={part.content} /></details>
  if (part.kind === 'error') return <p className="message-notice error" role="alert">{part.error.message}</p>
  if (part.kind === 'inputRequest') return <div className="ahp-tool"><strong>{part.response ? 'Input completed' : `Input required on ${owner}`}</strong>{typeof part.request.message === 'string' && <p>{part.request.message}</p>}</div>
  if (part.kind === 'systemNotification') return <p className="message-notice">{typeof part.content === 'string' ? part.content : part.content.markdown}</p>
  if (part.kind !== 'toolCall') return <p className="message-notice">Referenced output</p>
  return <ToolResponse part={part} terminals={terminals} terminalStatus={terminalStatus} owner={owner} bridge={bridge} watchId={watchId} />
}

function imagesFor(turn: Turn | ActiveTurn): ChatImageAttachment[] {
  return (turn.message.attachments ?? []).flatMap((attachment, index) => attachment.type === 'embeddedResource' && CHAT_IMAGE_TYPES.includes(attachment.contentType as ChatImageAttachment['mimeType'])
    ? [{ id: String(attachment._meta?.taskcontinuumImageId ?? `${turn.id}:${index}`), name: attachment.label, mimeType: attachment.contentType as ChatImageAttachment['mimeType'], data: attachment.data }] : [])
}

type AgentHostPanelProps = {
  target: AgentHostTarget
  connectionRevision?: number
  active?: boolean
  onClose(): void
  onDevices?(): void
  onSessions?(): void
  onBusy?(busy: boolean): void
  beforeReconnect?(): Promise<void>
  prepareFirstMessage?(text: string): Promise<string>
} & ({ task: TaskRecord; workspace?: never; onDetach(): void } | { task?: never; workspace: Pick<WorkspaceSnapshot, 'id' | 'name'>; onDetach?: never })

export function AgentHostPanel({ task, workspace, target, connectionRevision = 0, active = true, onDetach, onClose, onDevices, onSessions, onBusy, beforeReconnect, prepareFirstMessage }: AgentHostPanelProps) {
  const bridge = window.agentHost
  const { sessionId, chatId } = target
  const { clientId, machineName } = target.owner
  const key = agentHostKey(target)
  const contextId = task ? task.id : workspace.id
  const contextLabel = task ? task.id : workspace.name
  const [view, setView] = useState<AgentHostView>()
  const [watch, setWatch] = useState<{ key: string; id: string }>()
  const [error, setError] = useState<string>()
  const [deliveryReview, setDeliveryReview] = useState<{ id: string; status: 'checking' | 'not-found' | 'abandoning' | 'failed'; acknowledged: boolean; error?: string }>()
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const catalogKey = `${key}:${revision}:${connectionRevision}`
  const [catalog, setCatalog] = useState<{ key: string; models: Awaited<ReturnType<AgentHostBridge['models']>>; error?: string }>()
  const [selection, setSelection] = useState<{ key: string; provider: string; id: string; config?: ModelConfig; preferenceError?: string }>()
  const currentCatalog = catalog?.key === catalogKey ? catalog : undefined
  const watchId = watch?.key === catalogKey ? watch.id : undefined
  const models = currentCatalog?.models ?? []
  const modelId = selection?.key === key ? selection.id : ''
  const selectedModel = models.find((model) => model.id === modelId && model.provider === selection?.provider)
  const modelReady = Boolean(selectedModel)
  const config = selection?.key === key ? selection.config ?? {} : {}
  const configErrors = selectedModel ? modelConfigErrors(selectedModel.configSchema, config) : []
  const preferenceError = selection?.key === key ? selection.preferenceError : undefined
  const operating = useRef(false)
  const mounted = useRef(false)
  const following = useRef(true)
  const log = useRef<HTMLDivElement>(null)
  const attempted = useRef<{ id: string; text: string; draft: string; images: ChatImageAttachment[] } | undefined>(undefined)
  const firstMessageSent = useRef(false)
  const imageInput = useChatImageInput(`${contextId}:${key}`, images, setImages, busy)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let active = true
    let watchId: string | undefined
    let connected = false
    let connectionGeneration = 0
    let loadingModels = false
    let loadedModels = false
    const selected = { sessionId, chatId, owner: { clientId, machineName } }
    if (!bridge) return
    const loadModels = () => {
      if (!active || loadingModels) return
      loadingModels = true
      const generation = connectionGeneration
      let failed = false
      void bridge.models(selected).then((models) => {
        loadedModels = true
        if (active) {
          setCatalog({ key: catalogKey, models, ...(!models.length ? { error: 'No available models. Check model access on the owner device, then reconnect.' } : {}) })
          const provider = models[0]?.provider
          if (provider) {
            const saved = readModelPreference(clientId, provider)
            setSelection((current) => current?.key === key && current.provider === provider ? current : {
              key, provider, id: saved.model?.id ?? '', config: saved.model?.config, preferenceError: saved.error,
            })
          }
        }
      }).catch((failure: unknown) => {
        failed = true
        loadedModels = false
        if (active) setCatalog({ key: catalogKey, models: [], error: failure instanceof Error ? failure.message : 'The owner model catalog is unavailable. Reconnect to retry.' })
      }).finally(() => {
        loadingModels = false
        if (connected && connectionGeneration !== generation && (failed || generation > 0)) loadModels()
      })
    }
    const unlisten = bridge.onView((event) => {
      if (active && (!watchId || event.id === watchId) && agentHostKey(event.view.target) === agentHostKey(selected)) {
        const recovered = event.view.state === 'connected' && !connected
        connected = event.view.state === 'connected'
        setView(event.view)
        if (recovered) {
          connectionGeneration++
          if (!loadedModels || connectionGeneration > 1) loadModels()
        }
      }
    })
    loadModels()
    void bridge.watch(selected).then((id) => { if (active) { watchId = id; setWatch({ key: catalogKey, id }); setError(undefined) } else void bridge.unwatch(id).catch(() => undefined) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Agent Host access is unavailable.') })
    return () => { active = false; unlisten(); if (watchId) void bridge.unwatch(watchId).catch(() => undefined) }
  }, [bridge, sessionId, chatId, clientId, machineName, catalogKey, key])
  const activeTurn = view?.chat?.activeTurn
  const responding = Boolean(activeTurn)
  const pending = Boolean(view?.pendingTurn)
  useEffect(() => { onBusy?.(busy || pending || responding); return () => onBusy?.(false) }, [busy, pending, responding, onBusy])
  useEffect(() => { if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight }, [view])
  function confirm(command: { id: string; text: string; draft: string; images: ChatImageAttachment[] }): void {
    if (attempted.current?.id !== command.id) return
    firstMessageSent.current = true
    setDraft((current) => current.trim() === command.draft ? '' : current)
    setImages((current) => current.filter((image) => !command.images.some((sent) => sent.id === image.id)))
    attempted.current = undefined
    setError(undefined)
  }
  const confirmed = useEffectEvent(() => { if (attempted.current) confirm(attempted.current) })
  useEffect(() => {
    const command = attempted.current
    if (command && (view?.chat?.activeTurn?.id === command.id || view?.chat?.turns.some((turn) => turn.id === command.id))) confirmed()
  }, [view])
  const canSend = Boolean(bridge && modelReady && !configErrors.length && !busy && !pending && !activeTurn && !view?.readOnly && (view?.canSend || view?.state === 'offline'))
  function chooseModel(id: string, config?: ModelConfig): void {
    const provider = models[0]?.provider
    if (!provider) {
      setError('Reload the model catalog before changing the model selection.')
      return
    }
    const preferenceError = saveModelPreference(clientId, provider, id ? { id, ...(config ? { config } : {}) } : undefined)
    setSelection({ key, provider, id, config, preferenceError })
  }
  async function send(): Promise<void> {
    if (!canSend || !bridge || operating.current || imageInput.isReading() || !draft.trim() && !images.length) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    const command = { id: crypto.randomUUID(), text: draft.trim(), draft: draft.trim(), images }
    attempted.current = command
    try {
      if (prepareFirstMessage && !firstMessageSent.current && !view?.chat?.turns.length) command.text = await prepareFirstMessage(command.draft)
      if (!mounted.current) return
      await bridge.send(target, command.id, command.text, command.images.length ? command.images : undefined, { id: modelId, ...(Object.keys(config).length ? { config } : {}) })
      confirm(command)
      following.current = true
    } catch (failure) { if (attempted.current?.id === command.id) setError(failure instanceof Error ? failure.message : 'Delivery was not confirmed. Inspect the original before retrying.') }
    // Hidden Activities retain state even while their effects are paused.
    finally { operating.current = false; setBusy(false) }
  }
  async function cancel(): Promise<void> {
    if (!bridge || !activeTurn || view?.readOnly || operating.current) return
    operating.current = true
    setBusy(true)
    try { await bridge.cancel(target, activeTurn.id) } catch (failure) { setError(failure instanceof Error ? failure.message : 'The original turn could not be cancelled.') }
    finally { operating.current = false; setBusy(false) }
  }
  async function reviewDelivery(action: 'check' | 'abandon'): Promise<void> {
    const id = view?.pendingTurn?.id
    if (!bridge || !id || view?.state !== 'connected' || operating.current
      || action === 'abandon' && (deliveryReview?.id !== id || deliveryReview.status !== 'not-found' || !deliveryReview.acknowledged)) return
    operating.current = true
    setBusy(true)
    setDeliveryReview({ id, status: action === 'check' ? 'checking' : 'abandoning', acknowledged: action === 'abandon' })
    try {
      const result = await bridge.resolveDelivery(target, id, action, action === 'abandon' ? true : undefined)
      if (!mounted.current) return
      if (result === 'not-found') setDeliveryReview({ id, status: 'not-found', acknowledged: false })
      else {
        if (result === 'abandoned' && attempted.current?.id === id) attempted.current = undefined
        setDeliveryReview(undefined)
        setError(undefined)
      }
    } catch (failure) {
      if (mounted.current) setDeliveryReview({ id, status: 'failed', acknowledged: false,
        error: failure instanceof Error ? failure.message : 'The delivery check failed. The original attempt remains blocked.' })
    } finally { operating.current = false; setBusy(false) }
  }
  async function reconnect(): Promise<void> {
    if (operating.current) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    try {
      await beforeReconnect?.()
      setRevision((value) => value + 1)
    } catch (failure) {
      setCatalog({ key: catalogKey, models: [], error: failure instanceof Error ? failure.message : 'The original session could not be verified. Reconnect to retry.' })
    } finally { operating.current = false; setBusy(false) }
  }
  const turns = [...view?.chat?.turns ?? [], ...activeTurn ? [activeTurn] : []]
  const stateLabel = !bridge ? 'Desktop update required' : !view && (error || currentCatalog?.error) ? 'Connection failed' : !view || view.state === 'connecting' ? 'Connecting...' : view.state === 'offline' ? 'Offline history' : pending ? 'Delivery pending' : activeTurn ? 'Agent responding' : view.readOnly ? 'Read only' : 'Connected'
  const modelStatus = !bridge ? 'Desktop update required.' : !currentCatalog ? 'Loading models from the owner Host...' : currentCatalog.error ? undefined : !modelId ? 'Choose a model below to enable sending.' : !modelReady ? 'The selected model is unavailable. Choose another model or retry loading models.' : undefined
  return <aside className="chat-panel ahp-panel" aria-label={workspace ? 'Agent Host task creation chat' : 'Agent Host task chat'}>
    <header className="panel-header"><span>AGENT HOST</span><div className="header-actions">{onDevices && <IconButton icon="remote" label="Manage devices" onClick={onDevices} />}<IconButton icon="refresh" label="Reconnect Agent Host" disabled={busy} onClick={() => { void reconnect() }} />{onDetach && <IconButton icon="debug-disconnect" label="Detach conversation" disabled={busy || pending} onClick={onDetach} />}{!workspace && <IconButton icon="close" label="Hide chat panel" onClick={onClose} />}</div></header>
    <div className="chat-context"><Icon name="copilot" /><div><strong>{view?.chat?.title || 'Original Host chat'}</strong><span title={sessionId}>{sessionId}</span></div><span className="context-badge">{contextLabel}</span></div>
    <div className="session-toolbar"><span role="status">{stateLabel}</span><span className="muted">AHP 0.9.0</span></div>
    <div className="vscode-execution-identity"><Icon name="server" /><span>Copilot @ {machineName}</span></div>
    <div className="chat-log" ref={log} role="log" aria-label={`Agent Host conversation for ${contextLabel}`} aria-live="polite" onScroll={() => { if (log.current) following.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 60 }}>
      {!turns.length && <p className="muted">{view?.state === 'connected' ? 'No messages.' : 'Waiting for original history...'}</p>}
      {turns.map((turn) => {
        const actor = turn.message._meta?.taskcontinuumActor as { username?: string; machineName?: string } | undefined
        return <div key={turn.id} data-turn-id={turn.id}><article className="message message-user"><header><Icon name="account" /><strong>{typeof actor?.username === 'string' ? actor.username : 'User'}</strong>{typeof actor?.machineName === 'string' && <span className="message-model">{actor.machineName}</span>}</header>{turn.message.model && <><p className="message-notice">Requested model: {turn.message.model.id}</p>{Object.keys(turn.message.model.config ?? {}).length > 0 && <p className="message-notice">Requested config: {JSON.stringify(turn.message.model.config)}</p>}</>}<div className="message-text">{turn.message.text}</div><ChatImages images={imagesFor(turn)} /></article><article className="message message-assistant"><header><Icon name="copilot" /><strong>Copilot @ {machineName}</strong></header>{turn.responseParts.map((part, index) => <Response key={index} part={part} terminals={view?.terminals ?? {}} terminalStatus={view?.terminalStatus ?? {}} owner={machineName} bridge={bridge} watchId={watchId} />)}{activeTurn?.id === turn.id && <p className="message-notice" role="status">Responding...</p>}</article></div>
      })}
    </div>
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <ChatImageStatus input={imageInput} />
      {(error || view?.error) && <p className="copilot-error vscode-chat-notice" role="alert">{error ?? view?.error}</p>}
      {view?.pendingTurn?.state === 'uncertain' && <div className="vscode-chat-notice" role="group" aria-label="Resolve uncertain delivery">
        <p role="status">Delivery outcome unknown. The previous message was not replayed. Check the original chat on {machineName} before another send.</p>
        <button type="button" className="text-button" disabled={busy || view.state !== 'connected'} onClick={() => { void reviewDelivery('check') }}>Check original chat for this turn</button>
        {view.state !== 'connected' && <p>Reconnect Agent Host before checking delivery.</p>}
        {deliveryReview?.id === view.pendingTurn.id && deliveryReview.status === 'not-found' && <>
          <p>This turn is not in the current Host snapshot. It may still arrive later. Only continue after checking the original chat yourself.</p>
          <label><input type="checkbox" checked={deliveryReview.acknowledged} onChange={(event) => setDeliveryReview((current) => current && current.id === view.pendingTurn?.id ? { ...current, acknowledged: event.target.checked } : current)} /> I checked the original chat and accept the risk of a later duplicate.</label>
          <button type="button" className="text-button" disabled={busy || !deliveryReview.acknowledged} onClick={() => { void reviewDelivery('abandon') }}>Abandon this attempt and unlock sending</button>
        </>}
        {deliveryReview?.id === view.pendingTurn.id && deliveryReview.error && <p className="copilot-error" role="alert">{deliveryReview.error}</p>}
      </div>}
      {view?.chat?.draft?.text && <p className="vscode-chat-notice muted">The owner has an unsent draft.</p>}
      {currentCatalog?.error && <p className="copilot-error vscode-chat-notice" role="alert">{currentCatalog.error}</p>}
      {onSessions && !view && (error || currentCatalog?.error) && <button type="button" className="text-button" disabled={busy} onClick={onSessions}><Icon name="link" />Review session link</button>}
      {modelStatus && <p className="message-notice" role="status">{modelStatus}</p>}
      {preferenceError && <p className="copilot-error message-notice" role="alert">{preferenceError}</p>}
      {configErrors.map((message) => <p key={message} className="copilot-error message-notice" role="alert">{message}</p>)}
      <div className="composer">
        <ChatImages images={images} onRemove={imageInput.remove} disabled={busy} />
        <textarea id={active ? 'chat-composer' : undefined} aria-label="Message Agent Host" placeholder="Message original Agent" rows={3} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={imageInput.paste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="composer-toolbar">
          <ChatImagePicker onFiles={imageInput.add} disabled={busy || imageInput.reading} />
          <div className="ahp-model-controls">
            <label title={selectedModel?.name ?? 'Your model and options are remembered on this device for this Agent Host provider.'}><Icon name="copilot" /><select aria-label="Agent Host model" value={modelId} disabled={busy || pending || responding || view?.readOnly || !models.length} onChange={(event) => chooseModel(event.target.value)}><option value="">{!currentCatalog ? 'Loading models...' : !models.length ? 'Models unavailable' : 'Choose a model'}</option>{modelId && !modelReady && <option value={modelId} disabled>{modelId} (unavailable)</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
          </div>
          {selectedModel && <AgentHostModelOptions key={`${key}:${selectedModel.provider}:${modelId}`} schema={selectedModel.configSchema} config={config} disabled={busy || pending || responding || Boolean(view?.readOnly)} onChange={(config) => chooseModel(modelId, config)} />}
          <IconButton icon="refresh" label="Retry loading models" disabled={!bridge || busy || !currentCatalog} onClick={() => { void reconnect() }} />
          {activeTurn ? <IconButton icon="debug-stop" label="Stop Agent Host response" disabled={busy || view?.readOnly || view?.state !== 'connected'} onClick={() => { void cancel() }} /> : <button className="send-button" type="submit" aria-label="Send to Agent Host" title="Send to Agent Host" disabled={!canSend || imageInput.reading || !draft.trim() && !images.length}><Icon name="arrow-up" /></button>}
        </div>
      </div>
    </form>
  </aside>
}