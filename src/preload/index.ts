import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopInfo } from '../shared/desktop'
import type { CopilotBridge, CopilotEvent } from '../shared/sessions'
import type { WorkspaceBridge } from '../shared/workspace'
import type { SharedDesktopBridge, SharedDesktopUpdate } from '../shared/sharedSessions'
import type { VSCodeChatBridge } from '../shared/vscodeChat'
import type { RemoteVSCodeBridge, VSCodeChatTarget } from '../shared/remoteVSCode'

const bridge: DesktopBridge = {
  getInfo: async () => {
    const info: Omit<DesktopInfo, 'security'> = await ipcRenderer.invoke('desktop:info')
    return { ...info, security: { contextIsolated: process.contextIsolated, sandboxed: process.sandboxed } }
  },
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop:toggle-maximize'),
  close: () => ipcRenderer.invoke('desktop:close'),
}

contextBridge.exposeInMainWorld('desktop', bridge)

const copilot: CopilotBridge = {
  getStatus: () => ipcRenderer.invoke('copilot:status'),
  connect: () => ipcRenderer.invoke('copilot:connect'),
  disconnect: () => ipcRenderer.invoke('copilot:disconnect'),
  listSessions: () => ipcRenderer.invoke('copilot:sessions'),
  listModels: () => ipcRenderer.invoke('copilot:models'),
  chooseDirectory: () => ipcRenderer.invoke('copilot:choose-directory'),
  createSession: (options) => ipcRenderer.invoke('copilot:create', options),
  resumeSession: (id) => ipcRenderer.invoke('copilot:resume', id),
  previewImport: (id) => ipcRenderer.invoke('copilot:preview-import', id),
  importSession: (token, options) => ipcRenderer.invoke('copilot:import', token, options),
  send: (request) => ipcRenderer.invoke('copilot:send', request),
  abort: (id) => ipcRenderer.invoke('copilot:abort', id),
  respond: (id, response) => ipcRenderer.invoke('copilot:respond', id, response),
  onEvent: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: CopilotEvent) => listener(value)
    ipcRenderer.on('copilot:event', receive)
    return () => ipcRenderer.removeListener('copilot:event', receive)
  },
}

contextBridge.exposeInMainWorld('copilot', copilot)

const vscodeChat: VSCodeChatBridge = {
  read: (identity) => ipcRenderer.invoke('vscode-chat:read', identity),
  connect: (identity) => ipcRenderer.invoke('vscode-chat:connect', identity),
  open: (identity) => ipcRenderer.invoke('vscode-chat:open', identity),
  send: (identity, commandId, text) => ipcRenderer.invoke('vscode-chat:send', identity, commandId, text),
  watch: (identity) => ipcRenderer.invoke('vscode-chat:watch', identity),
  onChange: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, identity: VSCodeChatTarget) => listener(identity)
    ipcRenderer.on('vscode-chat:changed', receive)
    return () => ipcRenderer.removeListener('vscode-chat:changed', receive)
  },
}
contextBridge.exposeInMainWorld('vscodeChat', vscodeChat)

const remoteVSCode: RemoteVSCodeBridge = {
  devTunnels: {
    status: (refresh) => ipcRenderer.invoke('remote-vscode:tunnel-status', refresh),
    login: () => ipcRenderer.invoke('remote-vscode:tunnel-login'),
    publish: () => ipcRenderer.invoke('remote-vscode:tunnel-publish'),
    stop: () => ipcRenderer.invoke('remote-vscode:tunnel-stop'),
    cancel: () => ipcRenderer.invoke('remote-vscode:tunnel-cancel'),
    reset: () => ipcRenderer.invoke('remote-vscode:tunnel-reset'),
    installationGuide: () => ipcRenderer.invoke('remote-vscode:tunnel-installation'),
  },
  exportIdentity: (managed) => ipcRenderer.invoke('remote-vscode:export-identity', managed),
  importInvitation: (hostAlias) => ipcRenderer.invoke('remote-vscode:import-invitation', hostAlias),
  list: () => ipcRenderer.invoke('remote-vscode:list'),
  connect: (id) => ipcRenderer.invoke('remote-vscode:connect', id),
  disconnect: (id) => ipcRenderer.invoke('remote-vscode:disconnect', id),
  forget: (id) => ipcRenderer.invoke('remote-vscode:forget', id),
  share: (identity, canSend, managed) => ipcRenderer.invoke('remote-vscode:share', identity, canSend, managed),
  grants: (identity) => ipcRenderer.invoke('remote-vscode:grants', identity),
  revoke: (identity, grantId) => ipcRenderer.invoke('remote-vscode:revoke', identity, grantId),
}
contextBridge.exposeInMainWorld('remoteVSCode', remoteVSCode)

const workspace: WorkspaceBridge = {
  getState: () => ipcRenderer.invoke('workspace:state'),
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  openRecent: (id) => ipcRenderer.invoke('workspace:open-recent', id),
  refresh: () => ipcRenderer.invoke('workspace:refresh'),
  useDemo: () => ipcRenderer.invoke('workspace:demo'),
  getSessionLinks: (id) => ipcRenderer.invoke('workspace:session-links', id),
  updateSessionLink: (request) => ipcRenderer.invoke('workspace:update-session-link', request),
  migrateSessionLinks: (request) => ipcRenderer.invoke('workspace:migrate-session-links', request),
}

contextBridge.exposeInMainWorld('workspace', workspace)

const sharedSessions: SharedDesktopBridge = {
  identity: () => ipcRenderer.invoke('shared:identity'),
  exportIdentity: () => ipcRenderer.invoke('shared:export-identity'),
  list: () => ipcRenderer.invoke('shared:list'),
  publish: (options) => ipcRenderer.invoke('shared:publish', options),
  join: () => ipcRenderer.invoke('shared:join'),
  open: (id) => ipcRenderer.invoke('shared:open', id),
  cached: (id) => ipcRenderer.invoke('shared:cached', id),
  disconnect: (id) => ipcRenderer.invoke('shared:disconnect', id),
  send: (id, commandId, text) => ipcRenderer.invoke('shared:send', id, commandId, text),
  stop: (id, commandId) => ipcRenderer.invoke('shared:stop', id, commandId),
  respond: (id, interactionId, answer) => ipcRenderer.invoke('shared:respond', id, interactionId, answer),
  invite: (id, host, role) => ipcRenderer.invoke('shared:invite', id, host, role),
  exportCheckpoint: (id) => ipcRenderer.invoke('shared:export-checkpoint', id),
  previewCheckpoint: () => ipcRenderer.invoke('shared:preview-checkpoint'),
  keepCheckpoint: (token) => ipcRenderer.invoke('shared:keep-checkpoint', token),
  fork: (token, directory) => ipcRenderer.invoke('shared:fork', token, directory),
  stopHost: (id) => ipcRenderer.invoke('shared:stop-host', id),
  restartHost: (id) => ipcRenderer.invoke('shared:restart-host', id),
  onUpdate: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, update: SharedDesktopUpdate) => listener(update)
    ipcRenderer.on('shared:update', receive)
    return () => ipcRenderer.removeListener('shared:update', receive)
  },
}

contextBridge.exposeInMainWorld('sharedSessions', sharedSessions)