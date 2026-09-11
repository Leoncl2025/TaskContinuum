// @vitest-environment node
import { describe, expect, it } from 'vitest'
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
})