import { vi } from 'vitest'
import type { CopilotBridge, CopilotEvent, CopilotStatus, LocalSessionSummary } from '../src/shared/sessions'

export function mockCopilotBridge() {
  const listeners = new Set<(event: CopilotEvent) => void>()
  const emit = (event: CopilotEvent) => { for (const listener of listeners) listener(event) }
  let status: CopilotStatus = { state: 'disconnected', workingDirectory: 'Q:\\src\\Projects' }
  const native: LocalSessionSummary = { id: 'native-session', source: 'copilot', title: 'Existing CLI work', updatedAt: '2026-09-06T08:00:00Z', workingDirectory: status.workingDirectory }
  const source: LocalSessionSummary = { ...native, id: 'vscode:source', source: 'vscode', title: 'Existing VS Code work' }
  const messages = [{ id: 'previous', role: 'assistant' as const, text: 'Previous local answer', status: 'complete' as const }]
  const bridge: CopilotBridge = {
    getStatus: vi.fn(async () => status),
    connect: vi.fn(async () => { status = { ...status, state: 'ready', login: 'local-user', version: '1.0.83' }; return status }),
    disconnect: vi.fn(async () => { status = { ...status, state: 'disconnected' } }),
    listSessions: vi.fn(async () => ({ sessions: [native, source], warnings: [] })),
    listModels: vi.fn(async () => [{ id: 'test-model', name: 'Test model' }]),
    chooseDirectory: vi.fn(async () => status.workingDirectory),
    createSession: vi.fn(async () => ({ session: { ...native, id: 'new-session', title: 'New Copilot conversation' }, messages: [] })),
    resumeSession: vi.fn(async (id) => ({ session: { ...native, id }, messages })),
    previewImport: vi.fn(async () => ({ session: source, token: 'preview-token', messages, truncated: false })),
    importSession: vi.fn(async () => ({ session: { ...native, id: 'imported-session' }, messages, importedFrom: source })),
    send: vi.fn(async (request) => { emit({ type: 'delta', ...request, text: 'A real local response' }); emit({ type: 'complete', ...request }) }),
    abort: vi.fn(async () => {}),
    respond: vi.fn(async (id) => { emit({ type: 'interaction-resolved', id }) }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return { bridge, native, source, messages, emit, listeners }
}