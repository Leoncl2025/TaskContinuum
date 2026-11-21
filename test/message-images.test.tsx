import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, MessageEmbeddedResourceAttachment, MessageResourceAttachment, SimpleMessageAttachment } from '@microsoft/agent-host-protocol'
import type { ChatLinkBridge } from '../src/shared/chatLinks'
import { messageImages } from '../src/renderer/chat/messageImages'
import { ChatLinkTargetContext } from '../src/renderer/chat/chatLinkContext'
import { ChatImages } from '../src/renderer/components/ChatImages'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMpoAAAAASUVORK5CYII='
const uri = 'file:///C:/Users/owner/AppData/Roaming/Code/agentSessionData/chat/attachments/image.png'
const resource = (overrides: Partial<MessageResourceAttachment> = {}): MessageResourceAttachment => ({
  type: 'resource' as MessageResourceAttachment['type'], uri, label: 'image.png', displayKind: 'image', ...overrides,
})
const embedded = (overrides: Partial<MessageEmbeddedResourceAttachment> = {}): MessageEmbeddedResourceAttachment => ({
  type: 'embeddedResource' as MessageEmbeddedResourceAttachment['type'], contentType: 'image/png', data: png, label: 'Screenshot.png', ...overrides,
})
const turn = (attachments: Message['attachments']) => ({ id: 'native-turn', message: { attachments } })

afterEach(() => { delete window.desktop })

