// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ActionEnvelope, ChatState, Snapshot } from '@microsoft/agent-host-protocol'
import { AgentHostChatState } from '../src/main/agentHostState'

const resource = 'ahp-chat:/session/main'
const initial = { resource, fromSeq: 10, state: { resource, title: 'Original Host chat', status: 1, modifiedAt: '2026-09-11T00:00:00Z', turns: [] } } as Snapshot
const action = (serverSeq: number, value: Record<string, unknown>) => ({ channel: resource, serverSeq, origin: undefined, action: value }) as unknown as ActionEnvelope

describe('Agent Host incremental chat state', () => {
  it('applies streamed text before completion and ignores replayed events', () => {
    const chat = new AgentHostChatState(resource)
    chat.snapshot(initial)
    chat.apply(action(11, { type: 'chat/turnStarted', turnId: 'turn', startedAt: '2026-09-11T00:00:01Z', message: { text: 'Continue', origin: { kind: 'user' } } }))
    chat.apply(action(13, { type: 'chat/responsePart', turnId: 'turn', part: { id: 'response', kind: 'markdown', content: '' } }))
    const delta = action(15, { type: 'chat/delta', turnId: 'turn', partId: 'response', content: 'Live response' })
    expect(chat.apply(delta)).toBe(true)
    expect(chat.value?.activeTurn?.responseParts).toContainEqual({ id: 'response', kind: 'markdown', content: 'Live response' })
    expect(chat.value?.turns).toHaveLength(0)
    expect(chat.apply(delta)).toBe(false)
    chat.snapshot(initial)
    expect(chat.value?.activeTurn?.responseParts).toContainEqual({ id: 'response', kind: 'markdown', content: 'Live response' })
    chat.apply(action(18, { type: 'chat/turnComplete', turnId: 'turn', duration: 100 }))
    expect(chat.value?.activeTurn).toBeUndefined()
    expect(chat.value?.turns).toHaveLength(1)
    expect(chat.lastSequence).toBe(18)
  })

  it('rejects another session and exposes isolated copies', () => {
    const chat = new AgentHostChatState(resource)
    expect(() => chat.apply(action(12, { type: 'chat/turnComplete', turnId: 'turn' }))).toThrow('snapshot')
    chat.snapshot(initial)
    expect(() => chat.snapshot({ ...initial, resource: 'ahp-chat:/another/main' })).toThrow('different')
    expect(() => chat.apply({ ...action(20, { type: 'chat/turnComplete', turnId: 'turn' }), channel: 'ahp-chat:/another/main' })).toThrow('another chat')
    const copy = chat.value as ChatState
    copy.title = 'Not the source'
    expect(chat.value?.title).toBe('Original Host chat')
  })

  it('reads send guards and turn IDs without cloning history and isolates selection and action inputs', () => {
    const chat = new AgentHostChatState(resource)
    chat.snapshot(initial)
    const start = action(11, { type: 'chat/turnStarted', turnId: 'turn', startedAt: '2026-09-11T00:00:01Z', message: { text: 'Original', origin: { kind: 'user' }, model: { id: 'test', config: { effort: 'high' } } } })
    chat.apply(start)
    const spy = vi.spyOn(globalThis, 'structuredClone')
    try {
      expect(chat.loaded).toBe(true)
      expect(chat.sendState).toEqual({ activeTurnId: 'turn', hasDraft: false, hasQueuedMessages: false, readOnly: false })
      expect(chat.hasTurn('turn')).toBe(true)
      expect(chat.hasTurn('absent')).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
    if ('message' in start.action && typeof start.action.message === 'object' && start.action.message) start.action.message.text = 'Mutated input'
    expect(chat.value?.activeTurn?.message.text).toBe('Original')
    chat.apply(action(12, { type: 'chat/turnComplete', turnId: 'turn', duration: 1 }))
    expect(chat.sendState.activeTurnId).toBeUndefined()
    expect(chat.hasTurn('turn')).toBe(true)
    const selection = chat.selection!
    if (selection.model?.config) selection.model.config.effort = 'low'
    expect(chat.selection?.model?.config?.effort).toBe('high')
    chat.snapshot({ ...initial, fromSeq: 20 })
    expect(chat.hasTurn('turn')).toBe(false)
  })

  it('indexes historical terminals without treating completed-turn running labels as active and returns isolated sets', () => {
    const terminal = 'ahp-terminal:/history'
    const chat = new AgentHostChatState(resource)
    chat.snapshot(initial)
    chat.apply(action(11, { type: 'chat/turnStarted', turnId: 'turn', startedAt: '2026-09-11T00:00:01Z', message: { text: 'Run', origin: { kind: 'user' } } }))
    chat.apply(action(12, { type: 'chat/responsePart', turnId: 'turn', part: { kind: 'toolCall', toolCall: {
      toolCallId: 'tool', toolName: 'terminal', displayName: 'Output', status: 'running', content: [{ type: 'terminal', resource: terminal, title: 'Output' }],
    } } }))
    expect(chat.terminalResources.active.has(terminal)).toBe(true)
    chat.apply(action(13, { type: 'chat/toolCallComplete', turnId: 'turn', toolCallId: 'tool', result: {
      success: true, pastTenseMessage: 'Completed', content: [{ type: 'terminal', resource: terminal, title: 'Output' }],
    } }))
    chat.apply(action(14, { type: 'chat/turnComplete', turnId: 'turn', duration: 1 }))
    const indexes = chat.terminalResources
    expect(indexes.active.size).toBe(0)
    expect(indexes.referenced.has(terminal)).toBe(true)
    indexes.referenced.clear()
    expect(chat.terminalResources.referenced.has(terminal)).toBe(true)
    const snapshot = chat.toSnapshot()!
    const historical = (snapshot.state as ChatState).turns[0].responseParts[0]
    if (historical.kind !== 'toolCall') throw new Error('Expected a historical tool.')
    historical.toolCall = { ...historical.toolCall, status: 'running' } as typeof historical.toolCall
    chat.snapshot({ ...snapshot, fromSeq: 15 })
    expect(chat.terminalResources.active.size).toBe(0)
    expect(chat.terminalResources.referenced.has(terminal)).toBe(true)
    chat.snapshot({ ...initial, fromSeq: 20 })
    expect(chat.terminalResources.referenced.size).toBe(0)
  })
})