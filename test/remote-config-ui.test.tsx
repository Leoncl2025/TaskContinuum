import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceGitSyncControls } from '../src/renderer/components/WorkspaceGitSyncControls'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { cleanup(); delete window.remoteVSCode })

it('requires an explicit enrollment action and exposes immediate synchronization and pause', async () => {
  const { api, remote } = gitSyncUiFixture()
  window.remoteVSCode = remote
  render(<WorkspaceGitSyncControls />)
  await screen.findByText(/disabled · 0 pending/)
  expect(api.enable).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Enable automatic links' }))
  await screen.findByRole('button', { name: 'Pause automatic links' })
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
  await screen.findByText(/disabled · 0 pending/)
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
