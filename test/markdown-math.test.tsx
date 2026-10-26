import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatMarkdown } from '../src/renderer/components/ChatMarkdown'
import { WorkspaceDocument } from '../src/renderer/components/WorkspaceDocument'
import { bm25Formula, bm25Markdown } from './math-fixture'

describe.each([
  ['chat', ChatMarkdown],
  ['task document', WorkspaceDocument],
] as const)('%s math rendering', (_name, Component) => {
  it('renders the BM25 block and every inline symbol without splitting the document-length cell', () => {
    const view = render(<Component source={bm25Markdown} />)
    expect(view.container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(view.container.querySelector('.katex-display annotation')).toHaveTextContent(bm25Formula.replaceAll('\n', ' '))
    expect(view.container.querySelectorAll('.katex')).toHaveLength(9)
    expect(view.container.querySelectorAll('.katex-error')).toHaveLength(0)
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(9)
    for (const row of rows.slice(1)) expect(within(row).getAllByRole('cell')).toHaveLength(2)
    const length = within(rows[5]).getAllByRole('cell')
    expect(length[0].querySelector('annotation')).toHaveTextContent('|D|')
    expect(length[1]).toHaveTextContent('Document length')
  })

  it('supports dollar and backslash delimiters, GFM table math, and TeX text containing pipes', () => {
    const source = String.raw`Inline $x_1$ and \(y^2\).

$$
\frac{a}{b}
$$

| Symbol | Meaning |
| --- | --- |
| $|D|$ | Absolute |
| $\|D\|$ | Norm |
| \(\text{a|b}\) | Text pipe |
`
    const view = render(<Component source={source} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(6)
    expect(view.container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(view.container.querySelectorAll('.katex-error')).toHaveLength(0)
    for (const row of within(screen.getByRole('table')).getAllByRole('row').slice(1)) {
      expect(within(row).getAllByRole('cell')).toHaveLength(2)
    }
    expect(Array.from(view.container.querySelectorAll('annotation')).map((node) => node.textContent))
      .toContain(String.raw`\text{a|b}`)
  })

  it('preserves literal code, escape sequences, links and ordinary monetary amounts', () => {
    const source = [
      'An inline sample: `' + String.raw`\(x\)` + '`',
      String.raw`Escaped: \\(not math\\). Cost $5 and $10.`,
      '```ts',
      String.raw`const text = "\\[\\frac{a}{b}\\] and $x$";`,
      '```',
      String.raw`[Math docs](https://example.com/path?value=$x$)`,
      String.raw`\(\frac{1}{2}\)`,
    ].join('\n\n')
    const view = render(<Component source={source} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(1)
    expect(view.container.querySelector('pre code')).toHaveTextContent(String.raw`const text = "\\[\\frac{a}{b}\\] and $x$";`)
    expect(view.container).toHaveTextContent('Cost $5 and $10.')
    expect(view.container).toHaveTextContent(String.raw`\(x\)`)
    expect(view.container.querySelectorAll('a')).toHaveLength(0)
  })

  it('updates an incomplete streaming formula without throwing or corrupting following Markdown', () => {
    const partial = String.raw`Before

\[
\frac{f(q,D)`
    const view = render(<Component source={partial} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(0)
    view.rerender(<Component source={`${partial}}{1+b}\n\\]\n\n**After**`} />)
    expect(view.container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(view.container.querySelectorAll('.katex-error')).toHaveLength(0)
    expect(screen.getByText('After').tagName).toBe('STRONG')
    view.rerender(<Component source={String.raw`Inline \(a + `} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(0)
    view.rerender(<Component source={String.raw`Inline \(a + b\).`} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(1)
  })

  it('handles adjacent formulas and code spans without leaking internal markers', () => {
    const source = String.raw`\(x\)\(y\)` + '`code`' + String.raw`\(z\)` + '\n\nLiteral marker: `tc-math-0`.'
    const view = render(<Component source={source} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(3)
    expect(view.container).toHaveTextContent('code')
    expect(view.container.querySelectorAll('code')).toHaveLength(2)
    expect(view.container).not.toHaveTextContent('tc-math--')
  })

  it('renders math in headings, lists, quotes and math fences without modifying ordinary LaTeX code', () => {
    const source = [
      String.raw`### Model \(x_1\)`,
      String.raw`- Value \(y^2\)`,
      String.raw`> \[`,
      String.raw`> \frac{a}{b}`,
      String.raw`> \]`,
      '',
      '```math',
      String.raw`\sum_{q\in Q} q`,
      '```',
      '',
      '```latex',
      String.raw`\[literal\]`,
      '```',
    ].join('\n')
    const view = render(<Component source={source} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(4)
    expect(view.container.querySelectorAll('.katex-error')).toHaveLength(0)
    expect(view.container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(view.container.querySelector('blockquote annotation')).toHaveTextContent(String.raw`\frac{a}{b}`)
    expect(view.container.querySelector('blockquote annotation')).not.toHaveTextContent('>')
    expect(view.container.querySelector('pre code')).toHaveTextContent(String.raw`\[literal\]`)
  })

  it('keeps complete and unfinished code samples literal even near unmatched math delimiters', () => {
    const source = String.raw`Unfinished \[

` + '```ts\n' + String.raw`const closing = "\]";` + '\n```' + String.raw`

After the sample \]`
    const view = render(<Component source={source} />)
    expect(view.container.querySelectorAll('.katex')).toHaveLength(0)
    expect(view.container.querySelector('pre code')).toHaveTextContent(String.raw`const closing = "\]";`)
  })

  it('bounds macro expansion and oversized math without losing subsequent content', () => {
    const view = render(<Component source={String.raw`\(\def\foo{\foo}\foo\)` + '\n\n\\[' + 'x'.repeat(32769) + '\\]\n\n**Still readable**'} />)
    expect(view.container.querySelector('[role="status"].katex-error')).not.toBeNull()
    expect(view.container.querySelector('[role="status"].math-size-error')).not.toBeNull()
    expect(screen.getByText('Still readable')).toBeInTheDocument()
  })

  it('keeps malformed math readable and forbids HTML, link and network injection from TeX', () => {
    const view = render(<Component source={String.raw`\(\frac{a}\)

\(\href{javascript:alert(1)}{click}\)

\(\includegraphics{https://example.com/track.png}\)

\(\htmlClass{unsafe}{x}\)

<script>bad()</script>
`} />)
    expect(view.container.querySelector('.katex-error')).not.toBeNull()
    expect(view.container.querySelector('a, img, script, iframe, .unsafe, [onerror], [src]')).toBeNull()
    expect(view.container).toHaveTextContent(String.raw`\frac{a}`)
  })
})
