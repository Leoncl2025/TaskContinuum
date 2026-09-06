import { describe, expect, it } from 'vitest'
import { filterTasks, taskProgress } from '../src/shared/tasks'
import { demoTasks } from '../src/renderer/data/tasks'

describe('task model', () => {
  it('filters by ID and title case-insensitively', () => {
    expect(filterTasks(demoTasks, 't-0002 electron', 'all').map((task) => task.id)).toEqual(['T-0002'])
  })
  it('combines the query and status scope', () => {
    expect(filterTasks(demoTasks, 'backend', 'active')).toEqual([])
    expect(filterTasks(demoTasks, '', 'done').map((task) => task.id)).toEqual(['DEMO-01'])
  })
  it('ignores surrounding whitespace and handles empty results', () => {
    expect(filterTasks(demoTasks, '  ', 'all')).toHaveLength(5)
    expect(filterTasks(demoTasks, 'no-such-task', 'all')).toHaveLength(0)
  })
  it('derives acceptance progress independently of status', () => {
    expect(taskProgress(demoTasks[1])).toBe(40)
    expect(taskProgress({ ...demoTasks[1], checklist: [] })).toBe(0)
    expect(taskProgress(demoTasks[4])).toBe(100)
  })
})