import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from '../src/renderer/components/ChatMarkdown'

afterEach(() => { delete window.desktop })

describe('native chat Markdown presentation', () => {
  it('renders Markdown, tables and partial code as updated response text arrives', () => {
    const source = '## Results\n\n**Verified** with *care* and `npm test`.\n\n1. First step\n2. Next step\n\n- [x] Complete\n- [ ] Pending\n\n> Review note\n\n| Check | Result |\n| --- | --- |\n| Build | Pass |\n\n```ts\nconst value = "<safe>";\n```'
    const view = render(<ChatMarkdown source={source} />)
    expect(screen.getByRole('heading', { name: 'Results', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Verified').tagName).toBe('STRONG')
    expect(screen.getByText('care').tagName).toBe('EM')
    expect(screen.getByText('npm test').tagName).toBe('CODE')
    expect(screen.getByRole('table')).toHaveTextContent('BuildPass')
    expect(screen.getByLabelText('Code block')).toHaveTextContent('const value = "<safe>";')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled()
    view.rerender(<ChatMarkdown source={'### Updated\n\n```ts\nconst partial = 1'} />)
    expect(screen.getByRole('heading', { name: 'Updated', level: 3 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Results' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Code block')).toHaveTextContent('const partial = 1')
  })

  it('never turns message HTML, links or images into executable or network content', () => {
    const source = '**Safe text**\n\n[Docs](https://example.com) [Run](command:workbench.action.closeWindow) [Script](javascript:alert%281%29) [File](file:///C:/secret)\n\n![Remote picture](https://example.com/track.png)\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n```html\n<script>not executable</script>\n```'
    const view = render(<ChatMarkdown source={source} />)
    expect(screen.getByText('Safe text')).toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByText('Run')).toBeInTheDocument()
    expect(screen.getByText('Remote picture')).toBeInTheDocument()
    expect(view.container.querySelector('a, img, script, iframe, [href], [src], [onerror]')).toBeNull()
    expect(screen.getByLabelText('Code block')).toHaveTextContent('<script>not executable</script>')
  })

  it('copies only code text, reports clipboard failures and retains the desktop copy path', async () => {
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const view = render(<ChatMarkdown source={'```ts\nconst answer = 42;\n```'} />)
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(write).toHaveBeenCalledExactlyOnceWith('const answer = 42;\n')
    expect(screen.getByRole('button', { name: 'Code copied' })).toBeInTheDocument()
    view.rerender(<ChatMarkdown source={'```ts\nconst updated = 43;\n```'} />)
    write.mockRejectedValueOnce(new Error('Denied'))
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByText('Code could not be copied.')).toBeInTheDocument()
    expect(screen.getByLabelText('Code block')).toHaveTextContent('const updated = 43;')
    const copyText = vi.fn(async () => {})
    window.desktop = { copyText, getInfo: vi.fn(), close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn() }
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(copyText).toHaveBeenCalledExactlyOnceWith('const updated = 43;\n')
    expect(write).toHaveBeenCalledTimes(2)
  })
})
