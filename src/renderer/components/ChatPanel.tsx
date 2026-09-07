import { useEffect, useRef } from 'react'
import type { ChatAdapter } from '../../shared/chat'
import type { TaskRecord } from '../../shared/tasks'
import type { TaskChat } from '../chat/useTaskChats'
import { Icon, IconButton } from './Primitives'

interface Props {
  task: TaskRecord
  thread: TaskChat
  adapter: ChatAdapter
  connected?: boolean
  boundSessionId?: string
  disabled?: boolean
  sessionName?: string
  onSessions?(): void
  onConnect?(): void
  onDraft(value: string): void
  onSend(value: string): void
  onStop(): void
  onClear(): void
  onClose(): void
}

export function ChatPanel({ task, thread, adapter, connected = false, boundSessionId, disabled = false, sessionName, onSessions, onConnect, onDraft, onSend, onStop, onClear, onClose }: Props) {
  const logRef = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const busy = thread.messages.some((message) => message.status === 'streaming')
  const live = adapter.kind === 'live'
  const canSend = !disabled && (!live || connected && Boolean(thread.sessionId) && thread.sessionId === boundSessionId)
  useEffect(() => {
    if (followBottom.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [thread.messages])
  useEffect(() => { followBottom.current = true }, [task.id])

  function send(value: string) { if (!canSend || busy) return; followBottom.current = true; onSend(value) }

  return <aside className="chat-panel" aria-label="Task chat">
    <header className="panel-header"><span>CHAT</span><div className="header-actions"><IconButton icon={live ? 'debug-disconnect' : 'clear-all'} label={live ? 'Detach conversation' : 'Clear conversation'} disabled={disabled || busy || !thread.messages.length && !thread.sessionId && !boundSessionId} onClick={onClear} /><IconButton icon="layout-sidebar-right-off" label="Hide chat panel" onClick={onClose} /></div></header>
    <div className="chat-context"><Icon name="attach" /><div><strong>{live ? sessionName ?? 'GitHub Copilot' : task.id}</strong><span title={boundSessionId ?? thread.sessionId}>{live ? boundSessionId ?? thread.sessionId ?? 'No session selected' : task.title}</span></div><span className="context-badge">{live ? task.id : 'Task context'}</span></div>
    {onSessions && <div className="session-toolbar"><button type="button" className="text-button" onClick={onSessions}><Icon name="history" />Local sessions</button>{connected ? <span className="session-connection-state"><Icon name="pass" />Connected</span> : <button type="button" className="text-button" onClick={onConnect}><Icon name="plug" />Connect Copilot</button>}</div>}
    <div className="chat-log" ref={logRef} role="log" aria-label={`Conversation for ${task.id}`} aria-live="polite" aria-relevant="additions text" onScroll={() => { const node = logRef.current; if (node) followBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60 }}>
      {!thread.messages.length && (live ? <div className="chat-welcome live-welcome"><span className="chat-welcome-icon"><Icon name="copilot" /></span><h2>{thread.sessionId ? 'GitHub Copilot' : 'No session selected'}</h2>{thread.sessionId ? <div className="suggestions">{['Continue this session', 'Summarize progress', 'Review next steps'].map((prompt) => <button type="button" key={prompt} disabled={!canSend} onClick={() => send(prompt)}><Icon name="arrow-right" />{prompt}</button>)}</div> : <button type="button" className="text-button" onClick={onSessions}><Icon name="history" />Open local sessions</button>}</div> : <div className="chat-welcome"><span className="chat-welcome-icon"><Icon name="comment-discussion" /></span><h2>Keep the conversation<br />with the task.</h2><p>Explore the goal, find a next step, or review what is missing.</p><div className="suggestions">{['Summarize this task', 'Suggest next steps', 'Review risks'].map((prompt) => <button type="button" key={prompt} onClick={() => send(prompt)}><Icon name={prompt.startsWith('Summarize') ? 'note' : prompt.startsWith('Suggest') ? 'arrow-right' : 'shield'} />{prompt}<Icon name="chevron-right" /></button>)}</div><p className="demo-explainer"><Icon name="beaker" />Local demo. No AI provider is connected.</p></div>)}
      {thread.messages.map((message) => <article key={message.id} className={`message message-${message.role}`} aria-label={message.role === 'user' ? 'Your message' : live ? 'Copilot response' : 'Demo agent response'}>
        <header><span className={`avatar ${message.role === 'assistant' ? 'agent-avatar' : ''}`}>{message.role === 'user' ? 'Y' : <Icon name={live ? 'copilot' : 'sparkle'} />}</span><strong>{message.role === 'user' ? 'You' : live ? 'GitHub Copilot' : 'Demo agent'}</strong>{message.role === 'assistant' && <span className="message-model">{live ? 'Local session' : 'Local'}</span>}</header>
        <div className="message-text">{message.text || (message.status === 'streaming' ? live ? 'Waiting for Copilot...' : 'Preparing a local response…' : '')}</div>
        {message.status === 'streaming' && <span className="stream-marker" aria-label="Responding" />}
        {message.status === 'cancelled' && <p className="message-notice"><Icon name="debug-stop" />Response stopped</p>}
        {message.status === 'error' && <p className="message-notice error" role="alert"><Icon name="error" />Response failed. You can send another message.</p>}
      </article>)}
    </div>
    {busy && thread.activity && <div className="session-activity" role="status">{thread.activity}</div>}
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); send(thread.draft) }}>
      <div className="composer">
        <textarea id="chat-composer" aria-label={live ? 'Message to Copilot' : 'Message to demo agent'} placeholder={live ? 'Message Copilot' : `Ask about ${task.id}…`} disabled={!canSend} value={thread.draft} maxLength={4000} rows={3} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) send(thread.draft) }
        }} />
        <div className="composer-toolbar"><span><Icon name={live ? 'copilot' : 'beaker'} />{adapter.label}</span>{busy ? <IconButton icon="debug-stop" label="Stop response" onClick={onStop} /> : <button type="submit" className="send-button" aria-label="Send message" title="Send message (Enter)" disabled={!canSend || !thread.draft.trim()}><Icon name="arrow-up" /></button>}</div>
      </div>
      <div className="composer-hint"><span>Enter to send · Shift+Enter for a new line</span><span>{thread.draft.length}/4000</span></div>
    </form>
  </aside>
}