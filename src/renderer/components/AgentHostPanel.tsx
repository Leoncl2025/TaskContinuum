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

function Response({ part, terminals, owner }: { part: ResponsePart; terminals: Record<string, TerminalState>; owner: string }) {
  if (part.kind === 'markdown') return <ChatMarkdown source={part.content} />
  if (part.kind === 'reasoning') return <details className="ahp-tool"><summary><Icon name="lightbulb" />Reasoning</summary><ChatMarkdown source={part.content} /></details>
  if (part.kind === 'error') return <p className="message-notice error" role="alert">{part.error.message}</p>
  if (part.kind === 'inputRequest') return <div className="ahp-tool"><strong>{part.response ? 'Input completed' : `Input required on ${owner}`}</strong>{typeof part.request.message === 'string' && <p>{part.request.message}</p>}</div>
  if (part.kind === 'systemNotification') return <p className="message-notice">{typeof part.content === 'string' ? part.content : part.content.markdown}</p>
  if (part.kind !== 'toolCall') return <p className="message-notice">Referenced output</p>
  const tool = part.toolCall
  const content = 'content' in tool ? tool.content ?? [] : []
  const pending = tool.status === 'pending-confirmation' || tool.status === 'pending-result-confirmation' || tool.status === 'auth-required'
  return <details className="ahp-tool" open={tool.status === 'running' || pending}>
    <summary><Icon name={tool.status === 'completed' ? 'check' : pending ? 'shield' : 'tools'} /><strong>{tool.displayName || tool.toolName}</strong><span>{tool.status.replaceAll('-', ' ')}</span></summary>
    {pending && <p className="message-notice">Awaiting confirmation on {owner}</p>}
    {content.map((item, index) => item.type === 'terminal' ? <pre key={index} className="ahp-terminal" aria-label={item.title || 'Terminal output'}>{terminalText(terminals[item.resource]) || stripAnsi(item.result?.preview ?? '') || 'Waiting for terminal output...'}</pre> : item.type === 'text' ? <ChatMarkdown key={index} source={item.text} /> : <p key={index} className="message-notice">{item.type}</p>)}
    {'error' in tool && tool.error && <p className="message-notice error">{tool.error.message}</p>}
  </details>
}

function imagesFor(turn: Turn | ActiveTurn): ChatImageAttachment[] {
  return (turn.message.attachments ?? []).flatMap((attachment, index) => attachment.type === 'embeddedResource' && CHAT_IMAGE_TYPES.includes(attachment.contentType as ChatImageAttachment['mimeType'])
    ? [{ id: String(attachment._meta?.taskcontinuumImageId ?? `${turn.id}:${index}`), name: attachment.label, mimeType: attachment.contentType as ChatImageAttachment['mimeType'], data: attachment.data }] : [])
}

type AgentHostPanelProps = {
  target: AgentHostTarget
  connectionRevision?: number
  onClose(): void
  onDevices?(): void
  onSessions?(): void
  onBusy?(busy: boolean): void
  beforeReconnect?(): Promise<void>
  prepareFirstMessage?(text: string): Promise<string>
} & ({ task: TaskRecord; workspace?: never; onDetach(): void } | { task?: never; workspace: Pick<WorkspaceSnapshot, 'id' | 'name'>; onDetach?: never })

