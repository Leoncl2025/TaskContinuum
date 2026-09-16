import { describe, expect, it } from 'vitest'
import { filterTasks, taskProgress } from '../src/shared/tasks'
import { fixtureTasks } from './task-fixture'

describe('task model', () => {
  it('filters by ID and title case-insensitively', () => {
    expect(filterTasks(fixtureTasks, 't-0002 electron', 'all').map((task) => task.id)).toEqual(['T-0002'])
  })
  it('combines the query and status scope', () => {
    expect(filterTasks(fixtureTasks, 'backend', 'active')).toEqual([])
    expect(filterTasks(fixtureTasks, '', 'done').map((task) => task.id)).toEqual(['T-0005'])
  })
  it('ignores surrounding whitespace and handles empty results', () => {
    expect(filterTasks(fixtureTasks, '  ', 'all')).toHaveLength(5)
    expect(filterTasks(fixtureTasks, 'no-such-task', 'all')).toHaveLength(0)
  })
  it('derives acceptance progress independently of status', () => {
    expect(taskProgress(fixtureTasks[1])).toBe(40)
    expect(taskProgress({ ...fixtureTasks[1], checklist: [] })).toBe(0)
    expect(taskProgress(fixtureTasks[4])).toBe(100)
  })
})