import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMarkdown } from '../../src/renderer/components/ChatMarkdown'
import { WorkspaceDocument } from '../../src/renderer/components/WorkspaceDocument'
import { bm25Markdown } from '../../test/math-fixture'
import '@vscode/codicons/dist/codicon.css'
import '../../src/renderer/styles.css'
import '../../src/renderer/workspace.css'

function MathFixture() {
  const parameters = new URLSearchParams(location.search)
  const [partial, setPartial] = useState(false)
  const source = partial ? String.raw`\[\frac{a}` : bm25Markdown
  return <div className="workbench" data-theme={parameters.get('theme') ?? 'light'} style={{ overflow: 'auto' }}>
    <nav aria-label="Fixture controls" style={{ padding: 10 }}>
      <button type="button" onClick={() => setPartial((value) => !value)}>{partial ? 'Finish streaming' : 'Start streaming'}</button>
    </nav>
    <main style={{ padding: 16, minWidth: 0 }}>
      <section aria-label="Chat formula"><ChatMarkdown source={source} /></section>
      <section aria-label="Task document formula"><WorkspaceDocument source={source} /></section>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<MathFixture />)
