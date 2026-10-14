import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { parseChatLink } from '../../shared/chatLinks'
import { MarkdownLink, MarkdownLinks } from './MarkdownLinks'

export function WorkspaceDocument({ source }: { source: string | null }) {
  return <MarkdownLinks><div className="workspace-markdown">
    {source === null ? <p className="muted">Document unavailable</p> : !source.trim() ? <p className="muted">Empty document</p> : <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]} skipHtml urlTransform={(url) => parseChatLink(url) ? url : ''} components={{
      a: ({ children, href }) => <MarkdownLink href={href} className="document-link">{children}</MarkdownLink>,
      img: ({ alt }) => <span className="muted">{alt ?? 'Image'}</span>,
      h1: ({ children }) => <h2>{children}</h2>,
      table: ({ children }) => <div className="document-table"><table>{children}</table></div>,
    }}>{source}</Markdown>}
  </div></MarkdownLinks>
}