export function AgentHostPanel({ task, workspace, target, connectionRevision = 0, onDetach, onClose, onDevices, onSessions, onBusy, beforeReconnect, prepareFirstMessage }: AgentHostPanelProps) {
  const bridge = window.agentHost
  const { sessionId, chatId } = target
  const { clientId, machineName } = target.owner
  const key = agentHostKey(target)
  const contextId = task ? task.id : workspace.id
  const contextLabel = task ? task.id : workspace.name
  const [view, setView] = useState<AgentHostView>()
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const catalogKey = `${key}:${revision}:${connectionRevision}`
  const [catalog, setCatalog] = useState<{ key: string; models: Awaited<ReturnType<AgentHostBridge['models']>>; error?: string }>()
  const [selection, setSelection] = useState<{ key: string; provider: string; id: string; config?: ModelConfig; preferenceError?: string }>()
  const currentCatalog = catalog?.key === catalogKey ? catalog : undefined
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
    void bridge.watch(selected).then((id) => { if (active) { watchId = id; setError(undefined) } else void bridge.unwatch(id).catch(() => undefined) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Agent Host access is unavailable.') })
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
      if (mounted.current) { confirm(command); following.current = true }
    } catch (failure) { if (mounted.current && attempted.current?.id === command.id) setError(failure instanceof Error ? failure.message : 'Delivery was not confirmed. Inspect the original before retrying.') }
    finally { operating.current = false; if (mounted.current) setBusy(false) }
  }
  async function cancel(): Promise<void> {
    if (!bridge || !activeTurn || view?.readOnly || operating.current) return
    operating.current = true
    setBusy(true)
    try { await bridge.cancel(target, activeTurn.id) } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The original turn could not be cancelled.') }
    finally { operating.current = false; if (mounted.current) setBusy(false) }
  }
  async function reconnect(): Promise<void> {
    if (operating.current) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    try {
      await beforeReconnect?.()
      if (mounted.current) setRevision((value) => value + 1)
    } catch (failure) {
      if (mounted.current) setCatalog({ key: catalogKey, models: [], error: failure instanceof Error ? failure.message : 'The original session could not be verified. Reconnect to retry.' })
    } finally { operating.current = false; if (mounted.current) setBusy(false) }
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
        return <div key={turn.id} data-turn-id={turn.id}><article className="message message-user"><header><Icon name="account" /><strong>{typeof actor?.username === 'string' ? actor.username : 'User'}</strong>{typeof actor?.machineName === 'string' && <span className="message-model">{actor.machineName}</span>}</header>{turn.message.model && <><p className="message-notice">Requested model: {turn.message.model.id}</p>{Object.keys(turn.message.model.config ?? {}).length > 0 && <p className="message-notice">Requested config: {JSON.stringify(turn.message.model.config)}</p>}</>}<div className="message-text">{turn.message.text}</div><ChatImages images={imagesFor(turn)} /></article><article className="message message-assistant"><header><Icon name="copilot" /><strong>Copilot @ {machineName}</strong></header>{turn.responseParts.map((part, index) => <Response key={index} part={part} terminals={view?.terminals ?? {}} owner={machineName} />)}{activeTurn?.id === turn.id && <p className="message-notice" role="status">Responding...</p>}</article></div>
      })}
    </div>
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <ChatImageStatus input={imageInput} />
      {(error || view?.error) && <p className="copilot-error vscode-chat-notice" role="alert">{error ?? view?.error}</p>}
      {view?.pendingTurn?.state === 'uncertain' && <p className="vscode-chat-notice" role="status">Delivery outcome unknown. Check the original chat before another send.</p>}
      {view?.chat?.draft?.text && <p className="vscode-chat-notice muted">The owner has an unsent draft.</p>}
      {currentCatalog?.error && <p className="copilot-error vscode-chat-notice" role="alert">{currentCatalog.error}</p>}
      {onSessions && !view && (error || currentCatalog?.error) && <button type="button" className="text-button" disabled={busy} onClick={onSessions}><Icon name="link" />Review session link</button>}
      {modelStatus && <p className="message-notice" role="status">{modelStatus}</p>}
      {preferenceError && <p className="copilot-error message-notice" role="alert">{preferenceError}</p>}
      {configErrors.map((message) => <p key={message} className="copilot-error message-notice" role="alert">{message}</p>)}
      <div className="composer">
        <ChatImages images={images} onRemove={imageInput.remove} disabled={busy} />
        <textarea id="chat-composer" aria-label="Message Agent Host" placeholder="Message original Agent" rows={3} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={imageInput.paste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
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