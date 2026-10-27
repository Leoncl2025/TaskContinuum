import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { parseChatLink } from '../../shared/chatLinks'
import type { OpenChatLinkResult } from '../../shared/chatLinks'
import type { TransferStatus } from '../../shared/fileTransfer'
import { ChatLinkTargetContext } from '../chat/chatLinkContext'
import { ChatFileDialog } from './ChatFileDialog'
import { chatLinkResult } from '../chat/chatLinkResults'
import { copyMarkdownSelection } from '../chat/copyMarkdownSelection'

const LinkActions = createContext<{ open(href: string): void; menu(href: string): void; opening?: string } | undefined>(undefined)

export function MarkdownLink({ href, children, className = 'message-link' }: { href?: string; children?: ReactNode; className?: string }) {
  const actions = useContext(LinkActions)
  if (!href || !parseChatLink(href)) return <span className={className} title="This link type is not supported.">{children}</span>
  return <a className={className} href={href} data-markdown-href={href} title={href} aria-busy={actions?.opening === href}
    onClick={(event) => { event.preventDefault(); actions?.open(href) }}
    onContextMenu={(event) => { event.preventDefault(); actions?.menu(href) }}
    onAuxClick={(event) => { event.preventDefault(); if (event.button === 1) actions?.open(href) }}>{children}</a>
}

export function MarkdownLinks({ children }: { children: ReactNode }) {
  const context = useContext(ChatLinkTargetContext)
  const [opening, setOpening] = useState<string>()
  const [file, setFile] = useState<Extract<OpenChatLinkResult, { kind: 'file' }>>()
  const [error, setError] = useState<string>()
  const running = useRef(false)
  const scope = useRef({ active: false })
  const api = window.desktop?.links
  useEffect(() => {
    const current = { active: true }
    scope.current = current
    return () => { current.active = false; setFile(undefined) }
  }, [])
  const open = useCallback((href: string) => {
    if (running.current) return
    const current = scope.current
    running.current = true
    setOpening(href)
    setError(undefined)
    void (async () => {
      if (!api) throw new Error('Update and open Task Continuum in the desktop app to open links.')
      const result = chatLinkResult(await api.open({ href, requestId: crypto.randomUUID(), ...(context ? { target: context.target } : {}) }))
      if (!current.active) {
        if (result.kind === 'file' && result.status.state === 'transferring') {
          const cancelled = chatLinkResult(await api.cancel({ target: result.target, transferId: result.status.transferId }))
          if (cancelled.error) console.error('Inactive chat file transfer source cleanup failed.')
        }
        return
      }
      if (result.kind === 'file') setFile(result)
    })().catch((failure: unknown) => {
      if (current.active) setError(failure instanceof Error ? failure.message : 'The link could not be opened.')
      else console.error('Inactive chat link operation failed.')
    }).finally(() => { running.current = false; setOpening(undefined) })
  }, [api, context])

  const menu = useCallback((href: string) => {
    setError(undefined)
    if (!api?.contextMenu) { setError('Update the desktop app to copy a link address from its context menu.'); return }
    void api.contextMenu(href).then(chatLinkResult).catch((failure: unknown) => {
      if (scope.current.active) setError(failure instanceof Error ? failure.message : 'The link address could not be copied.')
    })
  }, [api])

  function close(status: TransferStatus): void {
    const selected = file
    setFile(undefined)
    if (!api || !selected || status.state !== 'transferring') return
    void api.cancel({ target: selected.target, transferId: status.transferId }).then((reply) => {
      const cancelled = chatLinkResult(reply)
      if (cancelled.error) setError(cancelled.error.message)
    }).catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : 'The file transfer could not be cancelled.') })
  }

  return <LinkActions.Provider value={{ open, menu, opening }}>
    <div onCopy={(event) => {
      try { copyMarkdownSelection(event) }
      catch { event.preventDefault(); setError('The selected links could not be copied. Try copying a smaller selection or a link address.') }
    }}>{children}</div>
    {opening && <p className="message-notice" role="status">Opening link...</p>}
    {error && <p className="message-notice error" role="alert">{error}</p>}
    {file && api && context?.active !== false && <ChatFileDialog file={file} api={api} onClose={close} />}
  </LinkActions.Provider>
}
