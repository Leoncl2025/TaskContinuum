import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { SharedCheckpointPreview, SharedEvent, SharedView } from '../../shared/sharedSessions'
import type { TaskRecord } from '../../shared/tasks'
import { useSharedSessions } from '../chat/useSharedSessions'
import { CopilotInteractionDialog } from './CopilotDialogs'
import { Dialog, Icon, IconButton } from './Primitives'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatImagePicker, ChatImages, ChatImageStatus } from './ChatImages'
import { useChatImageInput } from '../chat/useChatImageInput'
import { sameChatImages } from '../../shared/chatAttachments'
import type { ChatImageAttachment, ChatImageReference } from '../../shared/chatAttachments'
import '../shared-sessions.css'

interface SharedMessage { id: string; actor: SharedEvent['actor']; text: string; role: 'user' | 'assistant'; state?: string; images?: ChatImageReference[] }

function timeline(events: SharedEvent[]): SharedMessage[] {
  const messages: SharedMessage[] = []
  const replies = new Map<string, SharedMessage>()
  for (const event of events) {
    if (event.type === 'history') messages.push({ id: `history-${event.seq}`, actor: event.actor, text: event.text ?? '', role: event.role ?? 'assistant' })
    if (event.type === 'message') messages.push({ id: `user-${event.commandId}`, actor: event.actor, text: event.text ?? '', role: 'user', images: event.images })
    if (event.type === 'started' && event.commandId) {
      const message: SharedMessage = { id: event.commandId, actor: event.actor, text: '', role: 'assistant', state: 'Running' }
      replies.set(event.commandId, message)
      messages.push(message)
    }
    const reply = event.commandId ? replies.get(event.commandId) : undefined
    if (reply && event.type === 'delta') reply.text += event.text ?? ''
    if (reply && event.type === 'activity') reply.state = event.text
    if (reply && ['completed', 'failed', 'interrupted'].includes(event.type)) reply.state = event.type === 'completed' ? undefined : event.text ?? event.type
  }
  return messages
}

export interface SharedPanelStatus { online: boolean; busy: boolean; pending: boolean; message: string }

