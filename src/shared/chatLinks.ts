import type { AgentHostTarget } from './agentHost'
import type { ChatImageAttachment } from './chatAttachments'
import type { FilePage, TransferErrorCode, TransferStatus } from './fileTransfer'

export type ChatLink = { kind: 'external'; url: string } | {
  kind: 'file'; path: string; relative: boolean; line?: number; column?: number
}
export type ChatLinkReply<T> = { ok: true; result: T } | {
  ok: false; error: { code: TransferErrorCode; message: string }
}
export interface OpenChatLinkRequest {
  href: string
  requestId: string
  target?: AgentHostTarget
}
export interface ChatFileRequest {
  target: AgentHostTarget
  transferId: string
}
export interface ChatFilePreviewRequest extends ChatFileRequest {
  fileId: string
  offset?: number
  maxBytes?: number
}
export interface ChatFileSaveRequest extends ChatFilePreviewRequest {
  openAfterSave?: boolean
}
export type ChatFilePreview = { kind: 'text'; page: FilePage } | { kind: 'image'; image: ChatImageAttachment }
export type OpenChatLinkResult = { kind: 'external' } | {
  kind: 'file'; target: AgentHostTarget; status: TransferStatus; line?: number; column?: number
}
export interface ChatLinkBridge {
  open(request: OpenChatLinkRequest): Promise<ChatLinkReply<OpenChatLinkResult>>
  status(request: ChatFileRequest): Promise<ChatLinkReply<TransferStatus>>
  preview(request: ChatFilePreviewRequest): Promise<ChatLinkReply<ChatFilePreview>>
  save(request: ChatFileSaveRequest): Promise<ChatLinkReply<{ saved: boolean; opened?: boolean }>>
  cancel(request: ChatFileRequest): Promise<ChatLinkReply<TransferStatus>>
  contextMenu?(href: string): Promise<ChatLinkReply<{ copied: boolean }>>
}

export function canOpenChatDocument(name: string): boolean {
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)
    && /\.(txt|log|md|markdown|json|pdf|png|jpe?g|gif|webp)$/i.test(name)
}

function fileLink(path: string, fragment = ''): ChatLink | undefined {
  if (!path || path.length > 4096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(path) || /^[\\/]{2}/.test(path)) return
  let line: number | undefined
  let column: number | undefined
  const suffix = /:([1-9][0-9]{0,6})(?::([1-9][0-9]{0,6}))?$/.exec(path)
  if (suffix) {
    path = path.slice(0, -suffix[0].length)
    line = Number(suffix[1])
    column = suffix[2] ? Number(suffix[2]) : undefined
  }
  if (!path) return
  const location = /^#L([1-9][0-9]{0,6})(?:C([1-9][0-9]{0,6}))?$/.exec(fragment)
  if (location) { line = Number(location[1]); column = location[2] ? Number(location[2]) : undefined }
  const absolute = /^[a-z]:[\\/]/i.test(path) || path.startsWith('/')
  if (!absolute && (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('?'))) return
  return { kind: 'file', path, relative: !absolute, ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

export function parseChatLink(value: string): ChatLink | undefined {
  if (!value || value.length > 8192 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return
  const href = value.trim()
  if (!href || href.startsWith('#') || href.startsWith('\\\\')) return
  try {
    if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
      const url = new URL(href.startsWith('//') ? `https:${href}` : href)
      if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return
      return { kind: 'external', url: url.href }
    }
    if (/^file:/i.test(href)) {
      if (!href.slice(5).startsWith('/') && !/^[a-z]:[\\/]/i.test(href.slice(5))) return
      const url = new URL(href)
      if (url.hostname && url.hostname !== 'localhost' || url.username || url.password || url.port || url.search) return
      let path = decodeURIComponent(url.pathname)
      if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1).replaceAll('/', '\\')
      const parsed = fileLink(path, url.hash)
      return parsed?.kind === 'file' && !parsed.relative ? parsed : undefined
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return
    const hash = href.indexOf('#')
    return fileLink(decodeURIComponent(hash < 0 ? href : href.slice(0, hash)), hash < 0 ? '' : href.slice(hash))
  } catch { return undefined }
}
