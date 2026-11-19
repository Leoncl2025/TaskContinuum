import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchSelection } from '../src/renderer/chat/useWorkbenchSelection'
import { moveSessionKey, orderSessionBindings, sessionBindingKey, sortSessionBindings } from '../src/renderer/chat/sessionBindings'
import { buildSessionTree, moveSessionNode, treeSessionBindings, ungroupSessions } from '../src/renderer/chat/sessionGroups'
import type { SessionGroupLayout } from '../src/renderer/chat/sessionGroups'
import { agentHostKey } from '../src/shared/agentHost'
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

  it('persists manual session orders across task/session updates and remounts without leaking sensitive fields', () => {
    const third = sessionBindingKey({ agentHost: agentHostTargetFixture('third') })
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.sessionOrders).toEqual({})
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const layout = { order: [third, first, second], groups: [] }
    act(() => hook.result.current.setSessionLayout(taskId, layout, true, taskId, [taskId]))
    act(() => hook.result.current.setSessionLayout(taskId, layout, true, taskId, [taskId]))
    expect(writes).toHaveBeenCalledOnce()
    act(() => hook.result.current.selectSession(taskId, first))
    act(() => hook.result.current.selectTask('T-0003'))
    act(() => hook.result.current.closeTask('T-0003', [taskId, 'T-0003'], 'T-0003'))
    hook.unmount()

    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.sessionOrders).toEqual({ [taskId]: [third, first, second] })
    expect(restored.result.current.sessions).toEqual({ [taskId]: first })
    expect(restored.result.current.taskId).toBe(taskId)
    const stored = localStorage.getItem(storageKey())!
    for (const field of ['machineName', 'permissions', 'canSend', 'token', 'draft', 'root', 'hostId']) {
      expect(stored).not.toContain(field)
    }

    const items = ['first', 'second', 'third', 'fourth'].map((name) => {
      const agentHost = agentHostTargetFixture(name)
      return { id: agentHost.sessionId, title: name, owner: agentHost.owner, agentHost }
    })
    expect(orderSessionBindings(items, [third, 'ahp:["gone","gone","gone"]', first]).map((item) => item.title))
      .toEqual(['third', 'first', 'second', 'fourth'])
    expect(moveSessionKey([first, second, third], third, 0)).toEqual([third, first, second])
    expect(moveSessionKey([first, second, third], first, 3)).toEqual([second, third, first])
    expect(moveSessionKey([first, second, third], second, 1)).toBeUndefined()
    expect(moveSessionKey([first, second, third], second, 2)).toBeUndefined()
  })

  it.each([
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"sessionOrders":{"T-0002":[]}}',
    `{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"sessionOrders":{"T-0002":[${JSON.stringify(first)},${JSON.stringify(first)}]}}`,
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"sessionOrders":{"bad":["ahp:1"]}}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"sessionSort":"random"}',
    '{"version":2,"taskId":"T-0002","openTaskIds":["T-0002"],"sessions":{},"sessionSorts":{"T-0002":"random"}}',
  ])('rejects invalid stored sessionOrders (%s)', (stored) => {
    localStorage.setItem(storageKey(), stored)
    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    expect(hook.result.current.error).toContain('invalid')
    expect(hook.result.current.sessionOrders).toEqual({})
  })

  it('sorts sessions by last response, creation time, natural name, and machine, and switches a dragged task back to manual', () => {
    const ownerA = { clientId: '00000000-0000-4000-8000-000000000011', machineName: 'HOST-Z' }
    const ownerB = { clientId: '00000000-0000-4000-8000-000000000022', machineName: 'HOST-A' }
    const make = (name: string, title: string, owner = ownerA) => {
      const agentHost = agentHostTargetFixture(name, owner)
      return { id: agentHost.sessionId, title, owner, agentHost }
    }
    const s1 = make('s1', 'Session 10', ownerA)
    const s2 = make('s2', 'Session 2', ownerB)
    const s3 = make('s3', 'Alpha review', ownerA)
    const items = [s1, s2, s3]
    const timestamps = {
      [agentHostKey(s1.agentHost)]: { createdAt: 1000, updatedAt: 2000 },
      [agentHostKey(s2.agentHost)]: { createdAt: 3000, updatedAt: 5000 },
      [agentHostKey(s3.agentHost)]: { createdAt: 2000, updatedAt: 4000 },
    }
    const aliases = { [ownerA.clientId]: 'Studio', [ownerB.clientId]: 'Edge' }

    expect(sortSessionBindings(items, { mode: 'updated-desc', timestamps }).map((i) => i.title)).toEqual(['Session 2', 'Alpha review', 'Session 10'])
    expect(sortSessionBindings(items, { mode: 'created-desc', timestamps }).map((i) => i.title)).toEqual(['Session 2', 'Alpha review', 'Session 10'])
    expect(sortSessionBindings(items, { mode: 'created-asc', timestamps }).map((i) => i.title)).toEqual(['Session 10', 'Alpha review', 'Session 2'])
    expect(sortSessionBindings(items, { mode: 'title-asc' }).map((i) => i.title)).toEqual(['Alpha review', 'Session 2', 'Session 10'])
    expect(sortSessionBindings(items, { mode: 'title-desc' }).map((i) => i.title)).toEqual(['Session 10', 'Session 2', 'Alpha review'])
    expect(sortSessionBindings(items, { mode: 'machine-asc', timestamps, aliases }).map((i) => i.title)).toEqual(['Session 2', 'Alpha review', 'Session 10'])

    // Fallback when createdAt is absent uses chronological binding link index.
    expect(sortSessionBindings(items, { mode: 'created-desc' }).map((i) => i.title)).toEqual(['Alpha review', 'Session 2', 'Session 10'])
    expect(sortSessionBindings(items, { mode: 'created-asc' }).map((i) => i.title)).toEqual(['Session 10', 'Session 2', 'Alpha review'])

    const hook = renderHook(() => useWorkbenchSelection('workspace'))
    act(() => hook.result.current.setSessionSort('T-0002', 'updated-desc', 'T-0002', ['T-0002', 'T-0003']))
    expect(hook.result.current.taskSortMode('T-0002')).toBe('updated-desc')
    expect(hook.result.current.taskSortMode('T-0003')).toBe('updated-desc')

    // Dragging on T-0002 pins T-0002 to manual while keeping T-0003 on updated-desc.
    act(() => hook.result.current.setSessionLayout('T-0002', { order: [second, first], groups: [] }, true, 'T-0002', ['T-0002', 'T-0003']))
    expect(hook.result.current.taskSortMode('T-0002')).toBe('manual')
    expect(hook.result.current.taskSortMode('T-0003')).toBe('updated-desc')

    hook.unmount()
    const restored = renderHook(() => useWorkbenchSelection('workspace'))
    expect(restored.result.current.taskSortMode('T-0002')).toBe('manual')
    expect(restored.result.current.taskSortMode('T-0003')).toBe('updated-desc')
    expect(restored.result.current.sessionOrders['T-0002']).toEqual([second, first])
  })

  it('remembers group names, member order and collapse per workspace without changing task selection or sort', () => {
    const group = { id: 'grp:00000000-0000-4000-8000-000000000033', title: 'Performance', collapsed: true, memberKeys: [second, first] }
    const layout = { order: [group.id], groups: [group] }
    const hook = renderHook(({ workspace }) => useWorkbenchSelection(workspace), { initialProps: { workspace: 'one' } })
    act(() => hook.result.current.selectSession(taskId, first))
    act(() => hook.result.current.setSessionSort(taskId, 'title-asc'))
    act(() => hook.result.current.setSessionLayout(taskId, layout, false))
    expect(hook.result.current.sessions[taskId]).toBe(first)
    expect(hook.result.current.taskSortMode(taskId)).toBe('title-asc')
    act(() => hook.result.current.selectTask('T-0003'))
    hook.rerender({ workspace: 'two' })
    expect(hook.result.current.sessionGroups).toEqual({})
    hook.rerender({ workspace: 'one' })
    expect(hook.result.current.sessionGroups[taskId]).toEqual(layout)
    act(() => hook.result.current.selectSession(taskId, second))
    expect(hook.result.current.sessionGroups[taskId].groups[0].collapsed).toBe(false)
    act(() => hook.result.current.clearSession(taskId, first, false))
    expect(hook.result.current.sessions[taskId]).toBe(second)
    expect(hook.result.current.sessionGroups[taskId].groups[0]).toMatchObject({ title: 'Performance', memberKeys: [second] })
    act(() => hook.result.current.clearSession(taskId, second))
    expect(hook.result.current.sessionGroups).toEqual({})
    expect(hook.result.current.sessions[taskId]).toBeNull()
  })

  it('reports corrupt grouping without discarding the remembered task and active chat', () => {
    const group = { id: 'grp:00000000-0000-4000-8000-000000000044', title: 'Performance', collapsed: false, memberKeys: [first, second] }
    localStorage.setItem(storageKey(), JSON.stringify({
      version: 2, taskId, openTaskIds: [taskId], sessions: { [taskId]: first },
      sessionGroups: { [taskId]: { order: [first, group.id], groups: [group] } },
    }))
    const { result } = renderHook(() => useWorkbenchSelection('workspace'))
    expect(result.current.error).toContain('Saved session groups are invalid')
    expect(result.current.taskId).toBe(taskId)
    expect(result.current.sessions[taskId]).toBe(first)
    expect(result.current.sessionGroups).toEqual({})
  })
})

