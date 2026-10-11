import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceGitSyncStatus } from '../src/shared/gitSync'
import { MachineAliasesProvider } from '../src/renderer/MachineAliasesProvider'
import { machineLabel, useMachineAliases, useWorkspaceGitSync } from '../src/renderer/machineAliases'
import { WorkspaceGitSyncControls } from '../src/renderer/components/WorkspaceGitSyncControls'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

const owner = { clientId: 'immutable-device-id', machineName: 'Actual-host' }

function AliasLabel({ identity = owner }: { identity?: { clientId?: string; machineName: string } }) {
  return <span>{machineLabel(identity, useMachineAliases())}</span>
}

function StatusError() {
  const { error, refresh } = useWorkspaceGitSync()
  return <>{error && <p role="alert">{error}</p>}<button type="button" onClick={() => { void refresh() }}>Refresh aliases</button></>
}

afterEach(() => { cleanup(); delete window.remoteVSCode; vi.useRealTimers() })

it('shares one status subscription with Git controls and refreshes all labels on notification', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Desk' } })
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><WorkspaceGitSyncControls /></MachineAliasesProvider>)
  expect(await screen.findByText('Desk (Actual-host)')).toBeInTheDocument()
  expect(fixture.api.status).toHaveBeenCalledOnce()
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Studio' } })
  await act(async () => fixture.notify())
  expect(screen.getByText('Studio (Actual-host)')).toBeInTheDocument()
  expect(fixture.api.status).toHaveBeenCalledTimes(2)
})

it('falls back to actual names without a provider, without a stable owner key, or after clearing', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Desk', [owner.machineName]: 'Not an identity' } })
  const standalone = render(<AliasLabel />)
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
  expect(fixture.api.status).not.toHaveBeenCalled()
  standalone.unmount()
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><AliasLabel identity={{ machineName: owner.machineName }} /></MachineAliasesProvider>)
  await screen.findByText('Desk (Actual-host)')
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: {} })
  await act(async () => fixture.notify())
  expect(screen.getAllByText(owner.machineName)).toHaveLength(2)
})

it('polls for configuration changes when no notification arrives', async () => {
  vi.useFakeTimers()
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /></MachineAliasesProvider>)
  await act(async () => {})
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Polled alias' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('Polled alias (Actual-host)')).toBeInTheDocument()
  expect(fixture.api.status).toHaveBeenCalledTimes(2)
})

it('lets a slow status request finish instead of replacing it on every polling interval', async () => {
  vi.useFakeTimers()
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  let resolveStatus!: (value: WorkspaceGitSyncStatus) => void
  vi.mocked(fixture.api.status).mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /></MachineAliasesProvider>)
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(fixture.api.status).toHaveBeenCalledOnce()
  const status = { ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Slow status' } }
  fixture.setStatus(status)
  await act(async () => resolveStatus(status))
  expect(screen.getByText('Slow status (Actual-host)')).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fixture.api.status).toHaveBeenCalledTimes(2)
})

it('does not let an older refresh overwrite a newer status or surface a superseded failure', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  let resolveOld!: (value: WorkspaceGitSyncStatus) => void
  let rejectOld!: (error: Error) => void
  vi.mocked(fixture.api.status).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><StatusError /></MachineAliasesProvider>)
  const latest = { ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Latest' } }
  fixture.setStatus(latest)
  await act(async () => fixture.notify())
  expect(screen.getByText('Latest (Actual-host)')).toBeInTheDocument()
  await act(async () => resolveOld({ ...latest, machineAliases: { [owner.clientId]: 'Obsolete' } }))
  expect(screen.queryByText('Obsolete (Actual-host)')).not.toBeInTheDocument()
  vi.mocked(fixture.api.status).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
  act(() => fixture.notify())
  await act(async () => fixture.notify())
  await act(async () => rejectOld(new Error('Obsolete status failure')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('Latest (Actual-host)')).toBeInTheDocument()
})

it('clears the previous workspace immediately and discards its in-flight refresh after switching', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  const first = { ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'First workspace' } }
  fixture.setStatus(first)
  let resolveFirst!: (value: WorkspaceGitSyncStatus) => void
  let resolveSecond!: (value: WorkspaceGitSyncStatus) => void
  const rendered = render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><StatusError /></MachineAliasesProvider>)
  await screen.findByText('First workspace (Actual-host)')
  vi.mocked(fixture.api.status)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
  act(() => fixture.notify())
  rendered.rerender(<MachineAliasesProvider workspaceId="workspace-two"><AliasLabel /><StatusError /></MachineAliasesProvider>)
  expect(screen.queryByText('First workspace (Actual-host)')).not.toBeInTheDocument()
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
  await act(async () => resolveSecond({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Second workspace' } }))
  await act(async () => resolveFirst(first))
  expect(screen.getByText('Second workspace (Actual-host)')).toBeInTheDocument()
  expect(screen.queryByText('First workspace (Actual-host)')).not.toBeInTheDocument()
  rendered.rerender(<MachineAliasesProvider workspaceId={null}><AliasLabel /><StatusError /></MachineAliasesProvider>)
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(fixture.api.status).toHaveBeenCalledTimes(3)
})

it('surfaces current status failures and clears them after a successful explicit refresh', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  vi.mocked(fixture.api.status).mockRejectedValueOnce(new Error('Workspace configuration cannot be read.'))
  render(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><StatusError /></MachineAliasesProvider>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Workspace configuration cannot be read.')
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
  fixture.setStatus({ ...fixture.getStatus(), machineAliases: { [owner.clientId]: 'Recovered' } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh aliases' }))
  await screen.findByText('Recovered (Actual-host)')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('does not report unavailable configuration when no workspace or desktop bridge exists', async () => {
  const fixture = gitSyncUiFixture()
  window.remoteVSCode = fixture.remote
  vi.mocked(fixture.api.status).mockRejectedValue(new Error('No current workspace.'))
  const rendered = render(<MachineAliasesProvider workspaceId={null}><AliasLabel /><StatusError /></MachineAliasesProvider>)
  await act(async () => {})
  expect(fixture.api.status).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  delete window.remoteVSCode
  rendered.rerender(<MachineAliasesProvider workspaceId="workspace-one"><AliasLabel /><StatusError /></MachineAliasesProvider>)
  await act(async () => {})
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText(owner.machineName)).toBeInTheDocument()
})
