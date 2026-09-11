import { useRef, useState } from 'react'
import { CHAT_IMAGE_TYPES, chatImageDataUrl } from '../../shared/chatAttachments'
import type { ChatImageAttachment, ChatImageReference } from '../../shared/chatAttachments'
import type { useChatImageInput } from '../chat/useChatImageInput'
import { Dialog, Icon, IconButton } from './Primitives'

export function ChatImages({ images = [], onRemove, disabled = false }: { images?: (ChatImageAttachment | ChatImageReference)[]; onRemove?(id: string): void; disabled?: boolean }) {
  const [selected, setSelected] = useState<string>()
  const preview = images.find((image) => image.id === selected)
  if (!images.length) return null
  return <>
    <div className="chat-images" aria-label={onRemove ? 'Attached images' : 'Message images'}>
      {images.map((image) => <figure className="chat-image" key={image.id}>
        {'data' in image ? <button type="button" className="chat-image-preview" title={`Preview ${image.name}`} aria-label={`Preview ${image.name}`} onClick={() => setSelected(image.id)}><img src={chatImageDataUrl(image)} alt={image.name} /></button> : <span className="chat-image-placeholder" title="Image stored on the execution machine"><Icon name="file-media" /></span>}
        {onRemove && <IconButton icon="close" label={`Remove ${image.name}`} disabled={disabled} onClick={() => onRemove(image.id)} />}
        <figcaption title={image.name}>{image.name}</figcaption>
      </figure>)}
    </div>
    {preview && 'data' in preview && <Dialog title={preview.name} className="chat-image-dialog" onClose={() => setSelected(undefined)}><img src={chatImageDataUrl(preview)} alt={preview.name} /></Dialog>}
  </>
}

export function ChatImagePicker({ onFiles, disabled }: { onFiles(files: File[]): Promise<void>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return <><input ref={input} type="file" aria-label="Image files" accept={CHAT_IMAGE_TYPES.join(',')} multiple hidden disabled={disabled} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void onFiles(files) }} /><IconButton icon="file-media" label="Attach images" disabled={disabled} onClick={() => input.current?.click()} /></>
}

export function ChatImageStatus({ input }: { input: ReturnType<typeof useChatImageInput> }) {
  return <>{input.error && <p className="chat-image-error copilot-error" role="alert">{input.error}</p>}{input.reading && <p className="chat-image-status muted" role="status">Reading images...</p>}</>
}