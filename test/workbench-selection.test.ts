import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchSelection } from '../src/renderer/chat/useWorkbenchSelection'
import { sessionBindingKey } from '../src/renderer/chat/sessionBindings'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

afterEach(() => { vi.restoreAllMocks() })

const taskId = 'T-0002'
const first = sessionBindingKey({ agentHost: agentHostTargetFixture('first') })
const second = sessionBindingKey({ agentHost: agentHostTargetFixture('second') })
const storageKey = (workspaceId = 'workspace') => `taskcontinuum:workbench-selection:v2:${workspaceId}`

describe('device-local workbench selection', () => {
  it('leaves defaults to the workbench and never writes a preference without a workspace', () => {
    const hook = renderHook(() => useWorkbenchSelection(undefined))
    expect(hook.result.current.taskId).toBeUndefined()
    expect(hook.result.current.sessions).toEqual({})
    act(() => hook.result.current.selectTask(taskId))
    expect(localStorage.length).toBe(0)
  })

  it('persists task and exact session selections immediately and restores them across remount', () => {
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.taskId).toBeUndefined()
    act(() => hook.result.current.selectSession(taskId, second))
    act(() => hook.result.current.selectTask('T-0003'))
    expect(JSON.parse(localStorage.getItem(storageKey())!)).toEqual({
      version: 2, taskId: 'T-0003', openTaskIds: [taskId, 'T-0003'], sessions: { [taskId]: second },
    })
    hook.unmount()
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.taskId).toBe('T-0003')
    expect(restored.result.current.openTaskIds).toEqual([taskId, 'T-0003'])
    expect(restored.result.current.sessions).toEqual({ [taskId]: second })
    const stored = localStorage.getItem(storageKey())!
    for (const field of ['machineName', 'permissions', 'canSend', 'token', 'draft', 'root', 'hostId']) {
      expect(stored).not.toContain(field)
    }
  })

  it('isolates workspaces even when they contain the same task ID', () => {
    const hook = renderHook(({ workspace }) => useWorkbenchSelection(workspace), { initialProps: { workspace: 'one' } })
    act(() => hook.result.current.selectSession(taskId, first))
    hook.rerender({ workspace: 'two' })
    expect(hook.result.current.taskId).toBeUndefined()
    expect(hook.result.current.sessions).toEqual({})
    act(() => hook.result.current.selectSession(taskId, second))
    hook.rerender({ workspace: 'one' })
    expect(hook.result.current.sessions[taskId]).toBe(first)
    hook.rerender({ workspace: 'two' })
    expect(hook.result.current.sessions[taskId]).toBe(second)
    expect(localStorage.length).toBe(2)
  })

  it('remembers the first resolved session only when there is no explicit selection', () => {
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => hook.result.current.rememberDefaultSession(taskId, first))
    expect(hook.result.current.taskId).toBe(taskId)
    expect(hook.result.current.sessions[taskId]).toBe(first)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    act(() => hook.result.current.rememberDefaultSession(taskId, second))
    expect(hook.result.current.sessions[taskId]).toBe(first)
    expect(writes).not.toHaveBeenCalled()
    act(() => hook.result.current.clearSession(taskId, first))
    writes.mockClear()
    act(() => hook.result.current.rememberDefaultSession(taskId, second))
    expect(hook.result.current.sessions[taskId]).toBeNull()
    expect(writes).not.toHaveBeenCalled()
  })

  it('preserves newer choices against a delayed detach and retains explicit empty selections', () => {
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => hook.result.current.selectSession(taskId, first))
    act(() => hook.result.current.selectSession(taskId, second))
    act(() => hook.result.current.clearSession(taskId, first))
    expect(hook.result.current.sessions[taskId]).toBe(second)
    act(() => hook.result.current.clearSession(taskId, second))
    act(() => hook.result.current.selectTask(null))
    hook.unmount()
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.taskId).toBeNull()
    expect(restored.result.current.openTaskIds).toEqual([])
    expect(restored.result.current.sessions[taskId]).toBeNull()
  })

  it('avoids redundant writes while saving every real change synchronously', () => {
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    act(() => {
      hook.result.current.selectSession(taskId, first)
      hook.result.current.selectTask(taskId)
      hook.result.current.selectTask('T-0003')
    })
    expect(writes).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(storageKey())!)).toEqual({
      version: 2, taskId: 'T-0003', openTaskIds: [taskId, 'T-0003'], sessions: { [taskId]: first },
    })
  })

  it.each([
    '{', 'null', '[]',
    '{"version":3,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{}}',
    '{"version":2,"taskId":"not-a-task","openTaskIds":["not-a-task"],"sessions":{}}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{"T-0002":42}}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{"__proto__":null}}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"canSend":true}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002","T-0002"],"sessions":{}}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0003"],"sessions":{}}',
    '{"version":2,"taskId":null,"openTaskIds":["T-0002"],"sessions":{}}',
  ])('reports corrupt data without treating it as selection or silently replacing it (%s)', (stored) => {
    localStorage.setItem(storageKey(), stored)
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.error).toContain('invalid')
    expect(hook.result.current.taskId).toBeUndefined()
    expect(hook.result.current.sessions).toEqual({})
    act(() => hook.result.current.rememberDefaultSession(taskId, first))
    expect(localStorage.getItem(storageKey())).toBe(stored)
    act(() => hook.result.current.selectSession(taskId, second))
    expect(hook.result.current.error).toBeUndefined()
    expect(hook.result.current.sessions[taskId]).toBe(second)
  })

  it('rejects oversized stored data before using it', () => {
    localStorage.setItem(storageKey(), ' '.repeat(2 * 1024 * 1024 + 1))
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.error).toContain('invalid')
    expect(hook.result.current.taskId).toBeUndefined()
  })

  it('bounds session entries and rejects invalid changes without overwriting a valid preference', () => {
    const sessions = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`T-${String(index).padStart(4, '0')}`, first]))
    localStorage.setItem(storageKey(), JSON.stringify({ version: 2, taskId, openTaskIds: [taskId], sessions }))
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.error).toContain('invalid')
    act(() => hook.result.current.selectSession(taskId, second))
    const saved = localStorage.getItem(storageKey())
    act(() => hook.result.current.selectTask('not-a-task'))
    expect(hook.result.current.error).toContain('identifiers are invalid')
    expect(hook.result.current.taskId).toBe(taskId)
    expect(localStorage.getItem(storageKey())).toBe(saved)
    hook.unmount()
    localStorage.setItem(storageKey(), JSON.stringify({ version: 2, taskId, openTaskIds: [taskId],
      sessions: Object.fromEntries(Object.entries(sessions).slice(0, 1000)),
    }))
    const bounded = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => bounded.result.current.selectSession('T-3000', second))
    expect(bounded.result.current.error).toBeUndefined()
    expect(bounded.result.current.taskId).toBe('T-3000')
    expect(Object.keys(bounded.result.current.sessions)).toHaveLength(1000)
    expect(bounded.result.current.sessions['T-0000']).toBeUndefined()
    expect(bounded.result.current.sessions['T-3000']).toBe(second)
  })

  it('reports read failures and leaves current navigation usable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage denied') })
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.error).toContain('could not be read')
    act(() => hook.result.current.selectTask(taskId))
    expect(hook.result.current.taskId).toBe(taskId)
    expect(hook.result.current.error).toBeUndefined()
  })

  it('retains in-memory choices and reports write failures until an explicit retry succeeds', () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => hook.result.current.selectSession(taskId, second))
    expect(hook.result.current.taskId).toBe(taskId)
    expect(hook.result.current.sessions[taskId]).toBe(second)
    expect(hook.result.current.error).toContain('could not be saved')
    expect(localStorage.getItem(storageKey())).toBeNull()
    act(() => hook.result.current.dismissError())
    expect(hook.result.current.error).toBeUndefined()
    writes.mockRestore()
    act(() => hook.result.current.selectTask(taskId))
    expect(hook.result.current.error).toBeUndefined()
    expect(JSON.parse(localStorage.getItem(storageKey())!).sessions[taskId]).toBe(second)
  })

  it('remembers tab order and closing an inactive or active tab without discarding session choices', () => {
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => hook.result.current.selectSession(taskId, first))
    act(() => hook.result.current.selectTask('T-0003'))
    act(() => hook.result.current.selectTask('T-0004'))
    act(() => hook.result.current.selectTask('T-0003'))
    expect(hook.result.current.openTaskIds).toEqual([taskId, 'T-0003', 'T-0004'])
    act(() => hook.result.current.closeTask(taskId, [taskId, 'T-0003', 'T-0004'], 'T-0003'))
    expect(hook.result.current.taskId).toBe('T-0003')
    expect(hook.result.current.openTaskIds).toEqual(['T-0003', 'T-0004'])
    expect(hook.result.current.sessions[taskId]).toBe(first)
    act(() => hook.result.current.closeTask('T-0003', ['T-0003', 'T-0004'], 'T-0003'))
    expect(hook.result.current.taskId).toBe('T-0004')
    expect(hook.result.current.openTaskIds).toEqual(['T-0004'])
    hook.unmount()
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.openTaskIds).toEqual(['T-0004'])
    act(() => restored.result.current.closeTask('T-0004', ['T-0004'], 'T-0004'))
    expect(restored.result.current.taskId).toBeNull()
    expect(restored.result.current.openTaskIds).toEqual([])
  })

  it('migrates the prior active-only record without reopening historical closed tasks or losing sessions', () => {
    const legacyKey = 'taskcontinuum:workbench-selection:v1:workspace'
    const legacy = JSON.stringify({ version: 1, taskId, sessions: { [taskId]: first, 'T-0003': second } })
    localStorage.setItem(legacyKey, legacy)
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.taskId).toBe(taskId)
    expect(hook.result.current.openTaskIds).toEqual([taskId])
    expect(hook.result.current.sessions).toEqual({ [taskId]: first, 'T-0003': second })
    expect(hook.result.current.error).toBeUndefined()
    act(() => hook.result.current.selectTask('T-0003'))
    expect(JSON.parse(localStorage.getItem(storageKey())!)).toEqual({
      version: 2, taskId: 'T-0003', openTaskIds: [taskId, 'T-0003'], sessions: { [taskId]: first, 'T-0003': second },
    })
    expect(localStorage.getItem(legacyKey)).toBe(legacy)
    hook.unmount()
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.taskId).toBe('T-0003')
    expect(restored.result.current.openTaskIds).toEqual([taskId, 'T-0003'])
  })

  it('keeps a legacy empty selection and does not fall back to legacy data when a newer record is corrupt', () => {
    const legacyKey = 'taskcontinuum:workbench-selection:v1:workspace'
    localStorage.setItem(legacyKey, JSON.stringify({ version: 1, taskId: null, sessions: { [taskId]: null } }))
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.taskId).toBeNull()
    expect(hook.result.current.openTaskIds).toEqual([])
    expect(hook.result.current.sessions[taskId]).toBeNull()
    hook.unmount()
    localStorage.setItem(storageKey(), '{invalid')
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.error).toContain('invalid')
    expect(restored.result.current.taskId).toBeUndefined()
    expect(restored.result.current.openTaskIds).toBeUndefined()
  })
})
