import { app, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { WorkspaceState } from '../shared/workspace'
import { WorkspaceStore } from './workspaceStore'
import type { AgentHostTarget } from '../shared/agentHost'

export function registerWorkspaceBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, verifyAgentHost?: (root: string, target: AgentHostTarget) => Promise<AgentHostTarget>, onOpen?: (root: string) => Promise<void>) {
  const store = new WorkspaceStore(app.getPath('userData'), process.env.TASKCONTINUUM_WORKSPACE, verifyAgentHost)
  const taskCli = app.isPackaged
    ? join(dirname(app.getAppPath()), 'cli', 'task-documents.cjs')
    : join(app.getAppPath(), 'scripts', 'task-documents.mjs')
  async function authorize(state: WorkspaceState): Promise<WorkspaceState> {
    if (state.current) await onOpen?.(state.current.root)
    return state
  }
  function handle<Result>(channel: string, action: (window: BrowserWindow, value: unknown) => Promise<Result>): void {
    ipcMain.handle(`workspace:${channel}`, (event, value: unknown) => action(requireWindow(event), value))
  }
  handle('state', async () => authorize(await store.getState()))
  handle('open-folder', async (window) => {
    const state = await store.getState()
    const chosen = await dialog.showOpenDialog(window, { title: 'Open AgentDesk workspace', properties: ['openDirectory'], defaultPath: state.current?.root ?? process.cwd() })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return authorize(await store.openFolder(chosen.filePaths[0]))
  })
  handle('choose-parent-folder', async (window) => {
    const state = await store.getState()
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Choose the parent folder for a new task repository',
      properties: ['openDirectory'],
      defaultPath: state.current ? dirname(state.current.root) : process.cwd(),
    })
    return chosen.canceled ? null : chosen.filePaths[0] ?? null
  })
  handle('create-repository', async (_window, request) => authorize(await store.createRepository(request)))
  handle('task-creation-context', async (_window, id) => store.getTaskCreationContext(id))
  handle('create-task', async (_window, request) => store.createTask(request))
  handle('task-agent-instructions', async (_window, request) => store.getTaskAgentInstructions(request, taskCli))
  handle('repository-status', async (_window, id) => store.getRepositoryStatus(id))
  handle('open-repository-creation', async (_window, id) => { await shell.openExternal(await store.getRepositoryCreationUrl(id)) })
  handle('repository-push-plan', async (_window, request) => store.getRepositoryPushPlan(request))
  handle('verify-repository-publication', async (_window, request) => store.verifyRepositoryPublication(request))
  handle('open-recent', async (_window, id) => authorize(await store.openRecent(id)))
  handle('refresh', async () => authorize(await store.refresh()))
  handle('close', () => store.closeWorkspace())
  handle('session-links', async (_window, id) => { await authorize(await store.getState()); return store.getSessionLinks(id) })
  handle('update-session-link', async (_window, request) => { await authorize(await store.getState()); return store.updateSessionLink(request) })
  return { currentRoot: () => store.getCurrentRoot() }
}