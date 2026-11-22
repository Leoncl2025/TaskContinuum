import { useRef, useState } from 'react'
import { CHAT_IMAGE_TYPES, chatImageDataUrl } from '../../shared/chatAttachments'
import type { DisplayedChatImage } from '../../shared/chatAttachments'
import type { useChatImageInput } from '../chat/useChatImageInput'
import { Dialog, Icon, IconButton } from './Primitives'
import { ImagePreviewStage, PreviewFullScreenButton } from './ImagePreviewStage'
import { MarkdownLink, MarkdownLinks } from './MarkdownLinks'

export function ChatImages({ images = [], onRemove, disabled = false }: { images?: DisplayedChatImage[]; onRemove?(id: string): void; disabled?: boolean }) {
  const [selected, setSelected] = useState<string>()
  const [fullScreen, setFullScreen] = useState(false)
  const preview = images.find((image) => image.id === selected)
  if (!images.length) return null
  const toggleFullScreen = () => setFullScreen((current) => !current)
  return <>
    <div className="chat-images" aria-label={onRemove ? 'Attached images' : 'Message images'}>
      {images.map((image) => <figure className="chat-image" key={image.id}>
        {'data' in image ? <button type="button" className="chat-image-preview" title={`Preview ${image.name}`} aria-label={`Preview ${image.name}`} onClick={() => { setFullScreen(false); setSelected(image.id) }}><img src={chatImageDataUrl(image)} alt={image.name} /></button>
          : 'uri' in image ? <MarkdownLinks><MarkdownLink href={image.uri} className="chat-image-preview chat-image-reference"><Icon name="file-media" /><span>Preview {image.name}</span></MarkdownLink></MarkdownLinks>
          : <span className="chat-image-placeholder" title={'error' in image ? image.error : 'Image stored on the execution machine'}><Icon name={'error' in image ? 'warning' : 'file-media'} /></span>}
        {onRemove && <IconButton icon="close" label={`Remove ${image.name}`} disabled={disabled} onClick={() => onRemove(image.id)} />}
        <figcaption title={image.name}>{image.name}</figcaption>
        {'error' in image && <p className="chat-image-unavailable" role="status">{image.error}</p>}
      </figure>)}
    </div>
    {preview && 'data' in preview && <Dialog
      title={preview.name}
      className={`chat-image-dialog${fullScreen ? ' is-fullscreen' : ''}`}
      headerActions={<PreviewFullScreenButton fullScreen={fullScreen} onToggle={toggleFullScreen} />}
      onEscape={() => {
        if (!fullScreen) return false
        setFullScreen(false)
        return true
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
        if (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return
        if (event.key === 'f' || event.key === 'F') {
          event.preventDefault()
          toggleFullScreen()
        }
      }}
      onClose={() => { setFullScreen(false); setSelected(undefined) }}
    >
      <ImagePreviewStage key={preview.id} src={chatImageDataUrl(preview)} alt={preview.name} fullScreen={fullScreen} />
    </Dialog>}
  </>
}

export function ChatImagePicker({ onFiles, disabled }: { onFiles(files: File[]): Promise<void>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return <><input ref={input} type="file" aria-label="Image files" accept={CHAT_IMAGE_TYPES.join(',')} multiple hidden disabled={disabled} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void onFiles(files) }} /><IconButton icon="file-media" label="Attach images" disabled={disabled} onClick={() => input.current?.click()} /></>
}

export function ChatImageStatus({ input }: { input: ReturnType<typeof useChatImageInput> }) {
  return <>{input.error && <p className="chat-image-error copilot-error" role="alert">{input.error}</p>}{input.reading && <p className="chat-image-status muted" role="status">Reading images...</p>}</>
}