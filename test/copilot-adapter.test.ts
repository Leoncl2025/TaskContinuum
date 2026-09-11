import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../src/shared/chat'
import { createCopilotAdapter } from '../src/renderer/chat/copilotAdapter'
import { demoTasks } from '../src/renderer/data/tasks'
import { mockCopilotBridge } from './copilot-fixtures'

function request(signal = new AbortController().signal) {
  return { sessionId: 'native-session', message: 'Continue', task: demoTasks[0], history: [], signal }
}

describe('desktop Copilot chat adapter', () => {
  it('routes only matching session events and preserves activity updates', async () => {
    const host = mockCopilotBridge()
    vi.mocked(host.bridge.send).mockImplementation(async (request) => {
      host.emit({ type: 'delta', ...request, sessionId: 'other-session', text: 'Wrong session' })
      host.emit({ type: 'activity', ...request, text: 'Running read_file' })
      host.emit({ type: 'delta', ...request, text: 'Actual response' })
      host.emit({ type: 'complete', ...request })
    })
    const events: ChatEvent[] = []
    for await (const event of createCopilotAdapter(host.bridge).stream(request())) events.push(event)
    expect(events).toEqual([{ type: 'activity', text: 'Running read_file' }, { type: 'delta', text: 'Actual response' }, { type: 'complete' }])
    expect(host.listeners.size).toBe(0)
  })

  it('forwards image-only input through the typed bridge without dropping attachment bytes', async () => {
    const host = mockCopilotBridge()
    const image = { id: crypto.randomUUID(), name: 'Screenshot.png', mimeType: 'image/png' as const, data: 'image bytes' }
    vi.mocked(host.bridge.send).mockImplementation(async (request) => { host.emit({ type: 'complete', ...request }) })
    const events: ChatEvent[] = []
    for await (const event of createCopilotAdapter(host.bridge).stream({ ...request(), message: '', images: [image] })) events.push(event)
    expect(host.bridge.send).toHaveBeenCalledExactlyOnceWith({ sessionId: 'native-session', requestId: expect.any(String), message: '', images: [image] })
    expect(events).toEqual([{ type: 'complete' }])
  })

  it('stops the matching backend request and releases the event subscription', async () => {
    const host = mockCopilotBridge()
    const controller = new AbortController()
    vi.mocked(host.bridge.send).mockImplementation(async (request) => {
      host.emit({ type: 'delta', ...request, text: 'Started' })
      await new Promise<void>(() => {})
    })
    const iterator = createCopilotAdapter(host.bridge).stream(request(controller.signal))[Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()
    await expect(iterator.next()).rejects.toThrow('stopped')
    expect(host.bridge.abort).toHaveBeenCalledWith(vi.mocked(host.bridge.send).mock.calls[0][0].requestId)
    expect(host.listeners.size).toBe(0)
  })

  it('fails explicitly when the bridge ends without a completion event', async () => {
    const host = mockCopilotBridge()
    vi.mocked(host.bridge.send).mockResolvedValue(undefined)
    const iterator = createCopilotAdapter(host.bridge).stream(request())[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('without a completion event')
    expect(host.listeners.size).toBe(0)
  })

  it('never sends an already-cancelled or demo-bound request', async () => {
    const host = mockCopilotBridge()
    const adapter = createCopilotAdapter(host.bridge)
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.stream(request(controller.signal))[Symbol.asyncIterator]().next()).rejects.toThrow()
    await expect(adapter.stream({ ...request(), sessionId: 'local:T-0002' })[Symbol.asyncIterator]().next()).rejects.toThrow('Open or create')
    expect(host.bridge.send).not.toHaveBeenCalled()
  })
})