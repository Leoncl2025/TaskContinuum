import { describe, expect, it } from 'vitest'
import { demoChatAdapter, demoResponse } from '../src/renderer/chat/demoAdapter'
import { demoTasks } from '../src/renderer/data/tasks'

describe('local chat adapter', () => {
  it('builds a response from the selected task, not a different task', () => {
    const text = demoResponse({ task: demoTasks[2], message: 'Summarize' })
    expect(text).toContain('T-0003 · Backend service')
    expect(text).toContain('local demo adapter')
    expect(text).not.toContain('UI based on Electron')
  })
  it('uses the plan for next-step requests', () => {
    expect(demoResponse({ task: demoTasks[1], message: 'Next steps?' })).toContain(demoTasks[1].plan[0])
  })
  it('reviews unfinished criteria without claiming real execution', () => {
    const text = demoResponse({ task: demoTasks[1], message: 'Review risks' })
    expect(text).toContain('Build the task explorer and viewer')
    expect(text).not.toContain('• Select the lightweight UI foundation')
    expect(text).toContain('No model, files, or tools were accessed.')
  })
  it('streams deltas and an explicit completion event', async () => {
    const request = { task: demoTasks[1], message: 'Plan', sessionId: 'test', history: [], signal: new AbortController().signal }
    const events = []
    for await (const event of demoChatAdapter.stream(request)) events.push(event)
    expect(events.at(-1)).toEqual({ type: 'complete' })
    expect(events.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe(demoResponse(request))
  })
  it('honors cancellation before a stream starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const consume = async () => {
      for await (const event of demoChatAdapter.stream({ task: demoTasks[0], message: 'Hello', sessionId: 'test', history: [], signal: controller.signal })) void event
    }
    await expect(consume()).rejects.toThrow()
  })
})