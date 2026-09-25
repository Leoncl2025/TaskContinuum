import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceGitSyncControls } from '../src/renderer/components/WorkspaceGitSyncControls'
import { gitSyncUiFixture } from './remote-config-ui-fixture'
import { MachineAliasesProvider } from '../src/renderer/MachineAliasesProvider'

afterEach(() => { cleanup(); delete window.remoteVSCode })

function enrolled() {
  const fixture = gitSyncUiFixture()
  fixture.setStatus({
    ...fixture.getStatus(), enabled: true, state: 'idle', revision: 'a'.repeat(64),
    localDevice: { deviceId: 'local-uuid', machineName: 'Actual-local' },
    peers: [{ deviceId: 'peer-uuid', machineName: 'Actual-remote', state: 'offline' }],
    machineAliases: { 'peer-uuid': 'Office' },
  })
  window.remoteVSCode = fixture.remote
  return fixture
}

it('requires an explicit enrollment action and exposes immediate synchronization and pause', async () => {
  const { api, remote } = gitSyncUiFixture()
  window.remoteVSCode = remote
  render(<WorkspaceGitSyncControls />)
  expect(await screen.findByRole('status')).toHaveTextContent('Off')
  expect(screen.getByText(/Trusted devices can access linked sessions/)).toHaveTextContent('Native approvals still apply; no automatic messages or new sessions.')
  expect(api.enable).not.toHaveBeenCalled()
  const enable = screen.getByRole('button', { name: 'Enable automatic links' })
  expect(enable).toHaveClass('primary-button')
  fireEvent.click(enable)
  expect(await screen.findByRole('button', { name: 'Pause automatic links' })).toHaveClass('secondary-button')
  expect(api.enable).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  await waitFor(() => expect(api.syncNow).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause automatic links' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Pause automatic links' }))
  await screen.findByRole('button', { name: 'Enable automatic links' })
  expect(api.disable).toHaveBeenCalledOnce()
})

