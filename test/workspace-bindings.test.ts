import { describe, expect, it } from 'vitest'
import * as bindings from '../src/renderer/chat/sessionBindings'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

describe('Agent Host-only UI binding identities', () => {
  it('keys the logical session, chat and owner independently of runtime Host metadata', () => {
    const target = agentHostTargetFixture('original')
    const key = bindings.sessionBindingKey({ agentHost: target })
    expect(bindings.sessionBindingKey({ agentHost: { ...target } })).toBe(key)
    const discovered = { ...target, hostId: 'another-host' }
    expect(bindings.sessionBindingKey({ agentHost: discovered })).toBe(key)
    for (const other of [
      { ...target, sessionId: 'copilotcli:/another' },
      { ...target, chatId: 'ahp-chat:/another' },
      { ...target, owner: { ...target.owner, clientId: '00000000-0000-4000-8000-000000000099' } },
    ]) expect(bindings.sessionBindingKey({ agentHost: other })).not.toBe(key)
  })

  it('exposes no browser binding storage or migration helpers and leaves saved data untouched', () => {
    const key = 'taskcontinuum:session-bindings:v1:workspace-one'
    localStorage.setItem(key, '{old data')
    for (const name of ['readSessionBindings', 'saveSessionBindings', 'clearSessionBindings']) expect(bindings).not.toHaveProperty(name)
    expect(localStorage.getItem(key)).toBe('{old data')
  })
})