describe('session group arrangement', () => {
  const performance = 'grp:00000000-0000-4000-8000-000000000033'
  const review = 'grp:00000000-0000-4000-8000-000000000044'

  it('moves exact sessions and whole groups without duplicates, including promotion on ungroup', () => {
    const linked: SessionGroupLayout = { order: ['A', 'B', 'C', 'D', 'E'], groups: [] }
    const initial = moveSessionNode(linked, 'D', { key: 'B', position: 'group' }, performance)!
    expect(initial.order).toEqual(['A', performance, 'C', 'E'])
    expect(initial.groups[0].memberKeys).toEqual(['B', 'D'])
    const two = moveSessionNode(initial, 'E', { key: 'C', position: 'group' }, review)!
    expect(moveSessionNode(two, performance, { key: review, position: 'into' })).toBeUndefined()
    const joined = moveSessionNode(two, 'D', { key: 'C', position: 'into' })!
    expect(joined.order).toEqual(['A', 'B', review])
    expect(joined.groups[0].memberKeys).toEqual(['C', 'D', 'E'])
    const extracted = moveSessionNode(joined, 'D', { key: review, position: 'before' })!
    const moved = moveSessionNode(extracted, review, { key: 'A', position: 'before' })!
    expect(moved.order).toEqual([review, 'A', 'B', 'D'])
    expect(ungroupSessions(moved, review)).toEqual({ order: ['C', 'E', 'A', 'B', 'D'], groups: [] })
  })

  it('smart-sorts by group name or newest member and ignores removed bindings without losing new ones', () => {
    const make = (name: string, owner?: Parameters<typeof agentHostTargetFixture>[1]) => {
      const agentHost = agentHostTargetFixture(name, owner)
      return { id: agentHost.sessionId, title: name, owner: agentHost.owner, agentHost }
    }
    const a = make('Zebra')
    const b = { ...a, title: 'Alpha', agentHost: { ...a.agentHost, chatId: 'ahp-chat:/other' } }
    const c = make('Beta')
    const d = make('Delta')
    const key = sessionBindingKey
    const group = { id: performance, title: 'Build', collapsed: true, memberKeys: [key(a), key(b)] }
    const saved = { order: [key(c), performance], groups: [group] }
    const bindings = [a, b, c]
    const nameOrder = buildSessionTree(bindings, { mode: 'title-asc' }, saved)
    expect(nameOrder.entries.map((entry) => entry.key)).toEqual([key(c), performance])
    expect(treeSessionBindings(nameOrder.entries)).toEqual([c, b, a])
    const mostRecent = buildSessionTree(bindings, {
      mode: 'updated-desc', timestamps: {
        [agentHostKey(a.agentHost)]: { updatedAt: 300 },
        [agentHostKey(b.agentHost)]: { updatedAt: 100 },
        [agentHostKey(c.agentHost)]: { updatedAt: 200 },
      },
    }, saved)
    expect(mostRecent.entries.map((entry) => entry.key)).toEqual([performance, key(c)])
    expect(treeSessionBindings(mostRecent.entries)).toEqual([a, b, c])
    const reconciled = buildSessionTree([b, c, d], { mode: 'manual' }, saved)
    expect(reconciled.manual.groups[0]).toEqual({ ...group, memberKeys: [key(b)] })
    expect(treeSessionBindings(reconciled.entries)).toEqual([c, b, d])
    expect(buildSessionTree([c, d], { mode: 'manual' }, saved).manual).toEqual({ order: [key(c), key(d)], groups: [] })
  })
})
