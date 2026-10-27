import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from '../src/renderer/components/ChatMarkdown'
import { ChatLinkTargetContext } from '../src/renderer/chat/chatLinkContext'
import type { ChatLinkBridge, ChatLinkReply, OpenChatLinkResult } from '../src/shared/chatLinks'
import type { TransferStatus } from '../src/shared/fileTransfer'
import { agentHostTargetFixture } from './immutable-bindings-fixture'
import { WorkspaceDocument } from '../src/renderer/components/WorkspaceDocument'

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

  it('allows explicit safe link clicks without executing HTML or loading images automatically', () => {
    const source = '**Safe text**\n\n[Docs](https://example.com) [Run](command:workbench.action.closeWindow) [Script](javascript:alert%281%29) [File](file:///C:/secret)\n\n![Remote picture](https://example.com/track.png)\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n```html\n<script>not executable</script>\n```'
    const view = render(<ChatMarkdown source={source} />)
    expect(screen.getByText('Safe text')).toBeInTheDocument()
    expect(screen.getByText('Docs')).toBeInTheDocument()
    expect(screen.getByText('Run')).toBeInTheDocument()
    expect(screen.getByText('Remote picture')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByRole('link', { name: 'File' })).toHaveAttribute('href', 'file:///C:/secret')
    expect(screen.getByRole('link', { name: 'Remote picture' })).toHaveAttribute('href', 'https://example.com/track.png')
    expect(screen.queryByRole('link', { name: 'Run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Script' })).not.toBeInTheDocument()
    expect(view.container.querySelector('img, script, iframe, [src], [onerror]')).toBeNull()
    expect(screen.getByLabelText('Code block')).toHaveTextContent('<script>not executable</script>')
  })

  it('opens a web link only on an explicit click and shares the behavior with task documents', async () => {
    const api = installLinks()
    const user = userEvent.setup()
    const view = render(<ChatMarkdown source={'[PR](https://example.com/pull/42)'} />)
    expect(api.open).not.toHaveBeenCalled()
    await user.click(screen.getByRole('link', { name: 'PR' }))
    await waitFor(() => expect(api.open).toHaveBeenCalledExactlyOnceWith({ href: 'https://example.com/pull/42', requestId: expect.any(String) }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(<WorkspaceDocument source={'[Issue](https://example.com/issues/12)'} />)
    await user.click(screen.getByRole('link', { name: 'Issue' }))
    await waitFor(() => expect(api.open).toHaveBeenLastCalledWith({ href: 'https://example.com/issues/12', requestId: expect.any(String) }))
  })

  it('requests the client context menu with the original file URL instead of opening it', async () => {
    const api = installLinks()
    api.contextMenu = vi.fn<NonNullable<ChatLinkBridge['contextMenu']>>(async () => ({ ok: true, result: { copied: true } }))
    render(<ChatMarkdown source={'[Report](file:///C:/Server/report.txt:24)'} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Report' }))
    await waitFor(() => expect(api.contextMenu).toHaveBeenCalledExactlyOnceWith('file:///C:/Server/report.txt:24'))
    expect(api.open).not.toHaveBeenCalled()
    expect(api.preview).not.toHaveBeenCalled()
  })

  it('opens a delivered local document only on the explicit save-and-open action', async () => {
    const target = agentHostTargetFixture('native-open')
    const status = delivered()
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: true, result: { kind: 'file', target, status } })
    vi.mocked(api.preview).mockResolvedValue({ ok: true, result: {
      kind: 'text', page: { fileId: status.files[0].fileId, text: 'Report', offset: 0, nextOffset: 6, eof: true, truncated: false },
    } })
    vi.mocked(api.save).mockResolvedValue({ ok: true, result: { saved: true, opened: true } })
    const user = userEvent.setup()
    render(<ChatLinkTargetContext.Provider value={{ target, active: true }}><ChatMarkdown source={'[Report](file:///C:/Server/report.txt)'} /></ChatLinkTargetContext.Provider>)
    await user.click(screen.getByRole('link', { name: 'Report' }))
    const dialog = await screen.findByRole('dialog', { name: 'report.txt' })
    expect(api.save).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Save and open locally' }))
    expect(await within(dialog).findByText('Local copy opened on this device.')).toBeInTheDocument()
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ target, transferId: status.transferId, fileId: status.files[0].fileId, openAfterSave: true })
  })

  it('uses the exact source target for files and preserves an open preview through streaming updates', async () => {
    const target = agentHostTargetFixture('linked-report')
    const status = delivered()
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: true, result: { kind: 'file', target, status, line: 2 } })
    vi.mocked(api.preview).mockResolvedValue({ ok: true, result: {
      kind: 'text', page: { fileId: status.files[0].fileId, text: 'First line\n<script>not executed</script>', offset: 0, nextOffset: status.files[0].sizeBytes, eof: true, truncated: false },
    } })
    const user = userEvent.setup()
    const context = { target, active: true }
    const body = (source: string) => <ChatLinkTargetContext.Provider value={context}><ChatMarkdown source={source} /></ChatLinkTargetContext.Provider>
    const view = render(body('[Report](file:///C:/Work/report.txt:2)'))
    await user.click(screen.getByRole('link', { name: 'Report' }))
    const dialog = await screen.findByRole('dialog', { name: 'report.txt' })
    expect(await within(dialog).findByLabelText('Received file content')).toHaveTextContent('<script>not executed</script>')
    expect(dialog.querySelector('script')).toBeNull()
    expect(dialog.querySelector('.chat-file-line-target')).toHaveTextContent('<script>not executed</script>')
    expect(api.open).toHaveBeenCalledExactlyOnceWith({ href: 'file:///C:/Work/report.txt:2', target, requestId: expect.any(String) })
    view.rerender(body('[Report](file:///C:/Work/report.txt:2)\n\nMore streamed output.'))
    expect(screen.getByRole('dialog', { name: 'report.txt' })).toBe(dialog)
    expect(api.open).toHaveBeenCalledOnce()
    expect(api.preview).toHaveBeenCalledExactlyOnceWith({ target, transferId: status.transferId, fileId: status.files[0].fileId })
    await user.click(within(dialog).getByRole('button', { name: 'Save local copy' }))
    expect(await within(dialog).findByText('Local copy saved.')).toBeInTheDocument()
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ target, transferId: status.transferId, fileId: status.files[0].fileId })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('reports unavailable desktop support and file failures without falling back to a local path or navigating', async () => {
    const user = userEvent.setup()
    const view = render(<ChatMarkdown source={'[File](file:///C:/Work/report.txt)'} />)
    await user.click(screen.getByRole('link', { name: 'File' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Update and open Task Continuum')
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: false, error: { code: 'ACCESS_DENIED', message: 'The original device is not authorized.' } })
    view.rerender(<ChatMarkdown source={'[File](file:///C:/Work/report.txt)\n\nNew output'} />)
    await user.click(screen.getByRole('link', { name: 'File' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('original device is not authorized')
    expect(api.preview).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('prevents duplicate opens while pending and does not open a file dialog after the original view closes', async () => {
    const target = agentHostTargetFixture('pending-file')
    const api = installLinks()
    let finish!: (reply: ChatLinkReply<OpenChatLinkResult>) => void
    vi.mocked(api.open).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const user = userEvent.setup()
    const view = render(<ChatLinkTargetContext.Provider value={{ target, active: true }}><ChatMarkdown source={'[File](file:///C:/Work/report.txt)'} /></ChatLinkTargetContext.Provider>)
    const link = screen.getByRole('link', { name: 'File' })
    await user.click(link)
    await user.click(link)
    expect(api.open).toHaveBeenCalledOnce()
    view.unmount()
    const status = { ...delivered(), state: 'transferring' as const }
    await act(async () => finish({ ok: true, result: { kind: 'file', target, status } }))
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ target, transferId: status.transferId })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps binary preview failures visible and still allows saving a received file', async () => {
    const target = agentHostTargetFixture('binary-file')
    const status = delivered()
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: true, result: { kind: 'file', target, status } })
    vi.mocked(api.preview).mockResolvedValue({ ok: false, error: { code: 'NOT_TEXT', message: 'This file cannot be previewed as text. Save a local copy.' } })
    const user = userEvent.setup()
    render(<ChatLinkTargetContext.Provider value={{ target, active: true }}><ChatMarkdown source={'[File](file:///C:/Work/report.pdf)'} /></ChatLinkTargetContext.Provider>)
    const dialog = await (async () => { await user.click(screen.getByRole('link', { name: 'File' })); return screen.findByRole('dialog') })()
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cannot be previewed as text')
    await user.click(within(dialog).getByRole('button', { name: 'Save local copy' }))
    expect(await within(dialog).findByText('Local copy saved.')).toBeInTheDocument()
  })

  it('cancels an in-progress receiving operation when its dialog is closed', async () => {
    const target = agentHostTargetFixture('slow-file')
    const status = { ...delivered(), state: 'transferring' as const, files: [] }
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: true, result: { kind: 'file', target, status } })
    vi.mocked(api.status).mockResolvedValue({ ok: true, result: status })
    const user = userEvent.setup()
    render(<ChatLinkTargetContext.Provider value={{ target, active: true }}><ChatMarkdown source={'[File](file:///C:/Work/report.txt)'} /></ChatLinkTargetContext.Provider>)
    await user.click(screen.getByRole('link', { name: 'File' }))
    const dialog = await screen.findByRole('dialog', { name: 'Receiving linked file' })
    expect(within(dialog).getByRole('progressbar')).toBeInTheDocument()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ target, transferId: status.transferId }))
    expect(api.preview).not.toHaveBeenCalled()
  })

  it('caps paginated previews by UTF-8 bytes rather than character count', async () => {
    const target = agentHostTargetFixture('large-text')
    const status = delivered()
    status.files[0].sizeBytes = 300000
    const api = installLinks()
    vi.mocked(api.open).mockResolvedValue({ ok: true, result: { kind: 'file', target, status } })
    vi.mocked(api.preview).mockImplementation(async (request) => {
      const text = '\u4f60'.repeat(Math.floor((request.maxBytes ?? 32768) / 3))
      const offset = request.offset ?? 0
      return { ok: true, result: { kind: 'text', page: {
        fileId: status.files[0].fileId, text, offset, nextOffset: offset + text.length * 3, eof: false, truncated: true,
      } } }
    })
    const user = userEvent.setup()
    render(<ChatLinkTargetContext.Provider value={{ target, active: true }}><ChatMarkdown source={'[File](file:///C:/Work/report.txt)'} /></ChatLinkTargetContext.Provider>)
    await user.click(screen.getByRole('link', { name: 'File' }))
    const dialog = await screen.findByRole('dialog', { name: 'report.txt' })
    await within(dialog).findByRole('button', { name: 'Read more' })
    for (let index = 0; index < 8; index++) {
      await user.click(within(dialog).getByRole('button', { name: 'Read more' }))
      await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Reading...' })).not.toBeInTheDocument())
    }
    expect(api.preview).toHaveBeenCalledTimes(9)
    expect(vi.mocked(api.preview).mock.calls[8][0].maxBytes).toBe(16)
    expect((within(dialog).getByLabelText('Received file content').textContent?.length ?? 0) * 3).toBeLessThanOrEqual(256 * 1024)
    expect(within(dialog).queryByRole('button', { name: 'Read more' })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Save a local copy to view the complete file/)).toBeInTheDocument()
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
    window.desktop = { copyText, getInfo: vi.fn(), close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), getFullScreen: vi.fn(async () => false), toggleFullScreen: vi.fn(), onFullScreenChanged: vi.fn(() => () => {}) }
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(copyText).toHaveBeenCalledExactlyOnceWith('const updated = 43;\n')
    expect(write).toHaveBeenCalledTimes(2)
  })

  function delivered(): TransferStatus {
    return {
      transferId: crypto.randomUUID(), deviceId: crypto.randomUUID(), state: 'delivered', receivedBytes: 40,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      files: [{ fileId: crypto.randomUUID(), name: 'report.txt', sizeBytes: 40, sha256: 'a'.repeat(64), mediaType: 'application/octet-stream' }],
    }
  }

  function installLinks(): ChatLinkBridge {
    const api: ChatLinkBridge = {
      open: vi.fn(async () => ({ ok: true as const, result: { kind: 'external' as const } })),
      status: vi.fn(async () => ({ ok: true as const, result: delivered() })),
      preview: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_TEXT' as const, message: 'No fixture content.' } })),
      save: vi.fn(async () => ({ ok: true as const, result: { saved: true } })),
      cancel: vi.fn(async (request) => ({ ok: true as const, result: { ...delivered(), transferId: request.transferId, state: 'cancelled' as const } })),
    }
    window.desktop = {
      links: api, copyText: vi.fn(), getInfo: vi.fn(), close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(),
      getFullScreen: vi.fn(async () => false), toggleFullScreen: vi.fn(), onFullScreenChanged: vi.fn(() => () => {}),
    }
    return api
  }
})
