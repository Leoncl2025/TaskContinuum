import type { Message } from '@microsoft/agent-host-protocol'
import { chatImageContentSchema } from '../../shared/chatAttachments'
import type { DisplayedChatImage } from '../../shared/chatAttachments'
import { parseChatLink } from '../../shared/chatLinks'

export function messageImages(turn: { id: string; message: Pick<Message, 'attachments'> }): DisplayedChatImage[] {
  return (turn.message.attachments ?? []).flatMap((attachment, index): DisplayedChatImage[] => {
    const contentType = 'contentType' in attachment && typeof attachment.contentType === 'string'
      ? attachment.contentType.split(';')[0].trim().toLowerCase() : undefined
    const uri = attachment.type === 'resource' && typeof attachment.uri === 'string' ? attachment.uri : undefined
    const link = uri ? parseChatLink(uri) : undefined
    const imagePath = link?.kind === 'file' && /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(link.path)
    if (attachment.displayKind !== 'image' && !contentType?.startsWith('image/') && !imagePath) return []
    const id = `${turn.id}:${index}`
    const name = typeof attachment.label === 'string' && attachment.label.trim() ? attachment.label.trim().slice(0, 200) : `Image ${index + 1}`
    if (attachment.type === 'embeddedResource') {
      const image = chatImageContentSchema.safeParse({ mimeType: contentType, data: attachment.data })
      return image.success ? [{ id, name, ...image.data }]
        : [{ id, name, error: 'The Host returned unsupported, invalid or oversized screenshot data.' }]
    }
    if (uri && link?.kind === 'file') return [{ id, name, uri }]
    return [{ id, name, error: uri ? 'This image address cannot be retrieved through the trusted file transfer.' : 'The Host did not include readable data or a file address for this image.' }]
  })
}
