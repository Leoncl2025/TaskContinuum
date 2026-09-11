import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { WorkspaceState } from '../shared/workspace'
import { WorkspaceStore } from './workspaceStore'
import type { SessionOwner } from '../shared/sessionBindings'
import type { VSCodeChatTarget } from '../shared/remoteVSCode'
import type { AgentHostTarget } from '../shared/agentHost'

export function registerWorkspaceBridge(requireWindow: (event: IpcMainInvokeEvent) => BrowserWindow, allowDirectory: (root: string) => void, remoteOwner?: (root: string, target: VSCodeChatTarget) => Promise<SessionOwner | undefined>, verifyAgentHost?: (root: string, target: AgentHostTarget) => Promise<AgentHostTarget>) {
  const store = new WorkspaceStore(app.getPath('userData'), process.env.TASKCONTINUUM_WORKSPACE, remoteOwner, undefined, verifyAgentHost)
  function authorize(state: WorkspaceState): WorkspaceState {
    if (state.current) allowDirectory(state.current.root)
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
  handle('session-links', (_window, id) => store.getSessionLinks(id))
  handle('update-session-link', (_window, request) => store.updateSessionLink(request))
  handle('migrate-session-links', (_window, request) => store.migrateSessionLinks(request))
  return { currentRoot: async () => {
    const state = await store.getState()
    if (!state.current) throw new Error('Open a real task workspace before using shared sessions.')
    return state.current.root
  } }
}