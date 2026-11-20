import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { ExtraProps } from 'react-markdown'
import { markdownCodeText } from '../markdownSyntax'
import { Dialog, Icon, IconButton } from './Primitives'
import '../sessions.css'

interface InlineBox {
  width: number
  marginLeft: number
}

function measureInlineBox(anchor: HTMLElement | null): InlineBox | undefined {
  if (!anchor || anchor.closest('.ahp-activity')) return undefined
  const container = anchor.closest<HTMLElement>('.chat-log, .task-document')
  if (!container || container.clientWidth <= 0) return undefined
  const containerRect = container.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  if (anchorRect.width <= 0) return undefined
  const gutter = container.clientWidth >= 1100 ? 24 : 16
  const width = Math.floor(container.clientWidth - gutter * 2)
  if (width <= anchorRect.width + 24) return undefined
  const marginLeft = Math.round(containerRect.left + container.clientLeft + gutter - anchorRect.left)
  return { width, marginLeft }
}

async function writeClipboard(text: string): Promise<void> {
  if (window.desktop) {
    await window.desktop.copyText(text)
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
  await navigator.clipboard.writeText(text)
}

function extractTableText(table: HTMLTableElement | null): string {
  if (!table) return ''
  return Array.from(table.querySelectorAll('tr'))
    .map((row) => Array.from(row.querySelectorAll('th, td'))
      .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join('\t'))
    .join('\n')
}

function useExpandableBlock(anchorRef: RefObject<HTMLDivElement | null>) {
  const [inlineExpanded, setInlineExpanded] = useState(false)
  const [inlineBox, setInlineBox] = useState<InlineBox>()
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (!inlineExpanded) return
    const anchor = anchorRef.current
    const container = anchor?.closest<HTMLElement>('.chat-log, .task-document')
    if (!anchor || !container) return
    let frame: number | undefined
    const sync = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const next = measureInlineBox(anchor)
        setInlineBox((prior) => prior?.width === next?.width && prior?.marginLeft === next?.marginLeft ? prior : next)
      })
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined
    observer?.observe(container)
    observer?.observe(anchor)
    window.addEventListener('resize', sync)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', sync)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [anchorRef, inlineExpanded])

  function toggle(): void {
    if (inlineExpanded) {
      setInlineExpanded(false)
      setInlineBox(undefined)
      return
    }
    if (modalOpen) {
      setModalOpen(false)
      return
    }
    const anchor = anchorRef.current
    const container = anchor?.closest<HTMLElement>('.chat-log, .task-document')
    if (!container || container.clientWidth <= 0) {
      setInlineExpanded(true)
      return
    }
    const measured = measureInlineBox(anchor)
    if (measured && anchor && measured.width > anchor.getBoundingClientRect().width + 48) {
      setInlineBox(measured)
      setInlineExpanded(true)
    } else {
      setModalOpen(true)
    }
  }

  const style: CSSProperties | undefined = inlineExpanded && inlineBox
    ? { width: `${inlineBox.width}px`, maxWidth: 'none', marginLeft: `${inlineBox.marginLeft}px` }
    : undefined

  return { inlineExpanded, modalOpen, setModalOpen, toggle, style }
}

