import { z } from 'zod'

export const MAX_CHAT_IMAGES = 4
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_CHAT_IMAGE_REQUEST_BYTES = Math.ceil(MAX_CHAT_IMAGE_TOTAL_BYTES / 3) * 4 + 64 * 1024
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface ChatImageAttachment {
  id: string
  name: string
  mimeType: typeof CHAT_IMAGE_TYPES[number]
  data: string
}

export interface ChatImageReference extends Omit<ChatImageAttachment, 'data'> {
  sha256: string
  byteLength: number
}

export const chatImageReferenceSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(200), mimeType: z.enum(CHAT_IMAGE_TYPES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().min(1).max(MAX_CHAT_IMAGE_BYTES),
}).strict()

export const chatImageReferencesSchema = z.array(chatImageReferenceSchema).max(MAX_CHAT_IMAGES)

export function chatImageBytes(image: Pick<ChatImageAttachment, 'data'>): number {
  return image.data.length / 4 * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0)
}

function hasImageHeader(image: ChatImageAttachment): boolean {
  if (!image.data.length || image.data.length % 4 || image.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false
  const tail = image.data.slice(-4)
  if (btoa(atob(tail)) !== tail) return false
  const header = atob(image.data.slice(0, 32))
  switch (image.mimeType) {
    case 'image/png': return header.startsWith('\x89PNG\r\n\x1a\n')
    case 'image/jpeg': return header.startsWith('\xff\xd8\xff')
    case 'image/gif': return header.startsWith('GIF87a') || header.startsWith('GIF89a')
    case 'image/webp': return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
  }
}

export const chatImageAttachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(CHAT_IMAGE_TYPES),
  data: z.string().max(Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4),
}).strict().refine((image) => hasImageHeader(image) && chatImageBytes(image) <= MAX_CHAT_IMAGE_BYTES, 'Choose a valid PNG, JPEG, GIF, or WebP image up to 5 MiB.')

export const chatImageAttachmentsSchema = z.array(chatImageAttachmentSchema).max(MAX_CHAT_IMAGES, 'Attach up to 4 images per message.').refine(
  (images) => images.reduce((total, image) => total + chatImageBytes(image), 0) <= MAX_CHAT_IMAGE_TOTAL_BYTES,
  'Images must total 10 MiB or less.',
).refine((images) => new Set(images.map((image) => image.id)).size === images.length, 'Image IDs must be unique.')

export const chatContentSchema = z.object({
  text: z.string().trim().max(4000).refine((text) => !text.includes('\0'), 'Invalid message.'), images: chatImageAttachmentsSchema.optional(),
}).strict().refine((request) => Boolean(request.text || request.images?.length), 'Enter a message or attach an image.')

export const chatSubmissionSchema = chatContentSchema.safeExtend({ id: z.uuid() })

export function sameChatImages(left: ChatImageAttachment[], right: ChatImageAttachment[]): boolean {
  return left.length === right.length && left.every((image, index) => image.id === right[index].id && image.name === right[index].name && image.mimeType === right[index].mimeType && image.data === right[index].data)
}

export function chatImageDataUrl(image: ChatImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`
}