describe('Host screenshot representations', () => {
  it('retains the actual resource-backed screenshot shape and distinct cards for equal filenames', () => {
    const images = messageImages(turn([resource(), resource({ uri: 'file:///C:/different/image.png' })]))
    expect(images).toEqual([
      { id: 'native-turn:0', name: 'image.png', uri },
      { id: 'native-turn:1', name: 'image.png', uri: 'file:///C:/different/image.png' },
    ])
  })

  it('recognizes image MIME hints and file extensions even when displayKind is absent', () => {
    expect(messageImages(turn([resource({ displayKind: undefined, contentType: 'image/png' })]))).toHaveLength(1)
    expect(messageImages(turn([resource({ displayKind: undefined, contentType: undefined })]))).toHaveLength(1)
    expect(messageImages(turn([resource({ displayKind: 'document', uri: 'file:///C:/report.txt' })]))).toEqual([])
  })

  it('keeps valid embedded images and normalizes MIME parameters without changing bytes', () => {
    expect(messageImages(turn([embedded({ contentType: 'IMAGE/PNG; charset=binary' })]))).toEqual([
      { id: 'native-turn:0', name: 'Screenshot.png', mimeType: 'image/png', data: png },
    ])
  })

  it.each([
    embedded({ contentType: 'image/svg+xml', data: btoa('<svg onload="bad()"/>') }),
    embedded({ data: 'not-base64' }),
    resource({ uri: 'https://example.com/tracking.png' }),
    resource({ uri: 'javascript:bad()' }),
    { type: 'simple' as SimpleMessageAttachment['type'], label: 'Image without data', displayKind: 'image' },
  ])('reports unsupported screenshot content instead of discarding it or loading a remote URL (%#)', (attachment) => {
    const images = messageImages(turn([attachment]))
    expect(images).toHaveLength(1)
    expect(images[0]).toHaveProperty('error')
    const view = render(<ChatImages images={images} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Host|image address/)
    expect(view.container.querySelector('img, a')).toBeNull()
  })

  it('opens existing embedded screenshots directly without starting a transfer', async () => {
    const user = userEvent.setup()
    const images = messageImages(turn([embedded()]))
    render(<ChatImages images={images} />)
    await user.click(screen.getByRole('button', { name: 'Preview Screenshot.png' }))
    const dialog = screen.getByRole('dialog', { name: 'Screenshot.png' })
    expect(within(dialog).getByRole('img', { name: 'Screenshot.png' })).toHaveAttribute('src', `data:image/png;base64,${png}`)
    await user.click(within(dialog).getByRole('button', { name: 'Close Screenshot.png' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('retrieves a screenshot from the chat owner only on click and preserves an open preview across updates', async () => {
    const target = agentHostTargetFixture('original-owner')
    const fileId = crypto.randomUUID()
    const transferId = crypto.randomUUID()
    const status = {
      transferId, deviceId: crypto.randomUUID(), state: 'delivered' as const, receivedBytes: 68,
      files: [{ fileId, name: 'image.png', sizeBytes: 68, sha256: 'a'.repeat(64), mediaType: 'application/octet-stream' }],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    const api: ChatLinkBridge = {
      open: vi.fn<ChatLinkBridge['open']>(async () => ({ ok: true, result: { kind: 'file', target, status } })),
      status: vi.fn<ChatLinkBridge['status']>(async () => ({ ok: true, result: status })),
      preview: vi.fn<ChatLinkBridge['preview']>(async () => ({ ok: true, result: { kind: 'image', image: { id: fileId, name: 'image.png', mimeType: 'image/png', data: png } } })),
      save: vi.fn<ChatLinkBridge['save']>(async () => ({ ok: true, result: { saved: false } })),
      cancel: vi.fn<ChatLinkBridge['cancel']>(async () => ({ ok: true, result: { ...status, state: 'cancelled' } })),
    }
    window.desktop = {
      links: api, getInfo: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), copyText: vi.fn(),
      getFullScreen: vi.fn(async () => false), toggleFullScreen: vi.fn(), onFullScreenChanged: vi.fn(() => () => {}),
    }
    const body = () => <ChatLinkTargetContext.Provider value={{ target, active: true }}>
      <ChatImages images={messageImages(turn([resource()]))} />
    </ChatLinkTargetContext.Provider>
    const user = userEvent.setup()
    const rendered = render(body())
    expect(api.open).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Preview image.png' }))
    const dialog = await screen.findByRole('dialog', { name: 'image.png' })
    expect(await within(dialog).findByRole('img')).toHaveAttribute('src', `data:image/png;base64,${png}`)
    expect(api.open).toHaveBeenCalledExactlyOnceWith({ href: uri, target, requestId: expect.any(String) })
    await act(async () => rendered.rerender(body()))
    expect(screen.getByRole('dialog', { name: 'image.png' })).toBe(dialog)
    expect(api.open).toHaveBeenCalledOnce()
    expect(api.preview).toHaveBeenCalledExactlyOnceWith({ target, transferId, fileId })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.mocked(api.open).mockResolvedValueOnce({ ok: false, error: { code: 'NOT_FOUND', message: 'The screenshot is no longer on the owner.' } })
    await user.click(screen.getByRole('link', { name: 'Preview image.png' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer on the owner'))
    expect(screen.getByRole('link', { name: 'Preview image.png' })).toBeInTheDocument()
  })

  it('supports fullscreen toggle, zoom controls, wheel, double-click, and keyboard shortcuts in linked file previews', async () => {
    const target = agentHostTargetFixture('chart-owner')
    const fileId = crypto.randomUUID()
    const transferId = crypto.randomUUID()
    const status = {
      transferId, deviceId: crypto.randomUUID(), state: 'delivered' as const, receivedBytes: 68,
      files: [{ fileId, name: 'pas-356-vs-main-20rounds-stats.png', sizeBytes: 68, sha256: 'a'.repeat(64), mediaType: 'image/png' }],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    const api: ChatLinkBridge = {
      open: vi.fn<ChatLinkBridge['open']>(async () => ({ ok: true, result: { kind: 'file', target, status } })),
      status: vi.fn<ChatLinkBridge['status']>(async () => ({ ok: true, result: status })),
      preview: vi.fn<ChatLinkBridge['preview']>(async () => ({
        ok: true,
        result: { kind: 'image', image: { id: fileId, name: 'pas-356-vs-main-20rounds-stats.png', mimeType: 'image/png', data: png } },
      })),
      save: vi.fn<ChatLinkBridge['save']>(async () => ({ ok: true, result: { saved: true } })),
      cancel: vi.fn<ChatLinkBridge['cancel']>(async () => ({ ok: true, result: { ...status, state: 'cancelled' } })),
    }
    window.desktop = {
      links: api, getInfo: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), copyText: vi.fn(),
      getFullScreen: vi.fn(async () => false), toggleFullScreen: vi.fn(), onFullScreenChanged: vi.fn(() => () => {}),
    }
    const user = userEvent.setup()
    render(
      <ChatLinkTargetContext.Provider value={{ target, active: true }}>
        <ChatImages images={messageImages(turn([resource({ label: 'pas-356-vs-main-20rounds-stats.png' })]))} />
      </ChatLinkTargetContext.Provider>,
    )

    await user.click(screen.getByRole('link', { name: 'Preview pas-356-vs-main-20rounds-stats.png' }))
    const dialog = await screen.findByRole('dialog', { name: 'pas-356-vs-main-20rounds-stats.png' })
    const image = await within(dialog).findByRole('img', { name: 'pas-356-vs-main-20rounds-stats.png' })
    const viewport = image.closest('.image-preview-viewport') as HTMLElement
    expect(viewport).toHaveAttribute('data-zoom', '100')
    expect(dialog).not.toHaveClass('is-fullscreen')

    await user.click(within(dialog).getByRole('button', { name: 'Full screen preview' }))
    expect(dialog).toHaveClass('is-fullscreen')
    expect(within(dialog).getByRole('button', { name: 'Exit full screen preview' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }))
    expect(viewport).toHaveAttribute('data-zoom', '125')
    expect(within(dialog).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('125%')

    fireEvent.keyDown(dialog, { key: '+' })
    expect(viewport).toHaveAttribute('data-zoom', '150')

    fireEvent.wheel(viewport, { deltaY: -100, clientX: 40, clientY: 40 })
    expect(Number(viewport.getAttribute('data-zoom'))).toBeGreaterThan(150)

    await user.click(within(dialog).getByRole('button', { name: 'Reset zoom' }))
    expect(viewport).toHaveAttribute('data-zoom', '100')

    fireEvent.doubleClick(viewport, { clientX: 50, clientY: 50 })
    expect(viewport).toHaveAttribute('data-zoom', '200')
    fireEvent.doubleClick(viewport, { clientX: 50, clientY: 50 })
    expect(viewport).toHaveAttribute('data-zoom', '100')

    // First Escape exits fullscreen without closing the dialog; second Escape closes it.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(dialog).not.toHaveClass('is-fullscreen')
    expect(screen.getByRole('dialog', { name: 'pas-356-vs-main-20rounds-stats.png' })).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: 'f' })
    expect(dialog).toHaveClass('is-fullscreen')
    fireEvent.keyDown(dialog, { key: 'f' })
    expect(dialog).not.toHaveClass('is-fullscreen')

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('supports fullscreen and zoom controls for embedded screenshot previews and resets state on reopen', async () => {
    const user = userEvent.setup()
    render(<ChatImages images={messageImages(turn([embedded()]))} />)

    await user.click(screen.getByRole('button', { name: 'Preview Screenshot.png' }))
    const dialog = screen.getByRole('dialog', { name: 'Screenshot.png' })
    await user.click(within(dialog).getByRole('button', { name: 'Full screen preview' }))
    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }))
    expect(dialog).toHaveClass('is-fullscreen')
    expect(within(dialog).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('125%')

    await user.click(within(dialog).getByRole('button', { name: 'Close Screenshot.png' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Preview Screenshot.png' }))
    const reopened = screen.getByRole('dialog', { name: 'Screenshot.png' })
    expect(reopened).not.toHaveClass('is-fullscreen')
    expect(within(reopened).getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%')
  })
})
