import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chatImageAttachmentsSchema, chatImageReferencesSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment, ChatImageReference } from '../shared/chatAttachments'

export interface ChatImageFile { path: string; name: string }

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const
const storageLimit = 256 * 1024 * 1024

export function describeChatImages(images: ChatImageAttachment[]): ChatImageReference[] {
  return chatImageAttachmentsSchema.parse(images).map(({ data, ...image }) => {
    const bytes = Buffer.from(data, 'base64')
    return { ...image, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }
  })
}

export class ChatImageStore {
  constructor(private readonly directory: string) {}

  files(images: ChatImageReference[]): ChatImageFile[] {
    return chatImageReferencesSchema.parse(images).map((image) => ({ path: join(this.directory, `${image.sha256}.${extensions[image.mimeType]}`), name: image.name }))
  }

  async store(images: ChatImageAttachment[]): Promise<ChatImageReference[]> {
    const references = describeChatImages(images)
    if (!references.length) return references
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('The private image directory must not be a symbolic link.')
    let used = 0
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error('Unexpected entry in the private image directory.')
      used += (await lstat(join(this.directory, entry.name))).size
    }
    const files = this.files(references)
    for (const [index, file] of files.entries()) {
      const bytes = Buffer.from(images[index].data, 'base64')
      const existing = await lstat(file.path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || !(await readFile(file.path)).equals(bytes)) throw new Error('A stored image failed its integrity check.')
        continue
      }
      if (used + bytes.length > storageLimit) throw new Error('Private chat images have reached the 256 MiB storage limit.')
      const handle = await open(file.path, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      used += bytes.length
    }
    return references
  }

  async read(images: ChatImageReference[]): Promise<ChatImageAttachment[]> {
    const files = this.files(images)
    return Promise.all(images.map(async (image, index) => {
      const file = files[index]
      const info = await lstat(file.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== image.byteLength) throw new Error('The stored chat image is unavailable.')
      const bytes = await readFile(file.path)
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('A stored image failed its integrity check.')
      return { id: image.id, name: image.name, mimeType: image.mimeType, data: bytes.toString('base64') }
    }))
  }
}