import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconButton } from './Primitives'
import '../sessions.css'

function ChatCodeBlock({ children, node }: ExtraProps & { children?: ReactNode }) {
  const code = node?.children[0]
  const source = code?.type === 'element' ? code.children.flatMap((child) => child.type === 'text' ? [child.value] : []).join('') : ''
  const classNames = code?.type === 'element' ? code.properties.className : undefined
  const languageClass = Array.isArray(classNames) ? classNames.find((name) => typeof name === 'string' && name.startsWith('language-')) : undefined
  const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length) : 'Code'
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<{ source: string; copied: boolean }>()
  const copied = result?.source === source && result.copied
  async function copy(): Promise<void> {
    setCopying(true)
    try {
      if (window.desktop) await window.desktop.copyText(source)
      else {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
        await navigator.clipboard.writeText(source)
      }
      setResult({ source, copied: true })
    } catch { setResult({ source, copied: false }) } finally { setCopying(false) }
  }
  return <div className="message-code-block">
    <div className="message-code-header"><span>{language}</span><IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Code copied' : 'Copy code'} disabled={copying || !source} onClick={() => { void copy() }} /></div>
    <pre tabIndex={0} aria-label="Code block">{children}</pre>
    {result?.source === source && !result.copied && <p className="message-code-error" role="status">Code could not be copied.</p>}
  </div>
}

export const ChatMarkdown = memo(function ChatMarkdown({ source }: { source: string }) {
  return <div className="message-text message-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={() => ''} components={{
    a: ({ children }) => <span className="message-link">{children}</span>,
    img: ({ alt }) => <span className="muted">{alt || 'Image'}</span>,
    pre: ChatCodeBlock,
    table: ({ children }) => <div className="message-table" role="region" aria-label="Message table" tabIndex={0}><table>{children}</table></div>,
  }}>{source}</Markdown></div>
})