import { useEffect, useId, useRef, useState } from 'react'
import type { TaskRecord } from '../../shared/tasks'
import type { VSCodeChatDelivery, VSCodeChatView } from '../../shared/vscodeChat'
import type { VSCodeChatTarget } from '../../shared/remoteVSCode'
import { Icon, IconButton } from './Primitives'

export function VSCodeChatPanel({ task, identity, onDetach, onClose, onRemoteAccess, onRemoteConnections }: { task: TaskRecord; identity: VSCodeChatTarget; onDetach(): void; onClose(): void; onRemoteAccess?(): void; onRemoteConnections?(): void }) {
  const bridge = window.vscodeChat
  const sendStatusId = useId()
  const [snapshot, setSnapshot] = useState<VSCodeChatView>()
  const [error, setError] = useState<string>()
  const [readError, setReadError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [receipt, setReceipt] = useState<VSCodeChatDelivery>()
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ id: string; text: string } | undefined>(undefined)
  const operating = useRef(false)
  const followBottom = useRef(true)
  const log = useRef<HTMLDivElement>(null)
  const { nativeSessionId, workspaceStorageId, remoteMachineName } = identity
  useEffect(() => {
    let active = true
    let request = 0
    const selected = { nativeSessionId, workspaceStorageId, ...(remoteMachineName ? { remoteMachineName } : {}) }
    async function read(): Promise<void> {
      const current = ++request
      try {
        if (!bridge) throw new Error('The VS Code desktop bridge is unavailable. Reopen the rebuilt desktop.')
        const value = await bridge.read(selected)
        if (active && current === request) { setSnapshot(value); setReadError(undefined) }
      } catch (failure) {
        if (active && current === request) setReadError(failure instanceof Error ? failure.message : 'The original conversation could not be read.')
      }
    }
    const unsubscribe = bridge?.onChange((changed) => {
      if (changed.nativeSessionId === nativeSessionId && changed.workspaceStorageId === workspaceStorageId && changed.remoteMachineName?.toLowerCase() === remoteMachineName?.toLowerCase()) void read()
    })
    void read()
    void bridge?.watch(selected).catch((failure: unknown) => { if (active) setReadError(failure instanceof Error ? failure.message : 'History updates are unavailable. Use Refresh.') })
    return () => { active = false; unsubscribe?.(); void bridge?.watch(null).catch(() => undefined) }
  }, [bridge, nativeSessionId, workspaceStorageId, remoteMachineName, revision])

  async function connect(): Promise<void> {
    if (!bridge?.connect || operating.current) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    try {
      await bridge.connect(identity)
      setRevision((current) => current + 1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The VS Code connection could not be started.')
    } finally { operating.current = false; setBusy(false) }
  }

  async function open(): Promise<void> {
    if (!bridge || operating.current) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    try { await bridge.open(identity); setRevision((current) => current + 1) } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The original VS Code conversation could not be opened.')
    } finally { operating.current = false; setBusy(false) }
  }

  const deliveries = [...snapshot?.deliveries ?? []]
  if (receipt && !deliveries.some((delivery) => delivery.id === receipt.id)) deliveries.push(receipt)
  const waiting = deliveries.some((delivery) => delivery.state === 'pending' || delivery.state === 'uncertain')
  const needsOpen = snapshot?.connectionState === 'connected' && snapshot.sessionOpen === false
  const canPrepare = snapshot?.connectionState === 'connected' && snapshot.canPrepareSend === true
  const canReconnect = snapshot?.connectionState === 'offline' && Boolean(bridge?.connect) && (!remoteMachineName || snapshot.canOpenRemote !== false)
  const canSend = Boolean(bridge?.send && (snapshot?.canSend && snapshot.sessionOpen !== false || canPrepare || canReconnect) && !snapshot?.responding && !waiting && !busy && !readError)
  const sendBlockedReason = canSend ? undefined : busy ? 'Preparing the original session...' : readError ?? snapshot?.bridgeError ?? (!snapshot ? 'Checking the original conversation.'
    : waiting ? deliveries.some((delivery) => delivery.state === 'uncertain') ? 'A previous delivery has an unknown outcome.' : 'Delivering to the original VS Code session.'
      : snapshot.responding ? 'The original Agent is still responding. Waiting for its saved idle state.'
        : !snapshot.canSend ? 'The original conversation is not ready for sending.' : undefined)
  const messages = snapshot?.messages ?? []
  const recordedRequests = new Set(messages.flatMap((message) => message.nativeRequestId ? [message.nativeRequestId] : []))
  const outstanding = deliveries.filter((delivery) => !delivery.nativeRequestId || !recordedRequests.has(delivery.nativeRequestId))
  const lastDelivery = deliveries.at(-1)
  const execution = snapshot?.execution ?? lastDelivery?.execution
  const participant = snapshot?.participant ?? lastDelivery?.participant
  const executionName = execution ? `${execution.agentName} @ ${execution.machineName}${snapshot?.execution ? '' : ' (last recorded)'}` : remoteMachineName ? `GitHub Copilot @ ${remoteMachineName} (not connected)` : 'GitHub Copilot @ unknown machine'
  useEffect(() => {
    if (followBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [snapshot, receipt])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!bridge?.send || !canSend || !text || operating.current) return
    operating.current = true
    const command = pending.current?.text === text ? pending.current : { id: crypto.randomUUID(), text }
    pending.current = command
    setBusy(true)
    setError(undefined)
    try {
      const result = await bridge.send(identity, command.id, command.text)
      setReceipt(result)
      pending.current = undefined
      setDraft((current) => current.trim() === text ? '' : current)
      followBottom.current = true
      setRevision((current) => current + 1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The message could not be submitted. Retry uses the same message ID.')
    } finally { operating.current = false; setBusy(false) }
  }

  return <aside className="chat-panel" aria-label="VS Code task chat">
    <header className="panel-header"><span>{remoteMachineName ? 'REMOTE VS CODE' : 'VS CODE CHAT'}</span><div className="header-actions">{onRemoteAccess && !remoteMachineName && <IconButton icon="broadcast" label="Share original conversation remotely" disabled={busy || snapshot?.connectionState !== 'connected'} onClick={onRemoteAccess} />}{onRemoteConnections && remoteMachineName && <IconButton icon="remote" label="Manage remote VS Code connection" disabled={busy} onClick={onRemoteConnections} />}<IconButton icon="refresh" label="Refresh original conversation" disabled={busy} onClick={() => setRevision((value) => value + 1)} /><IconButton icon="debug-disconnect" label="Detach conversation" disabled={busy} onClick={onDetach} /><IconButton icon="layout-sidebar-right-off" label="Hide chat panel" onClick={onClose} /></div></header>
    <div className="chat-context"><Icon name="vscode" /><div><strong>{snapshot?.session.title ?? 'GitHub Copilot in VS Code'}</strong><span title={nativeSessionId}>{nativeSessionId}</span></div><span className="context-badge">{task.id}</span></div>
    <div className="session-toolbar"><span className="session-connection-state">{busy ? 'Preparing session...' : snapshot?.connectionState === 'offline' || remoteMachineName && !snapshot ? 'Not connected' : snapshot?.connectionState === 'unsupported' ? 'Bridge update required' : snapshot?.responding ? 'Agent responding' : waiting ? 'Delivery pending' : needsOpen && !canPrepare ? 'Session not open' : 'Original session'}</span><div className="header-actions">{bridge?.connect && snapshot?.connectionState !== 'connected' && !snapshot?.canSend && <button type="button" className="text-button" disabled={busy || !snapshot && !remoteMachineName} onClick={() => { void connect() }}><Icon name="plug" />{remoteMachineName ? 'Connect SSH' : 'Connect VS Code'}</button>}{!remoteMachineName && <IconButton icon="link-external" label="Open in VS Code" disabled={busy || !bridge} onClick={() => { void open() }} />}</div></div>
    <div className="vscode-execution-identity"><Icon name="server" /><span>{executionName}</span>{remoteMachineName && <IconButton icon="link-external" label={`Open session on ${remoteMachineName}`} disabled={busy || waiting || snapshot?.connectionState !== 'connected' || snapshot?.canOpenRemote !== true} onClick={() => { void open() }} />}</div>
    {(error || readError) && <p className="copilot-error vscode-chat-notice" role="alert">{error ?? readError}</p>}
    {snapshot?.bridgeError && !readError && !bridge?.send && <p className="vscode-chat-notice muted" role="status">{snapshot.bridgeError}</p>}
    <div className="chat-log" ref={log} role="log" aria-label={`Original conversation for ${task.id}`} aria-live="polite" onScroll={() => { if (log.current) followBottom.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 60 }}>
      {!snapshot && !readError && <p className="muted">Loading saved history...</p>}
      {messages.map((message) => <article key={message.id} className={`message message-${message.role}`} data-request-id={message.nativeRequestId}><header><Icon name={message.role === 'user' ? 'account' : 'copilot'} /><strong>{message.author?.name ?? (message.role === 'user' ? 'Unknown user' : 'GitHub Copilot')}{message.role === 'assistant' ? ` @ ${message.author?.machineName ?? 'unknown machine'}` : ''}</strong>{message.role === 'user' && message.author?.machineName && <span className="message-model">{message.author.machineName}</span>}</header><div className="message-text">{message.text}</div>{message.status === 'streaming' && <p className="message-notice">Responding in VS Code</p>}{message.status === 'cancelled' && <p className="message-notice">Stopped in VS Code</p>}{message.status === 'error' && <p className="message-notice error">VS Code reported a response error</p>}</article>)}
      {outstanding.map((delivery) => <article key={delivery.id} className="message message-user" data-delivery-id={delivery.id}><header><Icon name="account" /><strong>{delivery.participant.username}</strong><span className="message-model">{delivery.participant.machineName}</span></header><div className="message-text">{delivery.text}</div><p className={`message-notice ${delivery.state === 'failed' ? 'error' : ''}`}>{delivery.state === 'pending' ? 'Delivering to the original VS Code session' : delivery.state === 'submitted' ? `Submitted to ${delivery.execution.agentName} @ ${delivery.execution.machineName}` : delivery.error ?? 'Delivery has not been confirmed'}</p></article>)}
    </div>
    {bridge?.send && <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}>
      {sendBlockedReason && <p id={sendStatusId} className="vscode-chat-notice muted" role="status">{sendBlockedReason}</p>}
      <div className="composer"><textarea aria-label="Message original VS Code Agent" aria-describedby={sendBlockedReason ? sendStatusId : undefined} placeholder="Message original Agent" value={draft} maxLength={4000} rows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="composer-toolbar"><span className="vscode-composer-identity"><Icon name="account" />{participant?.username ?? 'Unknown user'}{snapshot?.participant ? '' : ' (offline)'}</span><button type="submit" className="send-button" aria-label="Send to original VS Code session" aria-describedby={sendBlockedReason ? sendStatusId : undefined} title={sendBlockedReason ?? 'Send to original VS Code session'} disabled={!canSend || !draft.trim()}><Icon name="arrow-up" /></button></div></div>
    </form>}
    <div className="session-footer"><Icon name="vscode" /><span>Tool approvals remain in VS Code.{snapshot?.omittedMessages ? ` ${snapshot.omittedMessages} earlier messages omitted.` : ''}</span></div>
  </aside>
}