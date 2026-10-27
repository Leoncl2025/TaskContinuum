import { useEffect, useRef, useState } from 'react'
import { chatImageDataUrl } from '../../shared/chatAttachments'
import { FILE_TRANSFER_LIMITS } from '../../shared/fileTransfer'
import type { TransferStatus } from '../../shared/fileTransfer'
import type { ChatFilePreview, ChatLinkBridge, OpenChatLinkResult } from '../../shared/chatLinks'
import { canOpenChatDocument } from '../../shared/chatLinks'
import { ChatLinkFailure, chatLinkResult } from '../chat/chatLinkResults'
import { machineLabel, useMachineAliases } from '../machineAliases'
import { Dialog, Icon } from './Primitives'

type LinkedFile = Extract<OpenChatLinkResult, { kind: 'file' }>
const previewLimit = 256 * 1024

export function ChatFileDialog({ file, api, onClose }: {
  file: LinkedFile; api: ChatLinkBridge; onClose(status: TransferStatus): void
}) {
  const aliases = useMachineAliases()
  const [status, setStatus] = useState(file.status)
  const [preview, setPreview] = useState<ChatFilePreview>()
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [opened, setOpened] = useState(false)
  const line = useRef<HTMLSpanElement>(null)
  const located = useRef(false)
  const scope = useRef({ active: false })
  const reference = { target: file.target, transferId: file.status.transferId }
  const metadata = status.files[0]
  const title = metadata?.name ?? (status.state === 'transferring' ? 'Receiving linked file' : 'Linked file')

  useEffect(() => {
    const current = { active: true }
    scope.current = current
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const wait = () => new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, 350) })
    void (async () => {
      let latest = file.status
      while (current.active && latest.state === 'transferring') {
        await wait()
        if (!current.active) return
        latest = chatLinkResult(await api.status({ target: file.target, transferId: file.status.transferId }))
        if (current.active) setStatus(latest)
      }
      if (!current.active) return
      if (latest.state !== 'delivered') throw new ChatLinkFailure(latest.error?.code ?? 'UNAVAILABLE',
        latest.error?.message ?? 'The file did not finish transferring. Retry the link when its source device is available.')
      if (latest.files.length !== 1) throw new ChatLinkFailure('INTEGRITY_FAILED', 'The linked file transfer did not return exactly one file.')
      const result = chatLinkResult(await api.preview({ target: file.target, transferId: latest.transferId, fileId: latest.files[0].fileId }))
      if (!current.active) return
      setPreview(result)
      if (result.kind === 'text') setText(result.page.text)
    })().catch((failure: unknown) => {
      if (current.active) setError(failure instanceof Error ? failure.message : 'The linked file could not be opened.')
    }).finally(() => { if (current.active) setLoading(false) })
    return () => { current.active = false; clearTimeout(timer); wake?.() }
  }, [api, file])

  useEffect(() => {
    if (line.current && !located.current) { line.current.scrollIntoView?.({ block: 'center' }); located.current = true }
  }, [file.line, text])

  async function more(): Promise<void> {
    if (!metadata || preview?.kind !== 'text' || preview.page.eof || loading) return
    setLoading(true)
    setError(undefined)
    const current = scope.current
    try {
      const result = chatLinkResult(await api.preview({ ...reference, fileId: metadata.fileId, offset: preview.page.nextOffset,
        maxBytes: Math.min(FILE_TRANSFER_LIMITS.readBytes, previewLimit - preview.page.nextOffset) }))
      if (!current.active) return
      if (result.kind !== 'text') throw new Error('The linked file changed its preview type.')
      setPreview(result)
      setText((previous) => previous + result.page.text)
    } catch (failure) {
      if (current.active) setError(failure instanceof Error ? failure.message : 'The next part of the file could not be read.')
    } finally { if (current.active) setLoading(false) }
  }

  async function save(openAfterSave = false): Promise<void> {
    if (!metadata || saving || status.state !== 'delivered') return
    setSaving(true)
    setError(undefined)
    const current = scope.current
    try {
      const result = chatLinkResult(await api.save({ ...reference, fileId: metadata.fileId, ...(openAfterSave ? { openAfterSave } : {}) }))
      if (current.active) { setSaved(result.saved); setOpened(result.opened === true) }
    } catch (failure) {
      if (current.active) setError(failure instanceof Error ? failure.message : 'The local copy could not be saved.')
    } finally { if (current.active) setSaving(false) }
  }

  const total = status.files.reduce((size, item) => size + item.sizeBytes, 0) || FILE_TRANSFER_LIMITS.batchBytes
  return <Dialog title={title} className="chat-file-dialog" closeDisabled={saving} onClose={() => onClose(status)}>
    <p className="chat-file-origin"><Icon name="server" />{status.deviceId === 'local' ? 'This computer' : machineLabel(file.target.owner, aliases)}
      {file.line && <span>Line {file.line}{file.column ? `, column ${file.column}` : ''}</span>}</p>
    {loading && !preview && <div className="chat-file-progress" role="status">
      <span>{status.state === 'transferring' ? 'Receiving file...' : 'Opening received file...'}</span>
      {status.state === 'transferring' && <progress aria-label="Receiving linked file" value={status.receivedBytes} max={total} />}
    </div>}
    {error && <p className="copilot-error" role="alert">{error}</p>}
    {preview?.kind === 'image' && <img className="chat-file-image" src={chatImageDataUrl(preview.image)} alt={metadata?.name ?? 'Received image'} />}
    {preview?.kind === 'text' && <pre className="chat-file-text" aria-label="Received file content" tabIndex={0}><code>{text.split('\n').map((value, index, lines) =>
      <span key={index} ref={index + 1 === file.line ? line : undefined} className={index + 1 === file.line ? 'chat-file-line-target' : undefined}>{value}{index + 1 < lines.length ? '\n' : ''}</span>)}</code></pre>}
    {preview?.kind === 'text' && !preview.page.eof && <p className="muted">
      Previewing {preview.page.nextOffset.toLocaleString()} of {metadata?.sizeBytes.toLocaleString()} bytes.
      {preview.page.nextOffset > previewLimit - 4 && ' Save a local copy to view the complete file.'}
    </p>}
    {saved && <p role="status">{opened ? 'Local copy opened on this device.' : 'Local copy saved.'}</p>}
    <div className="dialog-actions">
      {preview?.kind === 'text' && !preview.page.eof && preview.page.nextOffset <= previewLimit - 4 && <button type="button" className="secondary-button" disabled={loading || saving} onClick={() => { void more() }}>{loading ? 'Reading...' : 'Read more'}</button>}
      {status.state === 'delivered' && <button type="button" className="primary-button" disabled={saving} onClick={() => { void save() }}>{saving ? 'Saving...' : 'Save local copy'}</button>}
      {status.state === 'delivered' && metadata && canOpenChatDocument(metadata.name) && <button type="button" className="secondary-button" disabled={saving} onClick={() => { void save(true) }}>Save and open locally</button>}
      <button type="button" className="secondary-button" disabled={saving} onClick={() => onClose(status)}>{status.state === 'transferring' ? 'Cancel transfer' : 'Close'}</button>
    </div>
  </Dialog>
}
