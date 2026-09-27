import { createRoot } from 'react-dom/client'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ResponsePartKind, Turn } from '@microsoft/agent-host-protocol'
import type { AgentHostBridge, AgentHostView } from '../../src/shared/agentHost'
import type { WorkspaceGitSyncStatus } from '../../src/shared/gitSync'
import { AgentHostPanel } from '../../src/renderer/components/AgentHostPanel'
import { MachineAliasesContext } from '../../src/renderer/machineAliases'
import { fixtureTasks } from '../../test/task-fixture'
import '@vscode/codicons/dist/codicon.css'
import '../../src/renderer/styles.css'

const parameters = new URLSearchParams(location.search)
const long = parameters.has('long')
const target = {
  owner: { clientId: '11111111-1111-4111-8111-111111111111', machineName: 'BUILD-WORKSTATION' },
  sessionId: `copilotcli:/${'s'.repeat(120)}`,
  chatId: `ahp-chat:/${'c'.repeat(120)}`,
}
const view: AgentHostView = {
  target, state: 'connected', canSend: true, readOnly: false, terminals: {},
  chat: {
    resource: target.chatId, title: long ? 'A detailed release plan with a very long title '.repeat(8) : 'A focused release plan',
    modifiedAt: '', status: 1,
    turns: Array.from({ length: 6 }, (_, index) => ({
      id: `turn-${index}`, state: 'complete' as Turn['state'],
      message: { text: 'Keep the conversation in focus and make room for the next idea.', origin: { kind: MessageKind.User } },
      responseParts: [{ kind: 'markdown' as ResponsePartKind.Markdown, id: `response-${index}`, content: '## A simpler workspace\n\nKeep essential context close to the conversation. Connection details remain available without taking space away from your work.\n\n- Clear hierarchy\n- Predictable actions\n- More room to read' }],
      usage: undefined,
    })),
  },
}
const listeners = new Set<Parameters<AgentHostBridge['onView']>[0]>()
const emit = () => { for (const listener of listeners) listener({ id: 'fixture-watch', view: structuredClone(view) }) }
const unsupported = async (): Promise<never> => { throw new Error('This layout fixture does not perform native operations.') }
window.agentHost = {
  list: async () => ({ sessions: [], warnings: [] }),
  models: async () => [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }],
  watch: async () => { emit(); return 'fixture-watch' },
  unwatch: async () => {}, terminal: async () => {}, releaseTerminal: async () => {},
  send: unsupported, cancel: unsupported, resolveDelivery: unsupported,
  localCreationHosts: async () => [], localCreations: async () => [],
  creationWorkers: async () => [], creations: async () => [],
  createLocal: unsupported, localCreationStatus: unsupported, create: unsupported,
  creationStatus: unsupported, bindCreation: unsupported, abandonCreation: unsupported,
  onView: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
}
const status: WorkspaceGitSyncStatus = {
  enabled: true, workspaceId: 'fixture', intervalMs: 15000, state: 'idle', pending: 0,
  provisionalTasks: [], conflicts: [], peers: [], revision: 'a'.repeat(64),
  machineAliases: { [target.owner.clientId]: long ? 'Studio build workstation '.repeat(3) : 'Studio' },
}
declare global {
  interface Window {
    compactChatFixture: {
      setState(state: AgentHostView['state'], readOnly?: boolean): void
    }
  }
}
window.compactChatFixture = {
  setState(state, readOnly = false) {
    view.state = state
    view.readOnly = readOnly
    view.canSend = state === 'connected' && !readOnly
    emit()
  },
}
createRoot(document.getElementById('root')!).render(
  <div className="workbench" data-theme={parameters.get('theme') ?? 'light'}>
    <MachineAliasesContext.Provider value={{ status, refresh: async () => status }}>
      <AgentHostPanel task={fixtureTasks[1]} target={target} onClose={() => {}} onDetach={() => {}} onDevices={() => {}} />
    </MachineAliasesContext.Provider>
  </div>,
)
