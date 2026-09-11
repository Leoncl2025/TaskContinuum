import { useEffect, useEffectEvent, useRef, useState } from 'react'
import stripAnsi from 'strip-ansi'
import type { ResponsePart, TerminalState, Turn, ActiveTurn } from '@microsoft/agent-host-protocol'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostTarget, AgentHostView } from '../../shared/agentHost'
import type { TaskRecord } from '../../shared/tasks'
import { CHAT_IMAGE_TYPES } from '../../shared/chatAttachments'
import type { ChatImageAttachment } from '../../shared/chatAttachments'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatImagePicker, ChatImages, ChatImageStatus } from './ChatImages'
import { useChatImageInput } from '../chat/useChatImageInput'
import { Icon, IconButton } from './Primitives'

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

export function AgentHostPanel({ task, target, onDetach, onClose, onDevices, onBusy }: { task: TaskRecord; target: AgentHostTarget; onDetach(): void; onClose(): void; onDevices?(): void; onBusy?(busy: boolean): void }) {
  const bridge = window.agentHost
  const { hostId, sessionId, chatId } = target
  const { clientId, machineName } = target.owner
  const key = agentHostKey(target)
  const [view, setView] = useState<AgentHostView>()
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const operating = useRef(false)
  const mounted = useRef(false)
  const following = useRef(true)
  const log = useRef<HTMLDivElement>(null)
  const attempted = useRef<{ id: string; text: string; images: ChatImageAttachment[] } | undefined>(undefined)
  const imageInput = useChatImageInput(`${task.id}:${key}`, images, setImages, busy)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let active = true
    let watchId: string | undefined
    const selected = { hostId, sessionId, chatId, owner: { clientId, machineName } }
    if (!bridge) return
    const unlisten = bridge.onView((event) => {
      if (active && (!watchId || event.id === watchId) && agentHostKey(event.view.target) === agentHostKey(selected)) setView(event.view)
    })
    void bridge.watch(selected).then((id) => { if (active) watchId = id; else void bridge.unwatch(id).catch(() => undefined) }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Agent Host access is unavailable.') })
    return () => { active = false; unlisten(); if (watchId) void bridge.unwatch(watchId).catch(() => undefined) }
  }, [bridge, hostId, sessionId, chatId, clientId, machineName, revision])
  const activeTurn = view?.chat?.activeTurn
  const responding = Boolean(activeTurn)
  const pending = Boolean(view?.pendingTurn)
  useEffect(() => { onBusy?.(busy || pending || responding); return () => onBusy?.(false) }, [busy, pending, responding, onBusy])
  useEffect(() => { if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight }, [view])
  function confirm(command: { id: string; text: string; images: ChatImageAttachment[] }): void {
    if (attempted.current?.id !== command.id) return
    setDraft((current) => current.trim() === command.text ? '' : current)
    setImages((current) => current.filter((image) => !command.images.some((sent) => sent.id === image.id)))
    attempted.current = undefined
    setError(undefined)
  }
  const confirmed = useEffectEvent(() => { if (attempted.current) confirm(attempted.current) })
  useEffect(() => {
    const command = attempted.current
    if (command && (view?.chat?.activeTurn?.id === command.id || view?.chat?.turns.some((turn) => turn.id === command.id))) confirmed()
  }, [view])
  const canSend = Boolean(bridge && !busy && !pending && !activeTurn && !view?.readOnly && (view?.canSend || view?.state === 'offline'))
  async function send(): Promise<void> {
    if (!canSend || !bridge || operating.current || imageInput.isReading() || !draft.trim() && !images.length) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    const command = { id: crypto.randomUUID(), text: draft.trim(), images }
    attempted.current = command
    try {
      await bridge.send(target, command.id, command.text, command.images.length ? command.images : undefined)
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
  const turns = [...view?.chat?.turns ?? [], ...activeTurn ? [activeTurn] : []]
  const stateLabel = !bridge ? 'Desktop update required' : !view || view.state === 'connecting' ? 'Connecting...' : view.state === 'offline' ? 'Offline history' : pending ? 'Delivery pending' : activeTurn ? 'Agent responding' : view.readOnly ? 'Read only' : 'Connected'
  return <aside className="chat-panel ahp-panel" aria-label="Agent Host task chat">
    <header className="panel-header"><span>AGENT HOST</span><div className="header-actions">{onDevices && <IconButton icon="remote" label="Manage devices" onClick={onDevices} />}<IconButton icon="refresh" label="Reconnect Agent Host" disabled={busy} onClick={() => { setError(undefined); setRevision((value) => value + 1) }} /><IconButton icon="debug-disconnect" label="Detach conversation" disabled={busy || pending} onClick={onDetach} /><IconButton icon="layout-sidebar-right-off" label="Hide chat panel" onClick={onClose} /></div></header>
    <div className="chat-context"><Icon name="copilot" /><div><strong>{view?.chat?.title || 'Original Host chat'}</strong><span title={sessionId}>{sessionId}</span></div><span className="context-badge">{task.id}</span></div>
    <div className="session-toolbar"><span role="status">{stateLabel}</span><span className="muted">AHP 0.9.0</span></div>
    <div className="vscode-execution-identity"><Icon name="server" /><span>Copilot @ {machineName}</span></div>
    {(error || view?.error) && <p className="copilot-error vscode-chat-notice" role="alert">{error ?? view?.error}</p>}
    {view?.pendingTurn?.state === 'uncertain' && <p className="vscode-chat-notice" role="status">Delivery outcome unknown. Check the original chat before another send.</p>}
    <div className="chat-log" ref={log} role="log" aria-label={`Agent Host conversation for ${task.id}`} aria-live="polite" onScroll={() => { if (log.current) following.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 60 }}>
      {!turns.length && <p className="muted">{view?.state === 'connected' ? 'No messages.' : 'Waiting for original history...'}</p>}
      {turns.map((turn) => {
        const actor = turn.message._meta?.taskcontinuumActor as { username?: string; machineName?: string } | undefined
        return <div key={turn.id} data-turn-id={turn.id}><article className="message message-user"><header><Icon name="account" /><strong>{typeof actor?.username === 'string' ? actor.username : 'User'}</strong>{typeof actor?.machineName === 'string' && <span className="message-model">{actor.machineName}</span>}</header><div className="message-text">{turn.message.text}</div><ChatImages images={imagesFor(turn)} /></article><article className="message message-assistant"><header><Icon name="copilot" /><strong>Copilot @ {machineName}</strong></header>{turn.responseParts.map((part, index) => <Response key={index} part={part} terminals={view?.terminals ?? {}} owner={machineName} />)}{activeTurn?.id === turn.id && <p className="message-notice" role="status">Responding...</p>}</article></div>
      })}
    </div>
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}><ChatImageStatus input={imageInput} />{view?.chat?.draft?.text && <p className="vscode-chat-notice muted">The owner has an unsent draft.</p>}<div className="composer"><ChatImages images={images} onRemove={imageInput.remove} disabled={busy} /><textarea id="chat-composer" aria-label="Message Agent Host" placeholder="Message original Agent" rows={3} maxLength={4000} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={imageInput.paste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="composer-toolbar"><ChatImagePicker onFiles={imageInput.add} disabled={busy || imageInput.reading} /><span className="vscode-composer-identity"><Icon name="link" />Original chat</span>{activeTurn ? <IconButton icon="debug-stop" label="Stop Agent Host response" disabled={busy || view?.readOnly || view?.state !== 'connected'} onClick={() => { void cancel() }} /> : <button className="send-button" type="submit" aria-label="Send to Agent Host" title="Send to Agent Host" disabled={!canSend || imageInput.reading || !draft.trim() && !images.length}><Icon name="arrow-up" /></button>}</div></div></form>
  </aside>
}