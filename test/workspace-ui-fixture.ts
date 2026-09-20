import { vi } from 'vitest'
import type { WorkspaceBridge, WorkspaceSnapshot, WorkspaceState } from '../src/shared/workspace'
import { fixtureTasks } from './task-fixture'
import type { TaskRecord } from '../src/shared/tasks'

export function taskWorkspaceFixture(): WorkspaceSnapshot {
  return {
    id: 'workspace-fixture', name: 'Planning tasks', title: 'Planning tasks', root: 'Q:\\Workspaces\\planning-tasks',
    tasks: [fixtureTasks[1], fixtureTasks[0], ...fixtureTasks.slice(2)].map((task) => ({
      ...structuredClone(task),
      documents: {
        requirements: `# What success looks like\n\n${task.goal}\n\n${task.requirements.map((item) => `- ${item}`).join('\n')}`,
        plan: `# A path forward\n\n${task.plan.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
        checklist: null,
      },
    })),
    warnings: [], loadedAt: '2026-09-16T00:00:00Z',
  }
}

export function workspaceBridgeFixture(initial: WorkspaceState = { current: null, recent: [] }): WorkspaceBridge {
  let state = structuredClone(initial)
  let remoteUrl: string | null = null
  function selected(id: string): WorkspaceSnapshot {
    if (!state.current || state.current.id !== id) throw new Error('The active workspace changed.')
    return state.current
  }
  return {
    getState: vi.fn(async () => state),
    openFolder: vi.fn(async () => null),
    openRecent: vi.fn(async () => state),
    refresh: vi.fn(async () => state),
    closeWorkspace: vi.fn(async () => { state = { current: null, recent: state.recent }; return state }),
    chooseParentFolder: vi.fn(async () => 'Q:\\Workspaces'),
    createRepository: vi.fn(async ({ parentPath, name }) => {
      const current: WorkspaceSnapshot = { id: 'created-workspace', name, title: name, root: `${parentPath}\\${name}`, tasks: [], warnings: [], loadedAt: '2026-09-16T00:00:00Z' }
      state = { current, recent: [current, ...state.recent] }
      return state
    }),
    getTaskCreationContext: vi.fn<WorkspaceBridge['getTaskCreationContext']>(async (id) => ({
      workspaceId: id, root: selected(id).root,
      members: [{ id: 'fixture-user', name: 'Fixture User' }],
      levels: [{ id: 'epic', title: 'Epic', rank: 0 }, { id: 'task', title: 'Task', rank: 1 }, { id: 'subtask', title: 'Subtask', rank: 2 }],
      parents: selected(id).tasks.map((task) => ({ id: task.id, title: task.title, level: task.kind === 'epic' ? 'epic' : 'task' })),
      types: ['feature', 'bug', 'chore', 'spike', 'doc', 'ops'], priorities: ['P0', 'P1', 'P2', 'P3'],
      defaults: { owner: 'fixture-user', level: 'task', type: 'feature', priority: 'P2' },
    })),
    createTask: vi.fn<WorkspaceBridge['createTask']>(async ({ workspaceId, draft }) => {
      const current = selected(workspaceId)
      const number = Math.max(0, ...current.tasks.map((task) => Number(task.id.slice(2)))) + 1
      const taskId = `T-${String(number).padStart(4, '0')}`
      const task: TaskRecord = {
        id: taskId, title: draft.title, kind: draft.level ?? 'task', status: 'backlog', priority: draft.priority ?? 'P2',
        owner: draft.owner ?? 'fixture-user', summary: draft.description ?? '', goal: draft.description ?? '',
        nextAction: 'Review requirements', requirements: [], plan: [],
        checklist: (draft.acceptance ?? []).map((title, index) => ({ id: `CL-${String(index + 1).padStart(3, '0')}`, title, done: false })),
        ...(draft.parentId ? { parentId: draft.parentId } : {}),
      }
      state = { ...state, current: { ...current, tasks: [...current.tasks, task] } }
      return { state, taskId }
    }),
    getTaskAgentInstructions: vi.fn<WorkspaceBridge['getTaskAgentInstructions']>(async (request) => {
      const current = selected(request.workspaceId)
      return `Create task files in ${current.root} using task-documents create.\nRequest: ${request.goal}`
    }),
    getRepositoryStatus: vi.fn<WorkspaceBridge['getRepositoryStatus']>(async (id) => ({
      workspaceId: id, name: selected(id).name, branch: 'main', remoteUrl, credentialHelper: 'gcm',
    })),
    openRepositoryCreation: vi.fn<WorkspaceBridge['openRepositoryCreation']>(async (id) => { selected(id) }),
    getRepositoryPushPlan: vi.fn<WorkspaceBridge['getRepositoryPushPlan']>(async ({ workspaceId, remoteUrl }) => {
      const workspace = selected(workspaceId)
      return {
        workspaceId, branch: 'main', head: 'a'.repeat(40), remoteUrl, repositoryUrl: remoteUrl.replace(/\.git$/, ''), shell: 'powershell',
        commands: `git -C '${workspace.root}' remote add origin '${remoteUrl}'\ngit -C '${workspace.root}' push --set-upstream origin 'main:refs/heads/main'`,
      }
    }),
    verifyRepositoryPublication: vi.fn<WorkspaceBridge['verifyRepositoryPublication']>(async (request) => {
      selected(request.workspaceId)
      remoteUrl = request.remoteUrl
      return { url: remoteUrl.replace(/\.git$/, '') }
    }),
    getSessionLinks: vi.fn<WorkspaceBridge['getSessionLinks']>(async () => ({ document: { schemaVersion: '2.1', bindings: {} }, revision: null })),
    updateSessionLink: vi.fn(async () => { throw new Error('Session-link updates are not configured for this fixture.') }),
  }
}