export function MarkdownCodeBlock({ children, node }: ExtraProps & { children?: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const code = node?.children[0]
  const source = code?.type === 'element' ? markdownCodeText(code) : ''
  const classNames = code?.type === 'element' ? code.properties.className : undefined
  const languageClass = Array.isArray(classNames) ? classNames.find((name) => typeof name === 'string' && name.startsWith('language-')) : undefined
  const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length) : 'Code'
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<{ source: string; copied: boolean }>()
  const copied = result?.source === source && result.copied
  const expand = useExpandableBlock(anchorRef)
  const active = expand.inlineExpanded || expand.modalOpen

  async function copy(): Promise<void> {
    setCopying(true)
    try {
      await writeClipboard(source)
      setResult({ source, copied: true })
    } catch {
      setResult({ source, copied: false })
    } finally {
      setCopying(false)
    }
  }

  return <div ref={anchorRef} className="markdown-block-anchor" data-expanded={expand.inlineExpanded || undefined}>
    <div className={`message-code-block${expand.inlineExpanded ? ' is-expanded' : ''}`} style={expand.style}>
      <div className="message-code-header markdown-card-header">
        <span className="markdown-card-label"><Icon name="code" /><span>{language}</span></span>
        <div className="markdown-card-actions">
          <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Code copied' : 'Copy code'} disabled={copying || !source} onClick={() => { void copy() }} />
          <button type="button" className="markdown-expand-button" data-active={active || undefined}
            aria-label={active ? 'Restore code width' : 'Expand code width'}
            title={active ? 'Restore default width' : 'Expand to full width'}
            aria-pressed={expand.inlineExpanded}
            onClick={expand.toggle}>
            <Icon name={active ? 'screen-normal' : 'screen-full'} />
            <span>{active ? 'Compact' : 'Full width'}</span>
          </button>
        </div>
      </div>
      <pre tabIndex={0} aria-label="Code block">{children}</pre>
      {result?.source === source && !result.copied && <p className="message-code-error" role="status">Code could not be copied.</p>}
    </div>
    {expand.modalOpen && <Dialog title={language === 'Code' ? 'Code' : `Code · ${language}`} className="markdown-expand-dialog" onClose={() => expand.setModalOpen(false)}>
      <div className="markdown-expand-dialog-toolbar">
        <button type="button" className="secondary-button" disabled={copying || !source} onClick={() => { void copy() }}>
          <Icon name={copied ? 'check' : 'copy'} /><span>{copied ? 'Copied' : 'Copy code'}</span>
        </button>
      </div>
      <div className="message-markdown markdown-expand-dialog-body">
        <div className="message-code-block is-expanded">
          <pre tabIndex={0} aria-label="Expanded code">{children}</pre>
        </div>
      </div>
    </Dialog>}
  </div>
}

export function MarkdownTableBlock({ children, variant = 'chat' }: { children?: ReactNode; variant?: 'chat' | 'document' }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [copying, setCopying] = useState(false)
  const [copiedState, setCopiedState] = useState<'copied' | 'failed'>()
  const expand = useExpandableBlock(anchorRef)
  const active = expand.inlineExpanded || expand.modalOpen

  async function copy(): Promise<void> {
    const text = extractTableText(tableRef.current)
    if (!text) return
    setCopying(true)
    try {
      await writeClipboard(text)
      setCopiedState('copied')
    } catch {
      setCopiedState('failed')
    } finally {
      setCopying(false)
    }
  }

  return <div ref={anchorRef} className="markdown-block-anchor" data-expanded={expand.inlineExpanded || undefined}>
    <div className={`markdown-table-card ${variant === 'document' ? 'document-table' : 'message-table'}${expand.inlineExpanded ? ' is-expanded' : ''}`} style={expand.style}>
      <div className="markdown-card-header">
        <span className="markdown-card-label"><Icon name="table" /><span>Table</span></span>
        <div className="markdown-card-actions">
          <IconButton icon={copiedState === 'copied' ? 'check' : 'copy'} label={copiedState === 'copied' ? 'Table copied' : 'Copy table'} disabled={copying} onClick={() => { void copy() }} />
          <button type="button" className="markdown-expand-button" data-active={active || undefined}
            aria-label={active ? 'Restore table width' : 'Expand table width'}
            title={active ? 'Restore default width' : 'Expand to full width'}
            aria-pressed={expand.inlineExpanded}
            onClick={expand.toggle}>
            <Icon name={active ? 'screen-normal' : 'screen-full'} />
            <span>{active ? 'Compact' : 'Full width'}</span>
          </button>
        </div>
      </div>
      <div className="markdown-table-scroll" role="region" aria-label={variant === 'document' ? 'Document table' : 'Message table'} tabIndex={0}>
        <table ref={tableRef}>{children}</table>
      </div>
      {copiedState === 'failed' && <p className="message-code-error" role="status">Table could not be copied.</p>}
    </div>
    {expand.modalOpen && <Dialog title="Table" className="markdown-expand-dialog" onClose={() => expand.setModalOpen(false)}>
      <div className="markdown-expand-dialog-toolbar">
        <button type="button" className="secondary-button" disabled={copying} onClick={() => { void copy() }}>
          <Icon name={copiedState === 'copied' ? 'check' : 'copy'} /><span>{copiedState === 'copied' ? 'Copied' : 'Copy table'}</span>
        </button>
      </div>
      <div className="message-markdown markdown-expand-dialog-body">
        <div className="markdown-table-card is-expanded">
          <div className="markdown-table-scroll" role="region" aria-label="Expanded table" tabIndex={0}>
            <table>{children}</table>
          </div>
        </div>
      </div>
    </Dialog>}
  </div>
}
