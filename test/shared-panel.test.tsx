import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedSessionPanel } from '../src/renderer/components/SharedSessionPanel'
import type { SharedDesktopBridge, SharedDesktopUpdate, SharedView } from '../src/shared/sharedSessions'
import { demoTasks } from '../src/renderer/data/tasks'

afterEach(() => { delete window.sharedSessions })

function fixture(online = true) {
  const view: SharedView = {
    session: { schemaVersion: 1, id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), taskId: demoTasks[0].id, mode: 'checkpoint', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'Machine B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } },
    actor: { kind: 'user', id: 'alice', name: 'Alice', machineId: 'A', machineName: 'Machine A' }, permissions: ['read', 'send', 'approve', 'stop', 'checkpoint'], online, events: [],
  }
  const listeners = new Set<(update: SharedDesktopUpdate) => void>()
  const bridge: SharedDesktopBridge = {
    identity: vi.fn(async () => view.actor), exportIdentity: vi.fn(async () => true),
    list: vi.fn(async () => [{ id: view.session.id, workspaceId: view.session.workspaceId, taskId: view.session.taskId, owner: 'Machine B', machine: 'Machine A', mode: view.session.mode }]),
    publish: vi.fn(async () => view), join: vi.fn(async () => view), open: vi.fn(async () => view), cached: vi.fn(async () => ({ ...view, online: false })),
    disconnect: vi.fn(async () => {}), send: vi.fn(async () => {}), stop: vi.fn(async () => {}), respond: vi.fn(async () => {}),
    invite: vi.fn(async () => true), exportCheckpoint: vi.fn(async () => 'Exported locally'), previewCheckpoint: vi.fn(async () => null), keepCheckpoint: vi.fn(async () => ({ ...view, online: false })), fork: vi.fn(async () => view), stopHost: vi.fn(async () => {}), restartHost: vi.fn(async () => view),
    onUpdate: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.sharedSessions = bridge
  return { bridge, view, emit: (update: SharedDesktopUpdate) => { for (const listener of listeners) listener(update) } }
}

describe('shared session desktop panel', () => {
  it('shows participant and execution machine identities and routes messages to the logical session', async () => {
    const host = fixture()
    const user = userEvent.setup()
    render(<SharedSessionPanel root="Q:\\workspace" task={demoTasks[0]} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Connect shared session' }))
    expect(await screen.findByText('Live on Machine B')).toBeInTheDocument()
    expect(screen.getByText('Alice @ Machine A')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message shared Agent' }), 'Continue on B')
    await user.click(screen.getByRole('button', { name: 'Send shared message' }))
    expect(host.bridge.send).toHaveBeenCalledWith(host.view.session.id, expect.any(String), 'Continue on B')
  })

  it('renders new owner events and retains the transcript when the connection goes offline', async () => {
    const host = fixture()
    const user = userEvent.setup()
    render(<SharedSessionPanel root="Q:\\workspace" task={demoTasks[0]} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Connect shared session' }))
    await screen.findByText('Live on Machine B')
    const event = { sessionId: host.view.session.id, epoch: 1, at: new Date().toISOString(), actor: { ...host.view.actor, kind: 'agent' as const, id: 'agent-B', machineId: 'B', machineName: 'Machine B' }, commandId: 'request' }
    act(() => {
      host.emit({ sessionId: host.view.session.id, event: { ...event, type: 'started', seq: 1 } })
      host.emit({ sessionId: host.view.session.id, event: { ...event, type: 'delta', seq: 2, text: 'Working on B' } })
      host.emit({ sessionId: host.view.session.id, online: false, error: 'Owner disconnected' })
    })
    expect(screen.getByText('Working on B')).toBeInTheDocument()
    expect(screen.getByText('Offline / 2 cached events')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message shared Agent' }), 'Unsent draft')
    expect(screen.getByRole('button', { name: 'Send shared message' })).toBeDisabled()
    expect(host.bridge.send).not.toHaveBeenCalled()
  })

  it('disconnects only the desktop subscription on unmount', async () => {
    const host = fixture()
    const user = userEvent.setup()
    const result = render(<SharedSessionPanel root="Q:\\workspace" task={demoTasks[0]} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Connect shared session' }))
    await screen.findByText('Live on Machine B')
    result.unmount()
    await waitFor(() => expect(host.bridge.disconnect).toHaveBeenCalledWith(host.view.session.id))
    expect(host.bridge.stop).not.toHaveBeenCalled()
    expect(host.bridge.stopHost).not.toHaveBeenCalled()
  })

  it('reuses the command ID when retrying a message after an acknowledgement is lost', async () => {
    const host = fixture()
    vi.mocked(host.bridge.send).mockRejectedValueOnce(new Error('Connection dropped before acknowledgement.')).mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    render(<SharedSessionPanel root="Q:\\workspace" task={demoTasks[0]} onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Connect shared session' }))
    await screen.findByText('Live on Machine B')
    await user.type(screen.getByRole('textbox', { name: 'Message shared Agent' }), 'Run this once')
    await user.click(screen.getByRole('button', { name: 'Send shared message' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: 'Message shared Agent' })).toHaveValue('Run this once')
    await user.click(screen.getByRole('button', { name: 'Send shared message' }))
    const calls = vi.mocked(host.bridge.send).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(screen.getByRole('textbox', { name: 'Message shared Agent' })).toHaveValue('')
  })
})