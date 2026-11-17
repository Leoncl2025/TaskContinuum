import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../src/shared/desktop'
import type { FileDeliveryBridge, FileDeliverySettings } from '../src/shared/fileDelivery'
import { FileMcpSettings } from '../src/renderer/components/FileMcpSettings'

afterEach(() => { cleanup(); delete window.desktop })

function fixture() {
  const state: FileDeliverySettings = {
    inboxId: '11111111-1111-4111-8111-111111111111',
    senders: [{ clientId: '22222222-2222-4222-8222-222222222222', machineName: 'Runner A', allowed: false }],
    roots: [{ id: '33333333-3333-4333-8333-333333333333', path: 'C:\\Downloads\\Received' }],
    transfers: [{ direction: 'outgoing', status: {
      transferId: '44444444-4444-4444-8444-444444444444', deviceId: '55555555-5555-4555-8555-555555555555',
      state: 'interrupted', receivedBytes: 256, files: [], expiresAt: '2030-01-01T00:00:00Z',
    } }],
    configurations: { vscode: '{"servers":{"taskcontinuum-files":{"command":"node"}}}', mcpServers: '{"mcpServers":{}}' },
    nodeVersion: 'v24.22.2',
  }
  const bridge = {
    settings: vi.fn(async () => structuredClone(state)),
    setSender: vi.fn(async (_id: string, allowed: boolean) => { state.senders[0].allowed = allowed }),
    addDestination: vi.fn(async () => {}),
    removeDestination: vi.fn<FileDeliveryBridge['removeDestination']>(async () => {}),
    resume: vi.fn<FileDeliveryBridge['resume']>(async () => state.transfers[0].status),
    cancel: vi.fn<FileDeliveryBridge['cancel']>(async () => state.transfers[0].status),
  } satisfies FileDeliveryBridge
  const desktop = { files: bridge, copyText: vi.fn<DesktopBridge['copyText']>(async () => {}) } satisfies Pick<DesktopBridge, 'files' | 'copyText'>
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  return { state, bridge, desktop }
}

it('copies the selected client format and requires explicit actions for receive and directory permissions', async () => {
  const setup = fixture()
  render(<FileMcpSettings />)
  await screen.findByText('Local authenticated bridge')
  expect(setup.bridge.setSender).not.toHaveBeenCalled()
  expect(setup.bridge.addDestination).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mcpServers' } })
  fireEvent.click(screen.getByRole('button', { name: 'Copy MCP configuration' }))
  await waitFor(() => expect(setup.desktop.copyText).toHaveBeenCalledExactlyOnceWith(setup.state.configurations.mcpServers))
  await screen.findByText('Configuration copied.')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Receive files from Runner A' }))
  await waitFor(() => expect(setup.bridge.setSender).toHaveBeenCalledExactlyOnceWith(setup.state.senders[0].clientId, true))
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked())
  fireEvent.click(screen.getByRole('button', { name: 'Revoke directory' }))
  await waitFor(() => expect(setup.bridge.removeDestination).toHaveBeenCalledExactlyOnceWith(setup.state.roots[0].id))
})

it('surfaces transfer failures and calls resume and cancel only for explicit user actions', async () => {
  const setup = fixture()
  setup.bridge.resume.mockRejectedValueOnce(new Error('The receiver is offline.'))
  render(<FileMcpSettings />)
  fireEvent.click(await screen.findByRole('button', { name: 'Resume delivery' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The receiver is offline.')
  expect(setup.bridge.resume).toHaveBeenCalledExactlyOnceWith(setup.state.transfers[0].status.transferId)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel delivery' }))
  await waitFor(() => expect(setup.bridge.cancel).toHaveBeenCalledExactlyOnceWith(setup.state.transfers[0].status.transferId))
})

it('reports a missing desktop API and an unsupported Node runtime rather than claiming the adapter is ready', async () => {
  const unsupported = render(<FileMcpSettings />)
  expect(screen.getByText(/Available in the desktop app/)).toBeInTheDocument()
  unsupported.unmount()
  const setup = fixture()
  setup.state.nodeVersion = 'v26.0.0'
  render(<FileMcpSettings />)
  expect(await screen.findByText(/Put Node 24 on the agent Host PATH/)).toBeInTheDocument()
})

it('keeps the MCP entry discoverable without a selected workspace and does not issue workspace-scoped IPC', () => {
  const setup = fixture()
  render(<FileMcpSettings workspaceReady={false} />)
  expect(screen.getByRole('heading', { name: 'MCP file delivery' })).toBeInTheDocument()
  expect(screen.getByText(/Open a task workspace to configure MCP/)).toBeInTheDocument()
  expect(setup.bridge.settings).not.toHaveBeenCalled()
})
