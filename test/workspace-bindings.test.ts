import { describe, expect, it } from 'vitest'
import { readSessionBindings, saveSessionBindings } from '../src/renderer/chat/sessionBindings'

describe('workspace-scoped session bindings', () => {
  it('isolates identical task IDs from different workspace roots and the demo', () => {
    const first = { 'T-0002': { id: 'first-session', title: 'Task Continuum work' } }
    const second = { 'T-0002': { id: 'second-session', title: 'Other project work' } }
    const demo = { 'T-0002': { id: 'demo-session', title: 'Demo binding' } }
    saveSessionBindings(first, 'workspace-one')
    saveSessionBindings(second, 'workspace-two')
    saveSessionBindings(demo)
    expect(readSessionBindings('workspace-one')).toEqual(first)
    expect(readSessionBindings('workspace-two')).toEqual(second)
    expect(readSessionBindings()).toEqual(demo)
    expect(readSessionBindings('unopened-workspace')).toEqual({})
  })

  it('detaches only the current workspace binding', () => {
    const other = { 'T-0002': { id: 'retained-session', title: 'Retained work' } }
    saveSessionBindings(other, 'other-workspace')
    saveSessionBindings({}, 'current-workspace')
    expect(readSessionBindings('other-workspace')).toEqual(other)
    expect(readSessionBindings('current-workspace')).toEqual({})
  })
})