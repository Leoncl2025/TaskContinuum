import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { WorkspaceState } from '../shared/workspace'
import { WorkspaceStore } from './workspaceStore'
import type { AgentHostTarget } from '../shared/agentHost'

export function registerWorkspaceBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, verifyAgentHost?: (root: string, target: AgentHostTarget) => Promise<AgentHostTarget>, onOpen?: (root: string) => Promise<void>) {
  const store = new WorkspaceStore(app.getPath('userData'), process.env.TASKCONTINUUM_WORKSPACE, verifyAgentHost)
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
  handle('open-recent', async (_window, id) => authorize(await store.openRecent(id)))
  handle('refresh', async () => authorize(await store.refresh()))
  handle('demo', () => store.useDemo())
  handle('session-links', async (_window, id) => { await authorize(await store.getState()); return store.getSessionLinks(id) })
  handle('update-session-link', async (_window, request) => { await authorize(await store.getState()); return store.updateSessionLink(request) })
  return { currentRoot: async () => {
    const state = await store.getState()
    if (!state.current) throw new Error('Open a real task workspace before using shared sessions.')
    return state.current.root
  } }
}