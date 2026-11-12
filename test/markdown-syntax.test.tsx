import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from '../src/renderer/components/ChatMarkdown'
import { WorkspaceDocument } from '../src/renderer/components/WorkspaceDocument'

describe.each([
  ['chat', ChatMarkdown],
  ['task document', WorkspaceDocument],
] as const)('%s syntax highlighting', (_name, Component) => {
  it.each([
    ['js', 'const script = document.createElement("script");\nscript.async = true;', 'const', '"script"'],
    ['ts', 'interface Entry { name: string }\nconst value: Entry = { name: "test" };', 'interface', '"test"'],
    ['tsx', 'const App = () => <button title="test">Open</button>;', 'const', '"test"'],
    ['python', 'def hello(name):\n    return "Hello " + name', 'def', '"Hello "'],
    ['csharp', 'public class Entry { public string Name = "test"; }', 'public', '"test"'],
    ['cpp', 'const char* name = "test";', 'const', '"test"'],
    ['powershell', '$name = "test"\nWrite-Output $name', 'Write-Output', '"test"'],
    ['json', '{ "name": "test", "count": 42 }', '"name"', '"test"'],
    ['bash', 'echo "test"\n# Keep this comment', 'echo', '"test"'],
    ['sql', "SELECT name FROM tasks WHERE state = 'done';", 'SELECT', "'done'"],
    ['yaml', 'name: test\ncount: 42', 'name:', '42'],
    ['html', '<script>const text = "<safe>";</script>', 'script', '"<safe>"'],
  ])('highlights %s code while preserving every source character', (language, source, firstToken, secondToken) => {
    const view = render(<Component source={'```' + language + '\n' + source + '\n```'} />)
    const code = view.container.querySelector('pre code')!
    expect(code).toHaveClass('hljs', `language-${language}`)
    expect(code.textContent).toBe(source + '\n')
    const tokens = Array.from(code.querySelectorAll('span')).map((element) => element.textContent)
    expect(tokens).toContain(firstToken)
    expect(tokens).toContain(secondToken)
    expect(view.container.querySelector('script, img, iframe, [onerror]')).toBeNull()
  })

  it('keeps inline, unlabeled, text and unsupported-language code readable without language guessing', () => {
    const source = 'const value = "<safe>";'
    const view = render(<Component source={[
      '`inline code`',
      '```\n' + source + '\n```',
      '```text\n' + source + '\n```',
      '```not-a-real-language\n' + source + '\n```',
    ].join('\n\n')} />)
    expect(screen.getByText('inline code').tagName).toBe('CODE')
    const blocks = view.container.querySelectorAll('pre code')
    expect(blocks).toHaveLength(3)
    for (const code of blocks) {
      expect(code.textContent).toBe(source + '\n')
      expect(code.querySelector('span')).toBeNull()
    }
    expect(view.container.querySelector('code:not(pre code) span')).toBeNull()
  })

  it('updates incomplete streaming code without duplicating text or interpreting its markup', () => {
    const partial = '```js\nconst text = "<script>'
    const view = render(<Component source={partial} />)
    expect(view.container.querySelector('pre code')).toHaveClass('hljs')
    expect(view.container.querySelector('pre code')?.textContent).toBe('const text = "<script>\n')
    view.rerender(<Component source={partial + 'still literal</script>";\nconsole.log(text);\n```\n\n**After**'} />)
    expect(view.container.querySelectorAll('pre')).toHaveLength(1)
    expect(view.container.querySelector('pre code')?.textContent).toBe('const text = "<script>still literal</script>";\nconsole.log(text);\n')
    expect(screen.getByText('After').tagName).toBe('STRONG')
    expect(view.container.querySelector('script')).toBeNull()
  })

  it('bounds highlighting at 65,536 characters without truncating oversized code', () => {
    const source = '// ' + 'x'.repeat(65_532)
    const view = render(<Component source={'```js\n' + source + '\n```'} />)
    expect(view.container.querySelector('pre code')).toHaveClass('hljs')
    view.rerender(<Component source={'```js\n' + source + 'x\n```'} />)
    const code = view.container.querySelector('pre code')!
    expect(code).not.toHaveClass('hljs')
    expect(code.querySelector('span')).toBeNull()
    expect(code.textContent).toBe(source + 'x\n')
    expect(code).toHaveAttribute('title', expect.stringContaining('65,536'))
    expect(code).toHaveAttribute('data-syntax-highlight', 'skipped-size')
  })
})

it('copies exact source from nested highlighted tokens, including blank lines, Unicode and punctuation', async () => {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const source = 'const text = "你好 <script>";\n\n// Keep spacing and newlines\nconsole.log(`${text}: 42`);'
  const view = render(<ChatMarkdown source={'```js\n' + source + '\n```'} />)
  expect(view.container.querySelector('.hljs-string')).not.toBeNull()
  await user.click(screen.getByRole('button', { name: 'Copy code' }))
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(source + '\n')
  expect(screen.getByRole('button', { name: 'Code copied' })).toBeVisible()
  expect(view.container.querySelector('.message-code-header')).toHaveTextContent('js')
  view.rerender(<ChatMarkdown source={'```js\nconst updated = 43;\n```'} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
  await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith('const updated = 43;\n'))
})