export function SharedSessionPanel({ task, root, onClose, onStatus }: { task?: TaskRecord; root: string; onClose(): void; onStatus?(status: SharedPanelStatus): void }) {
  const shared = useSharedSessions(root)
  const bridge = shared.bridge
  const sessions = shared.sessions.filter((session) => session.taskId === task?.id)
  const [requested, setRequested] = useState<string>()
  const selectedId = sessions.some((session) => session.id === requested) ? requested : sessions[0]?.id
  const view = selectedId ? shared.views[selectedId] : undefined
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImageAttachment[]>>({})
  const [sentImages, setSentImages] = useState<Record<string, ChatImageAttachment[]>>({})
  const draftKey = selectedId ?? task?.id ?? 'empty'
  const draft = drafts[draftKey] ?? ''
  const images = imageDrafts[draftKey] ?? []
  const imageInput = useChatImageInput(`${root}:${draftKey}`, images, (value) => setImageDrafts((current) => ({ ...current, [draftKey]: value })), shared.busy)
  const [dialog, setDialog] = useState<'publish' | 'invite' | 'checkpoint' | null>(null)
  const [directory, setDirectory] = useState(root)
  const [mode, setMode] = useState<'live' | 'checkpoint'>('live')
  const [alias, setAlias] = useState('')
  const [role, setRole] = useState<'reader' | 'contributor' | 'operator'>('contributor')
  const [preview, setPreview] = useState<SharedCheckpointPreview>()
  const [notice, setNotice] = useState<string>()
  const log = useRef<HTMLDivElement>(null)
  const submissions = useRef(new Map<string, { id: string; text: string; images: ChatImageAttachment[] }>())
  const sending = useRef(false)
  const events = view?.events ?? []
  const pending = new Map<string, SharedEvent>()
  const unfinished = new Set<string>()
  for (const event of events) {
    if (event.type === 'message' && event.commandId) unfinished.add(event.commandId)
    if (event.commandId && ['completed', 'failed', 'interrupted'].includes(event.type)) unfinished.delete(event.commandId)
    if ((event.type === 'permission' || event.type === 'question') && event.interactionId) pending.set(event.interactionId, event)
    if (event.type === 'resolved' && event.interactionId) pending.delete(event.interactionId)
  }
  const interaction = view?.online && view.permissions.includes('approve') ? pending.values().next().value as SharedEvent | undefined : undefined
  const canSend = view?.online && view.permissions.includes('send') && !shared.busy
  const reportStatus = useEffectEvent((status: SharedPanelStatus) => onStatus?.(status))
  const statusText = shared.busy ? 'Shared session operation...' : view?.online ? `Shared Agent on ${view.session.owner.machineName}` : view?.checkpoint ? 'Checkpoint copy' : view ? 'Shared session offline' : 'Shared sessions'
  useEffect(() => {
    reportStatus({ online: Boolean(view?.online), busy: shared.busy, pending: Boolean(dialog || interaction), message: statusText })
  }, [view?.online, shared.busy, dialog, interaction, statusText])
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight }, [events.length, selectedId])

  async function send(): Promise<void> {
    if (!bridge || !view || !canSend || !draft.trim() && !images.length || sending.current || imageInput.isReading()) return
    sending.current = true
    const currentDraft = draft
    const text = currentDraft.trim()
    const prior = submissions.current.get(view.session.id)
    const command = prior?.text === text && sameChatImages(prior.images, images) ? prior : { id: crypto.randomUUID(), text, images }
    submissions.current.set(view.session.id, command)
    try {
      const sent = await shared.run(async () => { await (command.images.length ? bridge.send(view.session.id, command.id, command.text, command.images) : bridge.send(view.session.id, command.id, command.text)); return true })
      if (sent) {
        submissions.current.delete(view.session.id)
        setDrafts((current) => ({ ...current, [draftKey]: current[draftKey] === currentDraft ? '' : current[draftKey] }))
        setImageDrafts((current) => ({ ...current, [draftKey]: (current[draftKey] ?? []).filter((image) => !command.images.some((sent) => sent.id === image.id)) }))
        setSentImages((current) => ({ ...current, [draftKey]: command.images }))
      }
    } finally { sending.current = false }
  }
  async function receive(action: () => Promise<SharedView | null>): Promise<void> {
    const next = await shared.run(action)
    if (next) {
      shared.retain(next)
      setRequested(next.session.id)
      setDialog(null)
      await shared.run(() => shared.refresh())
    }
  }
  async function browse(): Promise<void> {
    const chosen = await shared.run(() => window.copilot!.chooseDirectory())
    if (chosen) setDirectory(chosen)
  }

  return <aside className="chat-panel shared-panel" aria-label="Shared session chat">
    <header className="panel-header"><span>SHARED SESSION</span><div className="header-actions"><IconButton icon="account" label="Export participant identity" disabled={shared.busy} onClick={() => { void shared.run(() => bridge!.exportIdentity()) }} /><IconButton icon="refresh" label="Refresh shared sessions" disabled={shared.busy} onClick={() => { void shared.run(() => shared.refresh()) }} /><IconButton icon="close" label="Hide shared chat" onClick={onClose} /></div></header>
    <div className="shared-session-picker"><label>Task {task?.id ?? 'not selected'}<select aria-label="Shared session" value={selectedId ?? ''} onChange={(event) => { setRequested(event.target.value); void shared.open(event.target.value) }}><option value="">Select shared session</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.owner} / {session.id.slice(0, 8)}{session.parentSessionId ? ' (fork)' : ''}</option>)}</select></label><div className="header-actions"><IconButton icon="broadcast" label="Publish shared session" disabled={!task || shared.busy} onClick={() => { setDirectory(root); setDialog('publish') }} /><IconButton icon="plug" label="Join shared session" disabled={shared.busy} onClick={() => { void receive(() => bridge!.join()) }} /><IconButton icon="folder-opened" label="Open checkpoint" disabled={shared.busy} onClick={() => { void shared.run(() => bridge!.previewCheckpoint()).then((value) => { if (value) { setPreview(value); setDirectory(root); setDialog('checkpoint') } }) }} /></div></div>
    {selectedId && <div className="shared-connection"><span><Icon name={view?.online ? 'radio-tower' : 'history'} />{view?.online ? `Live on ${view.session.owner.machineName}` : view?.checkpoint ? `Checkpoint / ${events.length} events` : view ? `Offline / ${events.length} cached events` : 'Not connected'}</span>{!view?.checkpoint && <IconButton icon={view?.online ? 'debug-disconnect' : 'debug-start'} label={view?.online ? 'Disconnect shared view' : 'Connect shared session'} disabled={shared.busy} onClick={() => { if (view?.online) void shared.run(() => bridge!.disconnect(selectedId)); else void shared.open(selectedId) }} />}</div>}
    {view && <div className="shared-actor"><span>{view.actor.name} @ {view.actor.machineName}</span><span>{view.session.mode === 'checkpoint' ? 'Live + checkpoint' : 'Live only'}</span></div>}
    {shared.error && !dialog && <p className="copilot-error shared-error" role="alert">{shared.error}</p>}
    {view?.error && !shared.error && <p className="shared-error muted" role="status">{view.error}</p>}
    {notice && <p className="shared-error muted" role="status">{notice}</p>}
    <div className="chat-log" ref={log} role="log" aria-label="Shared conversation" aria-live="polite">
      {!events.length && <div className="empty-sidebar"><Icon name="comment-discussion" /><strong>{view && !view.online ? 'No cached history on this machine' : 'No shared conversation loaded'}</strong></div>}
      {timeline(events).map((message) => <article key={message.id} data-command-id={message.id} className={`message message-${message.role}`}><header><Icon name={message.actor.kind === 'agent' ? 'copilot' : 'account'} /><strong>{message.actor.name}</strong><span className="message-model">{message.actor.machineName}</span></header>{message.role === 'assistant' ? <ChatMarkdown source={message.text} /> : <div className="message-text">{message.text}</div>}<ChatImages images={message.images?.map((image) => sentImages[draftKey]?.find((sent) => sent.id === image.id) ?? image)} />{message.state && <p className="message-notice">{message.state}</p>}</article>)}
    </div>
    {view && <div className="shared-actions"><span>{unfinished.size ? `${unfinished.size} active or queued` : `Event ${events.at(-1)?.seq ?? 0}`}</span>{view.permissions.includes('manage') && <><IconButton icon="person-add" label="Invite participant" disabled={!view.online || shared.busy} onClick={() => setDialog('invite')} />{view.online ? <IconButton icon="debug-stop" label="Stop shared Host" disabled={shared.busy} onClick={() => { void shared.run(() => bridge!.stopHost(view.session.id)) }} /> : <IconButton icon="debug-restart" label="Restart local shared Host" disabled={shared.busy} onClick={() => { void receive(() => bridge!.restartHost(view.session.id)) }} />}</>}{view.permissions.includes('checkpoint') && view.session.mode === 'checkpoint' && <IconButton icon="cloud-download" label="Export checkpoint" disabled={!view.online || shared.busy || unfinished.size > 0} onClick={() => { void shared.run(() => bridge!.exportCheckpoint(view.session.id)).then((result) => { if (result) setNotice(result) }) }} />}{view.permissions.includes('stop') && unfinished.size > 0 && <IconButton icon="debug-pause" label="Stop shared response" disabled={!view.online || shared.busy} onClick={() => { void shared.run(() => bridge!.stop(view.session.id, unfinished.values().next().value!)) }} />}</div>}
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}><ChatImageStatus input={imageInput} /><div className="composer"><ChatImages images={images} onRemove={imageInput.remove} disabled={shared.busy} /><textarea aria-label="Message shared Agent" rows={3} maxLength={4000} value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} onPaste={imageInput.paste} placeholder="Message shared Agent" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="composer-toolbar"><ChatImagePicker onFiles={imageInput.add} disabled={shared.busy || imageInput.reading} /><span><Icon name="server" />{view ? view.session.owner.machineName : 'No execution owner'}</span><button type="submit" className="send-button" aria-label="Send shared message" disabled={!canSend || imageInput.reading || !draft.trim() && !images.length}><Icon name="arrow-up" /></button></div></div></form>
    {dialog === 'publish' && task && <Dialog title="Publish shared session" onClose={() => { if (!shared.busy) setDialog(null) }}><form onSubmit={(event) => { event.preventDefault(); void receive(() => bridge!.publish({ taskId: task.id, workingDirectory: directory, mode })) }}><p>{task.id}: {task.title}</p><label className="form-field">Execution directory<div className="directory-picker"><input readOnly aria-label="Shared execution directory" value={directory} /><IconButton icon="folder-opened" label="Choose shared execution directory" disabled={shared.busy} onClick={() => { void browse() }} /></div></label><label className="form-field">Persistence<select aria-label="Shared persistence mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="live">Live only</option><option value="checkpoint">Live + checkpoint</option></select></label><p className="dialog-hint">This machine will run a new Agent in an independent Host. Closing this window will not stop it. Conversation data stays local until you explicitly invite participants or export a checkpoint.</p>{shared.error && <p className="copilot-error" role="alert">{shared.error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={shared.busy} onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="primary-button" disabled={shared.busy || !directory}><Icon name="broadcast" />Publish</button></div></form></Dialog>}
    {dialog === 'invite' && view && <Dialog title="Invite participant" onClose={() => { if (!shared.busy) setDialog(null) }}><form onSubmit={(event) => { event.preventDefault(); void shared.run(() => bridge!.invite(view.session.id, alias, role)).then((value) => { if (value) setDialog(null) }) }}><label className="form-field">Recipient SSH host alias for this owner<input aria-label="Owner SSH alias" value={alias} maxLength={150} onChange={(event) => setAlias(event.target.value)} /></label><label className="form-field">Role<select aria-label="Participant role" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="reader">Reader</option><option value="contributor">Contributor</option><option value="operator">Operator</option></select></label><p className="dialog-hint">Select the recipient's exported identity next. The private invitation must be transferred outside Git.</p>{shared.error && <p className="copilot-error" role="alert">{shared.error}</p>}<div className="dialog-actions"><button type="submit" className="primary-button" disabled={shared.busy || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)}>Choose recipient</button></div></form></Dialog>}
    {dialog === 'checkpoint' && preview && <Dialog title="Checkpoint continuation" className="import-dialog" onClose={() => { if (!shared.busy) setDialog(null) }}><dl className="permission-metadata"><dt>Task</dt><dd>{preview.taskId}</dd><dt>Source</dt><dd>{preview.sessionId}</dd><dt>Commit</dt><dd>{preview.commit}</dd><dt>Events</dt><dd>{preview.lastSeq}</dd></dl><div className="import-transcript"><pre className="checkpoint-context">{preview.context}</pre></div><label className="form-field">Independent clean checkout<div className="directory-picker"><input readOnly value={directory} aria-label="Fork execution directory" /><IconButton icon="folder-opened" label="Choose fork directory" disabled={shared.busy} onClick={() => { void browse() }} /></div></label><p className="dialog-hint">Semantic fork creates a new Agent and session on this machine. It does not stop or take ownership from an unreachable source Agent. The selected checkout must match this commit.</p>{shared.error && <p className="copilot-error" role="alert">{shared.error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={shared.busy} onClick={() => { void receive(() => bridge!.keepCheckpoint(preview.token)) }}><Icon name="save" />Keep offline copy</button><button type="button" className="primary-button" disabled={shared.busy} onClick={() => { void receive(() => bridge!.fork(preview.token, directory)) }}><Icon name="git-branch" />Create semantic fork</button></div></Dialog>}
    {interaction && view && <CopilotInteractionDialog key={interaction.interactionId} interaction={interaction.type === 'permission' ? { type: 'permission', id: interaction.interactionId!, sessionId: view.session.id, kind: interaction.permissionKind ?? 'tool', details: interaction.text ?? '' } : { type: 'user-input', id: interaction.interactionId!, sessionId: view.session.id, question: interaction.text ?? '', choices: interaction.choices ?? [], allowFreeform: interaction.allowFreeform !== false }} busy={shared.busy} error={shared.error} onRespond={(answer) => { void shared.run(() => bridge!.respond(view.session.id, interaction.interactionId!, answer)) }} />}
  </aside>
}