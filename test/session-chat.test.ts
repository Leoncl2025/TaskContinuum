import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatAdapter, ChatRequest } from '../src/shared/chat'
import { useTaskChats } from '../src/renderer/chat/useTaskChats'
import { demoTasks } from '../src/renderer/data/tasks'

function recordingAdapter(requests: ChatRequest[]): ChatAdapter {
  return {
    label: 'Test session host',
    kind: 'live',
    async *stream(request) {
      requests.push(request)
      yield { type: 'complete' }
    },
  }
}

describe('restored task conversations', () => {
  it('isolates image drafts per task and sends image-only input to its selected session', async () => {
    const requests: ChatRequest[] = []
    const { result } = renderHook(() => useTaskChats(recordingAdapter(requests)))
    const image = { id: crypto.randomUUID(), name: 'Screenshot.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
    act(() => result.current.restore(demoTasks[0].id, 'existing-copilot-session', []))
    act(() => result.current.setImages(demoTasks[0].id, [image]))
    await act(() => result.current.send(demoTasks[1], 'Another task'))
    expect(requests[0].images).toBeUndefined()
    expect(result.current.getThread(demoTasks[0].id).images).toEqual([image])
    await act(() => result.current.send(demoTasks[0], ''))
    expect(requests[1]).toMatchObject({ sessionId: 'existing-copilot-session', message: '', images: [image] })
    expect(result.current.getThread(demoTasks[0].id).images).toEqual([])
    expect(result.current.getThread(demoTasks[0].id).messages[0].images).toEqual([image])
  })

  it('restores an image draft when sending fails before a response arrives', async () => {
    const adapter = recordingAdapter([])
    adapter.stream = () => { throw new Error('Offline') }
    const { result } = renderHook(() => useTaskChats(adapter))
    const image = { id: crypto.randomUUID(), name: 'Screenshot.png', mimeType: 'image/png' as const, data: 'test bytes' }
    act(() => result.current.setImages(demoTasks[0].id, [image]))
    await act(() => result.current.send(demoTasks[0], 'Inspect this'))
    expect(result.current.getThread(demoTasks[0].id)).toMatchObject({ draft: 'Inspect this', images: [image] })
  })

  it('continues the selected session with its restored history', async () => {
    const requests: ChatRequest[] = []
    const { result } = renderHook(() => useTaskChats(recordingAdapter(requests)))
    const history = [{ id: 'original', role: 'assistant' as const, text: 'Previous response', status: 'complete' as const }]
    act(() => result.current.restore(demoTasks[0].id, 'existing-copilot-session', history))
    await act(() => result.current.send(demoTasks[0], 'Continue'))
    expect(requests[0].sessionId).toBe('existing-copilot-session')
    expect(requests[0].history).toEqual(history)
    expect(result.current.getThread(demoTasks[0].id).sessionId).toBe('existing-copilot-session')
    expect(result.current.getThread(demoTasks[1].id).messages).toEqual([])
  })

  it('starts a separate conversation after clearing the binding', async () => {
    const requests: ChatRequest[] = []
    const { result } = renderHook(() => useTaskChats(recordingAdapter(requests)))
    act(() => result.current.restore(demoTasks[0].id, 'existing-copilot-session', []))
    act(() => result.current.clear(demoTasks[0].id))
    await act(() => result.current.send(demoTasks[0], 'New conversation'))
    expect(requests[0].sessionId).toBe(`local:${demoTasks[0].id}`)
    expect(requests[0].history).toEqual([])
  })
})