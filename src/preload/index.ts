import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopInfo } from '../shared/desktop'
import type { CopilotBridge, CopilotEvent } from '../shared/sessions'

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