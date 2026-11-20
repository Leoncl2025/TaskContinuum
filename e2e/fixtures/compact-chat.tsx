import { createRoot } from 'react-dom/client'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ResponsePartKind, Turn } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostHistoryTransfer, AgentHostSession, AgentHostView } from '../../src/shared/agentHost'
import type { WorkspaceGitSyncStatus } from '../../src/shared/gitSync'
import type { WorkspaceSnapshot } from '../../src/shared/workspace'
import App from '../../src/renderer/App'
import { defaultLayout, saveLayout } from '../../src/renderer/layout'
import { AgentHostPanel } from '../../src/renderer/components/AgentHostPanel'
import { MachineAliasesContext } from '../../src/renderer/machineAliases'
import { fixtureTasks } from '../../test/task-fixture'
import '@vscode/codicons/dist/codicon.css'
import '../../src/renderer/styles.css'

const parameters = new URLSearchParams(location.search)
const long = parameters.has('long')
const groupDemo = parameters.has('group-demo')
const target = {
  owner: { clientId: '11111111-1111-4111-8111-111111111111', machineName: groupDemo ? 'BUILD-01' : 'BUILD-WORKSTATION' },
  sessionId: `copilotcli:/${'s'.repeat(120)}`,
  chatId: `ahp-chat:/${'c'.repeat(120)}`,
}
const view: AgentHostView = {
  target, state: 'connected', canSend: true, readOnly: false, terminals: {},
  chat: {
    resource: target.chatId, title: groupDemo ? 'Performance lead' : long ? 'A detailed release plan with a very long title '.repeat(8) : 'A focused release plan',
    modifiedAt: '', status: 1,
    turns: Array.from({ length: parameters.has('markdown') ? 1 : 6 }, (_, index) => ({
      id: `turn-${index}`, state: 'complete' as Turn['state'],
      message: { text: 'Keep the conversation in focus and make room for the next idea.', origin: { kind: MessageKind.User } },
      responseParts: [{ kind: 'markdown' as ResponsePartKind.Markdown, id: `response-${index}`, content: parameters.get('markdown') ?? '## A simpler workspace\n\nKeep essential context close to the conversation. Connection details remain available without taking space away from your work.\n\n[**Release notes**](https://example.com/release-notes) / [`plan.md`](file:///C:/layout-fixture/plan.md)\n\n- Clear hierarchy\n- Predictable actions\n- More room to read' }],
      usage: undefined,
    })),
  },
}
if (parameters.has('lazy')) view.history = { hasMore: true, loadedTurns: 6, totalTurns: 8, loading: false }
let historyLoads = 0
let releaseHistory: (() => void) | undefined
let watchCounter = 0
const activeWatches = new Map<string, typeof target>()
const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
const historyListeners = new Set<Parameters<AgentHostBridge['onHistoryTransfer']>[0]>()
function viewForTarget(requested: typeof target): AgentHostView {
  if (requested.chatId === target.chatId) return structuredClone(view)
  const matched = sidebarSessions.find((item) => item.chatId === requested.chatId)
  return {
    target: requested,
    state: view.state,
    canSend: view.canSend,
    readOnly: view.readOnly,
    terminals: {},
    chat: {
      resource: requested.chatId,
      title: matched?.title ?? 'Secondary session',
      modifiedAt: matched?.updatedAt ?? '',
      status: 1,
      turns: [
        {
          id: `${requested.chatId}-turn-0`,
          state: 'complete' as Turn['state'],
          message: { text: `Verify side-by-side workflow for "${matched?.title ?? 'Secondary session'}".`, origin: { kind: MessageKind.User } },
          responseParts: [{
            kind: 'markdown' as ResponsePartKind.Markdown,
            id: `${requested.chatId}-resp-0`,
            content: `### ${matched?.title ?? 'Secondary session'}\n\nRunning independently in its own pane while sharing the single underlying Agent Host transport.\n\n- Zero remount on split or swap\n- Independent scroll & draft state\n- Instant pop-out to a dedicated desktop window`,
          }],
          usage: undefined,
        },
      ],
    },
  }
}
const emit = () => {
  if (!activeWatches.size) {
    for (const listener of listeners) listener({ id: 'fixture-watch', view: structuredClone(view) })
  } else {
    for (const [id, watchedTarget] of activeWatches) {
      const payload = viewForTarget(watchedTarget)
      for (const listener of listeners) listener({ id, view: payload })
    }
  }
  for (const listener of historyListeners) listener({ root: 'C:\\layout-fixture', target, progress: view.historyTransfer })
}
const unsupported = async (): Promise<never> => { throw new Error('This layout fixture does not perform native operations.') }
const calls = { watch: 0, unwatch: 0, send: 0 }
const demoRunner = { clientId: '33333333-3333-4333-8333-333333333333', machineName: 'LAB-02' }
const sidebarSessions: AgentHostSession[] = [
  { ...target, title: view.chat!.title, provider: 'copilotcli', createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', canSend: true },
  ...(groupDemo ? ['Benchmark runner', 'Local tests', 'Local build', 'Migration analysis', 'Compatibility review', 'Release notes', 'Code review']
    .map((title, index) => ({ title, createdAt: `2026-11-${11 + index}T09:00:00.000Z`, updatedAt: `2026-11-${11 + index}T12:00:00.000Z` })) : [
    { title: 'Investigate session creation', createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-16T14:30:00.000Z' },
    { title: 'A deliberately long conversation title that should remain on one compact line', createdAt: '2026-11-13T09:00:00.000Z', updatedAt: '2026-11-14T11:00:00.000Z' },
    { title: 'Verify the next release', createdAt: '2026-11-15T09:00:00.000Z', updatedAt: '2026-11-15T09:30:00.000Z' },
  ]).map((entry, index) => ({
    ...target, sessionId: `copilotcli:/compact-${index}`, chatId: `ahp-chat:/compact-${index}`,
    owner: groupDemo && index >= 3 ? demoRunner : target.owner,
    title: entry.title, provider: 'copilotcli', createdAt: entry.createdAt, updatedAt: entry.updatedAt, canSend: true,
  })),
]
window.agentHost = {
  list: async () => ({ sessions: parameters.has('sessions') ? sidebarSessions : [], warnings: [] }),
  models: async () => [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }],
  watch: async (requestedTarget) => {
    calls.watch++
    const id = `fixture-watch-${++watchCounter}`
    const resolved = requestedTarget ?? target
    activeWatches.set(id, resolved)
    const payload = viewForTarget(resolved)
    for (const listener of listeners) listener({ id, view: payload })
    for (const listener of historyListeners) listener({ root: 'C:\\layout-fixture', target: resolved, progress: payload.historyTransfer })
    return id
  },
  unwatch: async (id) => { calls.unwatch++; activeWatches.delete(id) }, terminal: async () => {}, releaseTerminal: async () => {},
  loadHistory: async () => {
    if (!view.history?.hasMore || !view.chat) throw new Error('No earlier history is available in this fixture.')
    historyLoads++
    view.history.loading = true
    emit()
    await new Promise<void>((resolve) => { releaseHistory = resolve })
    view.chat.turns.unshift(...Array.from({ length: 2 }, (_, index) => ({
      ...structuredClone(view.chat!.turns[0]), id: `older-${index}`,
      message: { text: `Earlier question ${index}`, origin: { kind: MessageKind.User } },
      responseParts: [{ kind: 'markdown' as ResponsePartKind.Markdown, id: `older-answer-${index}`, content: '## Earlier answer\n\nPreviously retained conversation content.\n\n- Earlier context\n- Another earlier detail' }],
    })))
    view.history = { hasMore: false, loadedTurns: view.chat.turns.length, totalTurns: view.chat.turns.length, loading: false }
    emit()
  },
  send: async () => { calls.send++; return unsupported() }, cancel: unsupported, resolveDelivery: unsupported,
  localCreationHosts: async () => [], localCreations: async () => [],
  creationWorkers: async () => [], creations: async () => [],
  createLocal: unsupported, localCreationStatus: unsupported, create: unsupported,
  creationStatus: unsupported, bindCreation: unsupported, abandonCreation: unsupported,
  onView: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  onHistoryTransfer: (listener) => { historyListeners.add(listener); return () => { historyListeners.delete(listener) } },
}
const status: WorkspaceGitSyncStatus = {
  enabled: true, workspaceId: 'fixture', intervalMs: 15000, state: 'idle', pending: 0,
  provisionalTasks: [], conflicts: [], peers: [], revision: 'a'.repeat(64),
  machineAliases: { [target.owner.clientId]: long ? 'Studio build workstation '.repeat(3) : 'Studio', ...(groupDemo ? { [demoRunner.clientId]: 'Runner' } : {}) },
}
declare global {
  interface Window {
    compactChatFixture: {
      setState(state: AgentHostView['state'], readOnly?: boolean): void
      setHistoryTransfer(progress: AgentHostHistoryTransfer | undefined): void
      completeHistoryLoad(): void
      historyLoads: number
      calls: typeof calls
    }
  }
}
window.compactChatFixture = {
  calls,
  setState(state, readOnly = false) {
    view.state = state
    view.readOnly = readOnly
    view.canSend = state === 'connected' && !readOnly
    emit()
  },
  setHistoryTransfer(progress) { view.historyTransfer = progress; emit() },
  completeHistoryLoad() {
    if (!releaseHistory) throw new Error('No fixture history page is waiting.')
    const release = releaseHistory
    releaseHistory = undefined
    release()
  },
  get historyLoads() { return historyLoads },
}
const root = createRoot(document.getElementById('root')!)
if (parameters.has('workbench')) {
  const workspace: WorkspaceSnapshot = {
    id: 'fixture', name: 'Layout fixture', title: 'Layout fixture', root: 'C:\\layout-fixture',
    loadedAt: '', warnings: [],
    tasks: [
      { ...fixtureTasks[1], id: 'T-0002', title: groupDemo ? 'Performance and release' : 'Fix Connection issues', parentId: undefined,
        documents: { requirements: '## Release requirements\n\n[**Documentation**](https://example.com/docs) / [`plan.md`](file:///C:/layout-fixture/plan.md)', plan: null, checklist: null } },
      { ...fixtureTasks[1], id: 'T-0003', title: 'Sept-2026 planning and release coordination', parentId: undefined },
    ],
  }
  const state = { current: workspace, recent: [workspace] }
  window.workspace = {
    getState: async () => state, openFolder: async () => state, openRecent: async () => state, refresh: async () => state,
    closeWorkspace: unsupported, chooseParentFolder: unsupported, createRepository: unsupported,
    getTaskCreationContext: unsupported, createTask: unsupported, getTaskAgentInstructions: unsupported,
    getRepositoryStatus: unsupported, openRepositoryCreation: unsupported,
    getRepositoryPushPlan: unsupported, verifyRepositoryPublication: unsupported,
    getSessionLinks: async () => ({
      document: { schemaVersion: '2.1', bindings: { 'T-0002': parameters.has('sessions')
        ? sidebarSessions.map(({ sessionId, chatId, owner }) => ({ provider: 'agent-host' as const, sessionId, chatId, owner }))
        : [{ provider: 'agent-host', ...target }] } },
      revision: 'a'.repeat(64), localOwner: parameters.has('sessions')
        ? { clientId: '22222222-2222-4222-8222-222222222222', machineName: 'Local desktop' } : target.owner,
    }),
    updateSessionLink: unsupported,
  }
  window.remoteVSCode = {
    gitSync: {
      status: async () => status, enable: unsupported, disable: unsupported, syncNow: unsupported,
      revokeDevice: unsupported, setMachineAlias: unsupported, setSetting: unsupported, openSettings: unsupported,
      onStatusChanged: () => () => {}, onBindingsChanged: () => () => {},
    },
  }
  window.desktop = {
    getInfo: async () => ({ name: 'Task Continuum', version: 'layout-fixture', platform: 'win32', security: { contextIsolated: true, sandboxed: true } }),
    minimize: unsupported, toggleMaximize: unsupported, close: unsupported, copyText: unsupported,
    getFullScreen: async () => false, toggleFullScreen: unsupported, onFullScreenChanged: () => () => {},
  }
  saveLayout({ ...defaultLayout, sidebar: parameters.has('panes'), details: parameters.has('panes'), theme: parameters.get('theme') === 'dark' ? 'dark' : 'light' })
  root.render(<App />)
} else root.render(
  <div className="workbench" data-theme={parameters.get('theme') ?? 'light'}>
    <MachineAliasesContext.Provider value={{ status, refresh: async () => status }}>
      <AgentHostPanel task={fixtureTasks[1]} target={target} onClose={() => {}} onDetach={() => {}} onDevices={() => {}} />
    </MachineAliasesContext.Provider>
  </div>,
)
