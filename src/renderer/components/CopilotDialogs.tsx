import { useState } from 'react'
import type { ImportPreview, SessionOptions } from '../../shared/sessions'
import type { CopilotInteraction } from '../chat/useCopilotConnection'
import { Dialog, Icon, IconButton } from './Primitives'

interface SessionDialogProps {
  preview?: ImportPreview
  directory: string
  models: { id: string; name: string }[]
  ready: boolean
  busy: boolean
  error: string | null
  onBrowse(): Promise<string | null | undefined>
  onConnect(): void
  onSubmit(options: SessionOptions): void
  onClose(): void
}

export function CopilotSessionDialog({ preview, directory, models, ready, busy, error, onBrowse, onConnect, onSubmit, onClose }: SessionDialogProps) {
  const [workingDirectory, setWorkingDirectory] = useState(preview?.session.workingDirectory ?? directory)
  const [model, setModel] = useState('')
  return <Dialog title={preview ? 'Continue VS Code conversation' : 'New Copilot session'} className={preview ? 'import-dialog' : ''} onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={(event) => { event.preventDefault(); if (ready && workingDirectory && !busy) onSubmit({ workingDirectory, model: model || undefined }) }}>
      {preview && <><h3 className="import-title">{preview.session.title}</h3><p className="import-notice">A new Copilot session will receive the text below. The VS Code source stays unchanged. Tools, attachments, and pending edits are excluded.</p><div className="import-transcript" aria-label="Import preview">{preview.messages.map((message) => <article key={message.id}><strong>{message.role === 'user' ? 'You' : 'Copilot'}</strong><p>{message.text}</p></article>)}</div>{preview.truncated && <p className="import-warning">Earlier context was omitted to fit the import limit.</p>}</>}
      <label className="form-field">Working directory<div className="directory-picker"><input aria-label="Working directory" readOnly value={workingDirectory} title={workingDirectory} /><IconButton icon="folder-opened" label="Choose working directory" disabled={busy} onClick={() => { void onBrowse().then((value) => { if (value) setWorkingDirectory(value) }) }} /></div></label>
      <label className="form-field">Model<select aria-label="Copilot model" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}><option value="">Default model</option>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {error && <p className="copilot-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>{!ready ? <button type="button" className="primary-button" disabled={busy} onClick={onConnect}><Icon name="plug" />Connect Copilot</button> : <button type="submit" className="primary-button" disabled={busy || !workingDirectory}><Icon name={preview ? 'git-branch' : 'add'} />{preview ? 'Continue in new session' : 'Create session'}</button>}</div>
    </form>
  </Dialog>
}

export function CopilotInteractionDialog({ interaction, busy, error, onRespond }: { interaction: CopilotInteraction; busy: boolean; error: string | null; onRespond(value: boolean | string): void }) {
  const [answer, setAnswer] = useState('')
  const [freeform, setFreeform] = useState('')
  const permission = interaction.type === 'permission'
  return <Dialog title={permission ? 'Copilot permission' : 'Copilot question'} className="permission-dialog" onClose={() => { if (!busy) onRespond(false) }}>
    <dl className="permission-metadata"><dt>Session</dt><dd>{interaction.sessionId}</dd>{permission && <><dt>Operation</dt><dd>{interaction.kind}</dd></>}</dl>
    {permission ? <><pre className="permission-details">{interaction.details}</pre><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => onRespond(false)} autoFocus>Deny</button><button type="button" className="primary-button" disabled={busy} onClick={() => onRespond(true)}><Icon name="check" />Allow once</button></div></> : <form onSubmit={(event) => { event.preventDefault(); if (!busy && (freeform.trim() || answer)) onRespond(freeform.trim() || answer) }}><p>{interaction.question}</p><fieldset className="question-choices"><legend>Answer</legend>{interaction.choices.map((choice) => <label key={choice}><input type="radio" name="copilot-answer" checked={answer === choice && !freeform} onChange={() => { setAnswer(choice); setFreeform('') }} />{choice}</label>)}</fieldset>{interaction.allowFreeform && <label className="form-field">Your answer<textarea aria-label="Answer to Copilot" rows={3} maxLength={8000} value={freeform} onChange={(event) => setFreeform(event.target.value)} /></label>}<p className="import-notice">Do not enter passwords or tokens.</p><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => onRespond(false)}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !(freeform.trim() || answer)}>Submit answer</button></div></form>}
    {error && <p className="copilot-error" role="alert">{error}</p>}
  </Dialog>
}