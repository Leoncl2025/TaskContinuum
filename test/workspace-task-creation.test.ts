import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createWorkspaceTaskRequestSchema, taskAgentInstructions, taskAgentInstructionsRequestSchema } from '../src/main/workspaceTaskCreation'
import type { TaskCreationContext } from '../src/shared/taskCreation'

const context: TaskCreationContext = {
  root: 'Q:\\Tasks\\my-workspace',
  members: [{ id: 'owner', name: 'Owner' }],
  levels: [{ id: 'task', title: 'Task', rank: 0 }, { id: 'subtask', title: 'Subtask', rank: 1 }],
  parents: [{ id: 'T-0001', title: 'Parent', level: 'task' }],
  types: ['feature', 'bug', 'chore', 'spike', 'doc', 'ops'],
  priorities: ['P0', 'P1', 'P2', 'P3'],
  defaults: { owner: 'owner', level: 'task', type: 'feature', priority: 'P2' },
}

describe('workspace task creation boundary', () => {
  it('accepts a bounded task draft but rejects injected lifecycle state and arbitrary filesystem paths', () => {
    const workspaceId = 'a'.repeat(64)
    expect(createWorkspaceTaskRequestSchema.parse({ workspaceId, draft: { title: ' First task ' } }).draft.title).toBe('First task')
    for (const value of [
      { workspaceId: 'Q:\\other', draft: { title: 'Task' } },
      { workspaceId, draft: { title: 'Task', status: 'done' } },
      { workspaceId, draft: { title: 'Task', path: '..\\other' } },
      { workspaceId, draft: { title: 'Task', acceptance: ['First\n- [x] CL-999'] } },
    ]) expect(() => createWorkspaceTaskRequestSchema.parse(value)).toThrow()
  })

  it('builds a scoped agent handoff with a JSON-review fallback and does not pretend to call an agent', () => {
    const request = taskAgentInstructionsRequestSchema.parse({ workspaceId: 'a'.repeat(64), goal: 'Plan sign-in', parentId: 'T-0001' })
    const prompt = taskAgentInstructions(context, request)
    expect(prompt).toContain(JSON.stringify(context.root))
    expect(prompt).toContain('T-0001 (Parent)')
    expect(prompt).toContain('ONE JSON object')
    expect(prompt).toContain('does not expose the source CLI')
    expect(prompt).toContain('Do not modify another task')
    expect(prompt).toContain('Refresh created tasks')
  })

  it('rejects a stale parent selection and empty or oversized agent requests', () => {
    expect(() => taskAgentInstructions(context, { workspaceId: 'a'.repeat(64), goal: 'Task', parentId: 'T-0099' })).toThrow('parent task no longer exists')
    expect(() => taskAgentInstructionsRequestSchema.parse({ workspaceId: 'a'.repeat(64), goal: '' })).toThrow()
    expect(() => taskAgentInstructionsRequestSchema.parse({ workspaceId: 'a'.repeat(64), goal: 'x'.repeat(8001) })).toThrow()
  })

  it('includes local CLI context for direct chat within the native first-message limit', () => {
    const prompt = taskAgentInstructions(context, { workspaceId: 'a'.repeat(64), goal: 'Create a task for sign-in documentation.', parentId: null }, resolve('scripts', 'task-documents.mjs'))
    expect(prompt).toContain('local task-creation agent')
    expect(prompt).toContain('task-documents.mjs')
    expect(prompt).toContain('Create a task for sign-in documentation.')
    expect(prompt.length).toBeLessThanOrEqual(4000)
  })
})
