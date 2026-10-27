import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatMarkdown } from '../src/renderer/components/ChatMarkdown'
import { WorkspaceDocument } from '../src/renderer/components/WorkspaceDocument'
import { copyMarkdownSelection } from '../src/renderer/chat/copyMarkdownSelection'

afterEach(() => { window.getSelection()?.removeAllRanges() })

function select(node: Node, start?: number, end?: number): void {
  const range = document.createRange()
  if (start !== undefined && end !== undefined) { range.setStart(node, start); range.setEnd(node, end) }
  else range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function copy(element: Element): Map<string, string> {
  const data = new Map<string, string>()
  fireEvent.copy(element, { clipboardData: { setData: (type: string, value: string) => data.set(type, value) } })
  return data
}

describe('copying displayed hyperlinks', () => {
  it.each([['chat', ChatMarkdown], ['task document', WorkspaceDocument]] as const)('keeps URL and original server-file destinations when copying %s content', (_name, Component) => {
    const view = render(<Component source={'Before [PR **42**](https://example.com/pull/42?q=x#discussion)\n\n[Report](file:///C:/Owner%20Work/report.md:24)\n\nAfter'} />)
    const markdown = view.container.querySelector('.message-markdown, .workspace-markdown')!
    select(markdown)
    const data = copy(screen.getByRole('link', { name: 'PR 42' }))
    expect(data.get('text/plain')).toContain('[PR 42](<https://example.com/pull/42?q=x#discussion>)')
    expect(data.get('text/plain')).toContain('[Report](<file:///C:/Owner%20Work/report.md:24>)')
    expect(data.get('text/plain')).toContain('Before')
    expect(data.get('text/plain')).toContain('After')
    expect(data.get('text/html')).toContain('href="https://example.com/pull/42?q=x#discussion"')
    expect(data.get('text/html')).toContain('<strong>42</strong>')
    expect(data.get('text/html')).not.toContain('data-markdown-href')
    expect(data.get('text/plain')).not.toContain('file-transfer-inbox')
  })

  it('preserves a link when only part of its caption is selected', () => {
    render(<ChatMarkdown source={'[Remote report](./docs/report.md#L12)'} />)
    const link = screen.getByRole('link', { name: 'Remote report' })
    select(link.firstChild!, 7, 13)
    const data = copy(link)
    expect(data.get('text/plain')).toBe('[report](<./docs/report.md#L12>)')
    expect(data.get('text/html')).toBe('<a href="./docs/report.md#L12">report</a>')
  })

  it('copies links across multiple response blocks through the conversation copy handler', () => {
    const view = render(<div role="log" onCopy={copyMarkdownSelection}>
      <ChatMarkdown source={'First [issue](https://example.com/issue/1)'} />
      <ChatMarkdown source={'Second [source](C:/Server/code.cs)'} />
    </div>)
    const log = screen.getByRole('log')
    select(log)
    const data = copy(log)
    expect(data.get('text/plain')).toContain('[issue](<https://example.com/issue/1>)')
    expect(data.get('text/plain')).toContain('[source](<C:/Server/code.cs>)')
    expect(view.container.querySelectorAll('a')).toHaveLength(2)
  })

  it('retains formulas and code text without copying UI controls or internal math markers', () => {
    const source = String.raw`Formula \(\frac{a}{b}\) and [docs](https://example.com).

` + '```ts\nconst value = "<script>literal</script>";\n```'
    const view = render(<ChatMarkdown source={source} />)
    const markdown = view.container.querySelector('.message-markdown')!
    select(markdown)
    const data = copy(screen.getByRole('link', { name: 'docs' }))
    expect(data.get('text/plain')).toContain(String.raw`\(\frac{a}{b}\)`)
    expect(data.get('text/plain')).toContain('const value = "<script>literal</script>";')
    expect(data.get('text/plain')).not.toContain('Copy code')
    expect(data.get('text/plain')).not.toContain('tc-math-')
    const html = document.createElement('div')
    html.innerHTML = data.get('text/html')!
    expect(html.querySelector('script, button, [onclick], [style]')).toBeNull()
    expect(html.querySelectorAll('a')).toHaveLength(1)
  })

  it('does not override native copying of ordinary text or code without hyperlinks', () => {
    const view = render(<ChatMarkdown source={'Plain text\n\n```text\n[not a rendered link](https://example.com)\n```'} />)
    select(view.container)
    expect(copy(screen.getByText('Plain text')).size).toBe(0)
    const code = screen.getByLabelText('Code block')
    select(code)
    expect(copy(code).size).toBe(0)
  })
})
