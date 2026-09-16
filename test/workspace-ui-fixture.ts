import { vi } from 'vitest'
import type { WorkspaceBridge, WorkspaceSnapshot, WorkspaceState } from '../src/shared/workspace'
import { fixtureTasks } from './task-fixture'

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
  let published = false
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
    getRepositoryStatus: vi.fn(async (id) => ({
      workspaceId: id, name: selected(id).name, branch: 'main', remoteUrl: published ? `https://github.com/fixture-user/${selected(id).name}` : null,
      published, github: { installed: true, authenticated: true, login: 'fixture-user' },
    })),
    publishRepository: vi.fn(async ({ workspaceId }) => {
      published = true
      return { url: `https://github.com/fixture-user/${selected(workspaceId).name}` }
    }),
    getSessionLinks: vi.fn<WorkspaceBridge['getSessionLinks']>(async () => ({ document: { schemaVersion: 1, bindings: {} }, revision: null })),
    updateSessionLink: vi.fn(async () => { throw new Error('Session-link updates are not configured for this fixture.') }),
  }
}
