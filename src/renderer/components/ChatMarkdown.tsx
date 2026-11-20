import { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { mathRehypePlugins, prepareMarkdownMath } from '../markdownMath'
import { highlightMarkdownCode } from '../markdownSyntax'
import { parseChatLink } from '../../shared/chatLinks'
import { MarkdownCodeBlock, MarkdownTableBlock } from './MarkdownBlocks'
import { MarkdownLink, MarkdownLinks } from './MarkdownLinks'
import '../sessions.css'

const markdownComponents: Components = {
  a: MarkdownLink,
  img: ({ alt, src }) => <MarkdownLink href={src}>{alt || 'Image'}</MarkdownLink>,
  pre: MarkdownCodeBlock,
  table: ({ children }) => <MarkdownTableBlock>{children}</MarkdownTableBlock>,
}
const rehypePlugins = [...mathRehypePlugins, highlightMarkdownCode]

export const ChatMarkdown = memo(function ChatMarkdown({ source }: { source: string }) {
  const math = useMemo(() => prepareMarkdownMath(source), [source])
  return <MarkdownLinks>
    <div className="message-text message-markdown"><Markdown remarkPlugins={[remarkGfm, math.plugin, remarkBreaks]} rehypePlugins={rehypePlugins} skipHtml
      urlTransform={(url) => parseChatLink(url) ? url : ''} components={markdownComponents}>{math.source}</Markdown></div>
  </MarkdownLinks>
})