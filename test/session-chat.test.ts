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