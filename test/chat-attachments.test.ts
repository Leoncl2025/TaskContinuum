import { randomUUID } from 'node:crypto'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ClipboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { chatImageAttachmentsSchema, chatImageBytes, chatImageDataUrl, MAX_CHAT_IMAGE_BYTES } from '../src/shared/chatAttachments'
import { useChatImageInput } from '../src/renderer/chat/useChatImageInput'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const image = () => ({ id: randomUUID(), name: 'Screenshot.png', mimeType: 'image/png' as const, data: png })

describe('chat image attachments', () => {
  it('accepts clipboard PNG bytes without exposing a filesystem path', () => {
    const attachment = image()
    expect(chatImageAttachmentsSchema.parse([attachment])).toEqual([attachment])
    expect(chatImageBytes(attachment)).toBe(Buffer.from(png, 'base64').length)
    expect(chatImageDataUrl(attachment)).toBe(`data:image/png;base64,${png}`)
  })

  it('rejects unsupported formats, mismatched headers, malformed base64 and path fields', () => {
    for (const change of [
      { mimeType: 'image/svg+xml' },
      { mimeType: 'image/jpeg' },
      { data: btoa('<script>alert(1)</script>') },
      { data: `${png}\n` },
      { data: '!!!!' },
      { data: 'a===' },
      { data: 'AB==' },
      { path: 'C:\\private\\screenshot.png' },
    ]) expect(chatImageAttachmentsSchema.safeParse([{ ...image(), ...change }]).success).toBe(false)
  })

  it('bounds individual images, aggregate bytes, count and duplicate identities', () => {
    const bytes = Buffer.alloc(MAX_CHAT_IMAGE_BYTES, 0)
    Buffer.from(png, 'base64').copy(bytes)
    const large = { ...image(), data: bytes.toString('base64') }
    expect(chatImageAttachmentsSchema.safeParse([large]).success).toBe(true)
    expect(chatImageAttachmentsSchema.safeParse([{ ...large, data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') }]).success).toBe(false)
    expect(chatImageAttachmentsSchema.safeParse([large, { ...large, id: randomUUID() }, image()]).success).toBe(false)
    expect(chatImageAttachmentsSchema.safeParse(Array.from({ length: 5 }, image)).success).toBe(false)
    expect(chatImageAttachmentsSchema.safeParse([large, large]).success).toBe(false)
  })

  it('leaves ordinary text paste alone and preserves mixed text with its image attachment', async () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useChatImageInput('session-one', [], onChange))
    const preventDefault = vi.fn()
    const text = { clipboardData: { items: [], files: [], getData: () => 'Pasted text' }, preventDefault } as unknown as ClipboardEvent<HTMLTextAreaElement>
    act(() => result.current.paste(text))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    const file = new File([Buffer.from(png, 'base64')], 'Screenshot.png', { type: 'image/png' })
    const mixed = { clipboardData: { files: [file], getData: () => 'Pasted text' }, preventDefault } as unknown as ClipboardEvent<HTMLTextAreaElement>
    act(() => result.current.paste(mixed))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ data: png, name: file.name })]))
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('rejects invalid or oversized images without changing an existing draft', async () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useChatImageInput('session-one', [image()], onChange))
    for (const file of [new File(['<svg></svg>'], 'drawing.svg', { type: 'image/svg+xml' }), new File(['invalid'], 'broken.png', { type: 'image/png' }), new File([new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' })]) {
      await act(() => result.current.add([file]))
      expect(result.current.error).toMatch(/PNG|image/i)
      expect(result.current.reading).toBe(false)
      expect(onChange).not.toHaveBeenCalled()
    }
  })

  it('does not attach a late image read to a different session', async () => {
    const readers: FileReader[] = []
    const reading = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { readers.push(this) })
    const onChange = vi.fn()
    const { result, rerender, unmount } = renderHook(({ key }) => useChatImageInput(key, [], onChange), { initialProps: { key: 'first-session' } })
    let pending: Promise<void> | undefined
    try {
      act(() => { pending = result.current.add([new File([Buffer.from(png, 'base64')], 'Screenshot.png', { type: 'image/png' })]) })
      expect(result.current.isReading()).toBe(true)
      rerender({ key: 'second-session' })
      await act(async () => {
        Object.defineProperty(readers[0], 'result', { value: `data:image/png;base64,${png}` })
        readers[0].dispatchEvent(new ProgressEvent('load'))
        await pending
      })
      expect(onChange).not.toHaveBeenCalled()
      expect(result.current.isReading()).toBe(false)
      expect(result.current.error).toBeUndefined()
    } finally { reading.mockRestore(); unmount() }
  })
})