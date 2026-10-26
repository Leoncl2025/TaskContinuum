import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { mathRehypePlugins, prepareMarkdownMath } from '../markdownMath'

export function WorkspaceDocument({ source }: { source: string | null }) {
  const math = useMemo(() => prepareMarkdownMath(source ?? ''), [source])
  return <div className="workspace-markdown">
    {source === null ? <p className="muted">Document unavailable</p> : !source.trim() ? <p className="muted">Empty document</p> : <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter, math.plugin]} rehypePlugins={mathRehypePlugins} skipHtml urlTransform={() => ''} components={{
      a: ({ children }) => <span className="document-link">{children}</span>,
      img: ({ alt }) => <span className="muted">{alt ?? 'Image'}</span>,
      h1: ({ children }) => <h2>{children}</h2>,
      table: ({ children }) => <div className="document-table"><table>{children}</table></div>,
    }}>{math.source}</Markdown>}
  </div>
}