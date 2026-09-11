import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { CHAT_IMAGE_TYPES, chatImageAttachmentsSchema, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_TOTAL_BYTES } from '../../shared/chatAttachments'
import type { ChatImageAttachment } from '../../shared/chatAttachments'

async function readImages(files: File[]): Promise<ChatImageAttachment[]> {
  if (files.length > MAX_CHAT_IMAGES) throw new Error('Attach up to 4 images per message.')
  if (files.reduce((total, file) => total + file.size, 0) > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error('Images must total 10 MiB or less.')
  for (const file of files) {
    if (!CHAT_IMAGE_TYPES.some((type) => type === file.type) || file.size > MAX_CHAT_IMAGE_BYTES) throw new Error('Choose a PNG, JPEG, GIF, or WebP image up to 5 MiB.')
  }
  const images = await Promise.all(files.map((file) => new Promise<ChatImageAttachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.onabort = () => reject(new Error('Image reading was cancelled.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error('The image could not be read.')); return }
      resolve({ id: crypto.randomUUID(), name: file.name.slice(0, 200) || 'Pasted image.png', mimeType: file.type as ChatImageAttachment['mimeType'], data: reader.result.slice(reader.result.indexOf(',') + 1) })
    }
    reader.readAsDataURL(file)
  })))
  const checked = chatImageAttachmentsSchema.safeParse(images)
  if (!checked.success) throw new Error(checked.error.issues[0].message)
  return checked.data
}

export function useChatImageInput(key: string, images: ChatImageAttachment[], onChange: (images: ChatImageAttachment[]) => void, disabled = false) {
  const latest = useRef({ key, images, onChange, disabled })
  const mounted = useRef(false)
  const generation = useRef(0)
  const pending = useRef(0)
  const [reading, setReading] = useState(false)
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  useLayoutEffect(() => { latest.current = { key, images, onChange, disabled } })
  useLayoutEffect(() => { generation.current++ }, [key])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function add(files: File[]): Promise<void> {
    if (!files.length || latest.current.disabled) return
    const version = generation.current
    pending.current++
    setReading(true)
    setFailure(undefined)
    try {
      const additions = await readImages(files)
      if (!mounted.current || generation.current !== version) return
      const current = latest.current
      const checked = chatImageAttachmentsSchema.safeParse([...current.images, ...additions])
      if (!checked.success) throw new Error(checked.error.issues[0].message)
      current.images = checked.data
      current.onChange(checked.data)
    } catch (error) {
      if (mounted.current && generation.current === version) setFailure({ key, message: error instanceof Error ? error.message : 'The image could not be attached.' })
    } finally {
      pending.current--
      if (mounted.current) setReading(pending.current > 0)
    }
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const items = Array.from(event.clipboardData.items ?? []).filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    const files = items.length ? items.flatMap((item) => { const file = item.getAsFile(); return file ? [file] : [] }) : Array.from(event.clipboardData.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    void add(files)
  }

  function remove(id: string): void {
    const current = latest.current
    if (current.disabled) return
    current.images = current.images.filter((image) => image.id !== id)
    current.onChange(current.images)
    setFailure(undefined)
  }

  return { add, paste, remove, reading, isReading: () => pending.current > 0, error: failure?.key === key ? failure.message : undefined }
}