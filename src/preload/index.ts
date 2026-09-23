import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopInfo } from '../shared/desktop'
import type { WorkspaceBridge } from '../shared/workspace'
import type { RemoteVSCodeBridge } from '../shared/remoteVSCode'
import type { AgentHostBridge, AgentHostView } from '../shared/agentHost'

const bridge: DesktopBridge = {
  getInfo: async () => {
    const info: Omit<DesktopInfo, 'security'> = await ipcRenderer.invoke('desktop:info')
    return { ...info, security: { contextIsolated: process.contextIsolated, sandboxed: process.sandboxed } }
  },
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop:toggle-maximize'),
  close: () => ipcRenderer.invoke('desktop:close'),
  copyText: (text) => ipcRenderer.invoke('desktop:copy-text', text),
}
contextBridge.exposeInMainWorld('desktop', bridge)

const agentHost: AgentHostBridge = {
  list: () => ipcRenderer.invoke('agent-host:list'),
  localCreationHosts: () => ipcRenderer.invoke('agent-host:local-creation-hosts'),
  localCreations: () => ipcRenderer.invoke('agent-host:local-creations'),
  createLocal: (request) => ipcRenderer.invoke('agent-host:create-local', request),
  localCreationStatus: (operationId) => ipcRenderer.invoke('agent-host:local-creation-status', operationId),
  creationWorkers: (taskId, location) => location === undefined ? ipcRenderer.invoke('agent-host:creation-workers', taskId) : ipcRenderer.invoke('agent-host:creation-workers', taskId, location),
  creations: (taskId) => ipcRenderer.invoke('agent-host:creations', taskId),
  create: (request) => ipcRenderer.invoke('agent-host:create', request),
  creationStatus: (operationId) => ipcRenderer.invoke('agent-host:creation-status', operationId),
  bindCreation: (operationId) => ipcRenderer.invoke('agent-host:bind-creation', operationId),
  models: (target) => ipcRenderer.invoke('agent-host:models', target),
  watch: (target) => ipcRenderer.invoke('agent-host:watch', target),
  unwatch: (id) => ipcRenderer.invoke('agent-host:unwatch', id),
  terminal: (watchId, resource, leaseId, retry) => ipcRenderer.invoke('agent-host:terminal', watchId, resource, leaseId, retry),
  releaseTerminal: (watchId, resource, leaseId) => ipcRenderer.invoke('agent-host:release-terminal', watchId, resource, leaseId),
  send: (target, id, text, images, model) => ipcRenderer.invoke('agent-host:send', target, id, text, images, model),
  cancel: (target, turnId) => ipcRenderer.invoke('agent-host:cancel', target, turnId),
  onView: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, value: { id: string; view: AgentHostView }) => listener(value)
    ipcRenderer.on('agent-host:view', receive)
    return () => ipcRenderer.removeListener('agent-host:view', receive)
  },
}
contextBridge.exposeInMainWorld('agentHost', agentHost)

const remoteVSCode: RemoteVSCodeBridge = {
  gitSync: {
    status: () => ipcRenderer.invoke('remote-vscode:git-status'),
    enable: () => ipcRenderer.invoke('remote-vscode:git-enable'),
    disable: () => ipcRenderer.invoke('remote-vscode:git-disable'),
    syncNow: () => ipcRenderer.invoke('remote-vscode:git-sync'),
    revokeDevice: (deviceId) => ipcRenderer.invoke('remote-vscode:git-revoke', deviceId),
    setSetting: (key, value, expectedRevision) => ipcRenderer.invoke('remote-vscode:git-setting', { key, value, expectedRevision }),
    openSettings: () => ipcRenderer.invoke('remote-vscode:git-open-settings'),
    onBindingsChanged: (listener) => {
      const receive = () => listener()
      ipcRenderer.on('remote-vscode:git-bindings-changed', receive)
      return () => ipcRenderer.removeListener('remote-vscode:git-bindings-changed', receive)
    },
  },
  devices: {
    list: () => ipcRenderer.invoke('remote-vscode:devices'),
    connect: (id) => ipcRenderer.invoke('remote-vscode:device-connect', id),
    disconnect: (id) => ipcRenderer.invoke('remote-vscode:device-disconnect', id),
    forget: (id) => ipcRenderer.invoke('remote-vscode:device-forget', id),
  },
  devTunnels: {
    status: (refresh) => ipcRenderer.invoke('remote-vscode:tunnel-status', refresh),
    login: () => ipcRenderer.invoke('remote-vscode:tunnel-login'),
    publish: () => ipcRenderer.invoke('remote-vscode:tunnel-publish'),
    stop: () => ipcRenderer.invoke('remote-vscode:tunnel-stop'),
    cancel: () => ipcRenderer.invoke('remote-vscode:tunnel-cancel'),
    reset: () => ipcRenderer.invoke('remote-vscode:tunnel-reset'),
    installationGuide: () => ipcRenderer.invoke('remote-vscode:tunnel-installation'),
  },
}
contextBridge.exposeInMainWorld('remoteVSCode', remoteVSCode)

const workspace: WorkspaceBridge = {
  getState: () => ipcRenderer.invoke('workspace:state'),
  openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
  chooseParentFolder: () => ipcRenderer.invoke('workspace:choose-parent-folder'),
  createRepository: (request) => ipcRenderer.invoke('workspace:create-repository', request),
  getTaskCreationContext: (id) => ipcRenderer.invoke('workspace:task-creation-context', id),
  createTask: (request) => ipcRenderer.invoke('workspace:create-task', request),
  getTaskAgentInstructions: (request) => ipcRenderer.invoke('workspace:task-agent-instructions', request),
  getRepositoryStatus: (id) => ipcRenderer.invoke('workspace:repository-status', id),
  openRepositoryCreation: (id) => ipcRenderer.invoke('workspace:open-repository-creation', id),
  getRepositoryPushPlan: (request) => ipcRenderer.invoke('workspace:repository-push-plan', request),
  verifyRepositoryPublication: (request) => ipcRenderer.invoke('workspace:verify-repository-publication', request),
  openRecent: (id) => ipcRenderer.invoke('workspace:open-recent', id),
  refresh: () => ipcRenderer.invoke('workspace:refresh'),
  closeWorkspace: () => ipcRenderer.invoke('workspace:close'),
  getSessionLinks: (id) => ipcRenderer.invoke('workspace:session-links', id),
  updateSessionLink: (request) => ipcRenderer.invoke('workspace:update-session-link', request),
}
contextBridge.exposeInMainWorld('workspace', workspace)
