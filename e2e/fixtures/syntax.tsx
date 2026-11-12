import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMarkdown } from '../../src/renderer/components/ChatMarkdown'
import { WorkspaceDocument } from '../../src/renderer/components/WorkspaceDocument'
import '@vscode/codicons/dist/codicon.css'
import '../../src/renderer/styles.css'
import '../../src/renderer/workspace.css'

const source = [
  '## Highlighted code',
  'Inline `const value = 42` stays plain. Formula: $x^2$. [Docs](https://example.com).',
  '```js',
  'const script = document.createElement("script");',
  '// Keep the original text, whitespace and copy behavior.',
  'script.type = "text/javascript";',
  'script.src = v9Url;',
  'script.async = true;',
  'document.head.appendChild(script);',
  '```',
  '```ts',
  'interface Entry { name: string; count: number }',
  'const entry: Entry = { name: "test", count: 42 };',
  '```',
  '```powershell',
  '$name = "test"',
  'Write-Output $name',
  '```',
  '```not-a-real-language',
  'This is still readable <script>literal text</script>',
  '```',
  '```js',
  'const longLine = "' + 'x'.repeat(160) + '";',
  '```',
].join('\n\n')

function SyntaxFixture() {
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get('theme') ?? 'light')
  const [streaming, setStreaming] = useState(false)
  const markdown = streaming ? '```js\nconst partial = "still streaming' : source
  return <div className="workbench" data-theme={theme} style={{ overflow: 'auto' }}>
    <nav aria-label="Fixture controls" style={{ padding: 10 }}>
      <button type="button" onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}>Toggle theme</button>
      <button type="button" onClick={() => setStreaming((value) => !value)}>{streaming ? 'Finish streaming' : 'Start streaming'}</button>
    </nav>
    <main style={{ padding: 16, minWidth: 0 }}>
      <section aria-label="Chat code"><ChatMarkdown source={markdown} /></section>
      <section aria-label="Task document code"><WorkspaceDocument source={markdown} /></section>
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(<SyntaxFixture />)