it('shows provisional and conflict states on notification without waiting for polling', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  render(<WorkspaceGitSyncControls />)
  expect(await screen.findByRole('status')).toHaveTextContent('Off')
  fixture.setStatus({
    enabled: true, intervalMs: 15000, state: 'error', pending: 1, revision: 'a'.repeat(64),
    provisionalTasks: ['T-0009'], conflicts: ['T-0010'], peers: [], error: 'Push rejected. Pending changes retained.',
    settings: { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000 },
  })
  await act(async () => fixture.notify())
  expect(screen.getByText(/Provisional bindings: T-0009/)).toBeInTheDocument()
  expect(screen.getByText(/Configuration needs resolution: T-0010/)).toBeInTheDocument()
  expect(screen.getByText('Push rejected. Pending changes retained.')).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Automatically link enrolled peers'))
  await waitFor(() => expect(fixture.api.setSetting).toHaveBeenCalledWith('autoLink', false, 'a'.repeat(64)))
  vi.mocked(fixture.api.syncNow).mockRejectedValueOnce(new Error('Authentication required.'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  expect(await screen.findByText('Authentication required.')).toBeInTheDocument()
})

it('renames the local machine with a trimmed Unicode alias and restores its hostname with a blank save', async () => {
  const fixture = enrolled()
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  const local = await screen.findByRole('group', { name: 'Workspace machine Actual-local' })
  expect(within(local).getByText('This device')).toBeInTheDocument()
  expect(within(local).queryByRole('button', { name: 'Revoke automatic link' })).not.toBeInTheDocument()
  expect(screen.getByText(/Machine aliases sync with this workspace in its public configuration/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-local' }))
  const input = screen.getByRole('textbox', { name: 'Machine alias for Actual-local' })
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: '  开发机 💻  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  await screen.findByText('开发机 💻', { exact: true })
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenCalledExactlyOnceWith('local-uuid', '开发机 💻', 'a'.repeat(64))
  expect(within(local).getByText('Hostname: Actual-local')).toBeInTheDocument()
  const revision = fixture.getStatus().revision
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-local' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenLastCalledWith('local-uuid', null, revision)
  expect(within(local).getByText('Actual-local', { exact: true })).toBeInTheDocument()
  expect(fixture.api.enable).not.toHaveBeenCalled()
  expect(fixture.api.disable).not.toHaveBeenCalled()
  expect(fixture.api.revokeDevice).not.toHaveBeenCalled()
})

it('can cancel or clear an offline peer alias without connecting or revoking it', async () => {
  const fixture = enrolled()
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  const peer = await screen.findByRole('group', { name: 'Workspace machine Actual-remote' })
  expect(within(peer).getByText('offline')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-remote' }))
  expect(screen.getByRole('textbox')).toHaveValue('Office')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Do not save' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-remote' }))
  expect(screen.getByRole('textbox')).toHaveValue('Office')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-remote' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear alias' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenCalledExactlyOnceWith('peer-uuid', null, 'a'.repeat(64))
  expect(within(peer).getByText('Actual-remote', { exact: true })).toBeInTheDocument()
  expect(fixture.api.revokeDevice).not.toHaveBeenCalled()
  expect(fixture.api.syncNow).not.toHaveBeenCalled()
})

it.each([
  ['a'.repeat(81), 'Machine aliases must be 80 characters or fewer.'],
  ['Name\u0001', 'Machine aliases cannot contain control characters or multiple lines.'],
  ['First\u2028Second', 'Machine aliases cannot contain control characters or multiple lines.'],
])('validates an invalid alias before sending it: %j', async (value, message) => {
  const fixture = enrolled()
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Actual-local' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
  fireEvent.submit(screen.getByRole('form', { name: 'Rename Actual-local' }))
  expect(screen.getByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
})

it('rejects multiline paste instead of silently turning it into a different alias', async () => {
  const fixture = enrolled()
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Actual-remote' }))
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { getData: () => 'First line\nSecond line' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Machine aliases cannot contain control characters or multiple lines.')
  expect(screen.getByRole('textbox')).toHaveValue('Office')
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
})

it('keeps the alias draft and guards all actions while saving, then surfaces a failed save', async () => {
  const fixture = enrolled()
  let rejectSave!: (error: Error) => void
  vi.mocked(fixture.api.setMachineAlias).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Actual-remote' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this alias' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  for (const name of ['Save alias', 'Clear alias', 'Cancel', 'Pause automatic links', 'Sync now', 'Rename Actual-local', 'Revoke automatic link']) {
    expect(screen.getByRole('button', { name })).toBeDisabled()
  }
  fireEvent.submit(screen.getByRole('form', { name: 'Rename Actual-remote' }))
  expect(fixture.api.setMachineAlias).toHaveBeenCalledOnce()
  await act(async () => rejectSave(new Error('Alias could not be signed.')))
  expect(screen.getByRole('alert')).toHaveTextContent('Alias could not be signed.')
  expect(screen.getByRole('textbox')).toHaveValue('Keep this alias')
  expect(screen.getByRole('button', { name: 'Save alias' })).toBeEnabled()
  expect(screen.getByText('Office', { exact: true })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  await screen.findByText('Keep this alias', { exact: true })
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenCalledTimes(2)
})

it.each([false, true])('refreshes a stale revision without silently rebasing a draft (intervening sync: %s)', async (sync) => {
  const fixture = enrolled()
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Actual-remote' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My intended alias' } })
  fixture.setStatus({ ...fixture.getStatus(), revision: 'b'.repeat(64), machineAliases: { 'peer-uuid': 'Changed elsewhere' } })
  await act(async () => fixture.notify())
  expect(screen.getByText('Changed elsewhere', { exact: true })).toBeInTheDocument()
  if (sync) {
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save alias' })).toBeEnabled())
    expect(fixture.api.syncNow).toHaveBeenCalledOnce()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save alias' })).toBeEnabled())
  expect(screen.getByRole('alert')).toHaveTextContent('Workspace configuration changed.')
  expect(fixture.api.setMachineAlias).toHaveBeenCalledExactlyOnceWith('peer-uuid', 'My intended alias', 'a'.repeat(64))
  expect(screen.getByRole('textbox')).toHaveValue('My intended alias')
  expect(fixture.getStatus().machineAliases?.['peer-uuid']).toBe('Changed elsewhere')
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenLastCalledWith('peer-uuid', 'My intended alias', 'b'.repeat(64))
  expect(screen.getByText('My intended alias', { exact: true })).toBeInTheDocument()
})

it.each(['Save alias', 'Clear alias'])('resolves an alias conflict only through explicit %s', async (action) => {
  const fixture = enrolled()
  fixture.setStatus({ ...fixture.getStatus(), conflicts: ['alias:peer-uuid'], machineAliases: {} })
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  await screen.findByText(/This machine's alias has conflicting changes/)
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Rename Actual-remote' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Chosen alias' } })
  fireEvent.click(screen.getByRole('button', { name: action }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(fixture.api.setMachineAlias).toHaveBeenCalledExactlyOnceWith('peer-uuid', action === 'Save alias' ? 'Chosen alias' : null, 'a'.repeat(64))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('retains names while paused but requires automatic links to edit aliases', async () => {
  const fixture = enrolled()
  fixture.setStatus({ ...fixture.getStatus(), enabled: false, state: 'disabled' })
  render(<MachineAliasesProvider workspaceId="workspace"><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  await screen.findByText('Office', { exact: true })
  expect(screen.getByRole('button', { name: 'Rename Actual-remote' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Rename Actual-local' })).toBeDisabled()
  expect(screen.getByText(/Enable automatic links to edit aliases/)).toBeInTheDocument()
  expect(fixture.api.setMachineAlias).not.toHaveBeenCalled()
})

it('keeps original machine labels in standalone controls without a workspace alias provider', async () => {
  enrolled()
  render(<WorkspaceGitSyncControls />)
  const peer = await screen.findByRole('group', { name: 'Workspace machine Actual-remote' })
  expect(within(peer).getByText('Actual-remote', { exact: true })).toBeInTheDocument()
  expect(screen.queryByText('Office', { exact: true })).not.toBeInTheDocument()
})
