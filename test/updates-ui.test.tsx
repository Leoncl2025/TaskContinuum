import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { UpdateBridge, UpdateState } from '../src/shared/updates'
import { UpdateNotice, UpdateSettings, UpdateStatus, useUpdates } from '../src/renderer/components/UpdateSettings'
import App from '../src/renderer/App'

const release = { version: '0.2.0', name: 'Next release', notes: '<script>unsafe()</script>\n[link](javascript:unsafe())', url: 'https://untrusted.invalid' }
function fixture(overrides: Partial<UpdateState> = {}) {
  let state: UpdateState = { currentVersion: '0.1.1', distribution: 'nsis', canInstall: true, autoCheck: true, phase: 'idle', ...overrides }
  const listeners = new Set<(value: UpdateState) => void>()
  const unsubscribe = vi.fn()
  const api: UpdateBridge = {
    getState: vi.fn(async () => state),
    check: vi.fn(async () => state),
    setAutoCheck: vi.fn(async (enabled) => { state = { ...state, autoCheck: enabled }; return state }),
    openRelease: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    onState: vi.fn((listener) => { listeners.add(listener); return () => { unsubscribe(); listeners.delete(listener) } }),
    onPrepareInstall: vi.fn(() => () => {}),
    respondToInstall: vi.fn(async () => {}),
    onInstallAborted: vi.fn(() => () => {}),
  }
  return {
    api, unsubscribe,
    emit(next: Partial<UpdateState>) { state = { ...state, ...next }; for (const listener of listeners) listener(state) },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function Harness({ api, showSettings = true, showNotice = false, onOpen = vi.fn() }: { api?: UpdateBridge; showSettings?: boolean; showNotice?: boolean; onOpen?: () => void }) {
  const updates = useUpdates(api)
  return <>
    <UpdateStatus updates={updates} onOpen={onOpen} />
    {showNotice && <UpdateNotice updates={updates} />}
    {showSettings && <UpdateSettings updates={updates} />}
  </>
}

afterEach(() => { cleanup(); delete window.updates })

it('connects the real workbench status bar to shared update preferences without automatic installation', async () => {
  const f = fixture()
  window.updates = f.api
  const view = render(<App />)
  await waitFor(() => expect(f.api.getState).toHaveBeenCalledOnce())
  act(() => f.emit({ phase: 'available', release }))
  fireEvent.click(await screen.findByRole('button', { name: 'Update 0.2.0 available' }))
  expect(await screen.findByRole('heading', { name: 'Application updates' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Download update' })).toBeEnabled()
  expect(f.api.onState).toHaveBeenCalledOnce()
  expect(f.api.onPrepareInstall).toHaveBeenCalledOnce()
  expect(f.api.install).not.toHaveBeenCalled()
  expect(f.api.download).not.toHaveBeenCalled()
  view.unmount()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('handles browser preview without attempting bridge operations', () => {
  render(<Harness />)
  expect(screen.getByText(/Updates are unavailable in browser preview/)).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('keeps an always-available compact about/update entry without checking or downloading on render', async () => {
  const f = fixture()
  const onOpen = vi.fn()
  render(<Harness api={f.api} showSettings={false} onOpen={onOpen} />)
  fireEvent.click(await screen.findByRole('button', { name: 'About and updates' }))
  expect(onOpen).toHaveBeenCalledOnce()
  expect(f.api.check).not.toHaveBeenCalled()
  expect(f.api.download).not.toHaveBeenCalled()
})

it('lets Later dismiss a ready notice without discarding the titlebar one-click update', async () => {
  const f = fixture({ phase: 'downloaded', release })
  render(<Harness api={f.api} showSettings={false} showNotice />)
  const notice = await screen.findByRole('status', { name: 'Update ready' })
  fireEvent.click(within(notice).getByRole('button', { name: 'Later' }))
  expect(screen.queryByRole('status', { name: 'Update ready' })).not.toBeInTheDocument()
  act(() => f.emit({ phase: 'downloaded', release }))
  expect(screen.queryByRole('status', { name: 'Update ready' })).not.toBeInTheDocument()
  expect(f.api.install).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Restart to update Task Continuum' }))
  await waitFor(() => expect(f.api.install).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('shows a new ready version after an earlier version was dismissed', async () => {
  const f = fixture({ phase: 'downloaded', release })
  render(<Harness api={f.api} showSettings={false} showNotice />)
  fireEvent.click(within(await screen.findByRole('status', { name: 'Update ready' })).getByRole('button', { name: 'Later' }))
  act(() => f.emit({ phase: 'downloaded', release: { ...release, version: '0.3.0' } }))
  expect(await screen.findByRole('status', { name: 'Update ready' })).toHaveTextContent('0.3.0')
  expect(f.api.install).not.toHaveBeenCalled()
})

it('shows manual-only distribution, fixed-source release action, and safe plain notes', async () => {
  const f = fixture({ distribution: 'archive', canInstall: false, reason: 'Portable builds require a manual download.', phase: 'available', release })
  render(<Harness api={f.api} />)
  expect(await screen.findByText('Portable archive')).toBeInTheDocument()
  expect(screen.getByText('0.1.1')).toBeInTheDocument()
  expect(screen.getByText(/Portable builds require a manual download/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument()
  expect(screen.getByText(/<script>unsafe\(\)<\/script>/)).toHaveTextContent('[link](javascript:unsafe())')
  expect(document.querySelector('script')).toBeNull()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open release page' }))
  await waitFor(() => expect(f.api.openRelease).toHaveBeenCalledWith())
  expect(f.api.download).not.toHaveBeenCalled()
  expect(f.api.install).not.toHaveBeenCalled()
})

it.each(['development', 'unsupported', 'nsis'] as const)('does not offer installation for ineligible %s builds', async (distribution) => {
  const f = fixture({ distribution, canInstall: false, phase: 'available', release })
  render(<Harness api={f.api} />)
  await screen.findByText(/Manual updates only/)
  expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument()
})

it('keeps background notifications visible with settings closed and unsubscribes', async () => {
  const f = fixture()
  const onOpen = vi.fn()
  const view = render(<Harness api={f.api} showSettings={false} onOpen={onOpen} />)
  await act(async () => {})
  act(() => f.emit({ phase: 'available', release }))
  fireEvent.click(screen.getByRole('button', { name: 'Update 0.2.0 available' }))
  expect(onOpen).toHaveBeenCalledOnce()
  expect(f.api.download).not.toHaveBeenCalled()
  view.unmount()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('does not overwrite a pushed state with a delayed initial state', async () => {
  const f = fixture()
  const initial = deferred<UpdateState>()
  vi.mocked(f.api.getState).mockReturnValueOnce(initial.promise)
  render(<Harness api={f.api} />)
  act(() => f.emit({ phase: 'available', release }))
  await screen.findByRole('button', { name: 'Download update' })
  await act(async () => initial.resolve({ currentVersion: 'old', distribution: 'nsis', canInstall: true, autoCheck: false, phase: 'idle' }))
  expect(screen.getByRole('button', { name: 'Download update' })).toBeEnabled()
  expect(screen.queryByText('old')).not.toBeInTheDocument()
})

it('disables duplicate checks, preserves newer events, and recovers from check failures', async () => {
  const f = fixture()
  const check = deferred<UpdateState>()
  vi.mocked(f.api.check).mockReturnValueOnce(check.promise)
  render(<Harness api={f.api} />)
  const button = await screen.findByRole('button', { name: 'Check for updates' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(f.api.check).toHaveBeenCalledOnce()
  act(() => f.emit({ phase: 'available', release }))
  await act(async () => check.resolve({ currentVersion: '0.1.1', distribution: 'nsis', canInstall: true, autoCheck: true, phase: 'checking' }))
  expect(screen.getByRole('button', { name: 'Download update' })).toBeEnabled()
  vi.mocked(f.api.check).mockRejectedValueOnce(new Error('Cannot reach update server.'))
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach update server.')
  expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled()
})

it('surfaces loading rejection and lets the user retry', async () => {
  const f = fixture()
  vi.mocked(f.api.getState).mockRejectedValueOnce(new Error('Bridge disconnected.'))
  render(<Harness api={f.api} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Bridge disconnected.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading updates' }))
  expect(await screen.findByText('0.1.1')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('surfaces download failures, allows retry, and displays progress without auto-installing', async () => {
  const f = fixture({ phase: 'available', release })
  const download = deferred<void>()
  vi.mocked(f.api.download).mockReturnValueOnce(download.promise)
  render(<Harness api={f.api} />)
  const button = await screen.findByRole('button', { name: 'Download update' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(f.api.download).toHaveBeenCalledOnce()
  expect(button).toBeDisabled()
  await act(async () => download.reject(new Error('Download interrupted.')))
  expect(await screen.findByRole('alert')).toHaveTextContent('Download interrupted.')
  expect(button).toBeEnabled()
  act(() => f.emit({ phase: 'downloading', progress: 42.7 }))
  expect(screen.getByRole('progressbar', { name: 'Update download progress' })).toHaveAttribute('value', '42.7')
  expect(screen.getByText('43%')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  act(() => f.emit({ phase: 'downloaded' }))
  expect(screen.getByRole('button', { name: 'Restart and update' })).toBeEnabled()
  expect(f.api.install).not.toHaveBeenCalled()
})

it('does not overwrite download completion notifications with a delayed refresh', async () => {
  const f = fixture({ phase: 'available', release })
  render(<Harness api={f.api} />)
  const button = await screen.findByRole('button', { name: 'Download update' })
  const refresh = deferred<UpdateState>()
  vi.mocked(f.api.getState).mockReturnValueOnce(refresh.promise)
  fireEvent.click(button)
  await waitFor(() => expect(f.api.getState).toHaveBeenCalledTimes(2))
  act(() => f.emit({ phase: 'downloaded' }))
  await act(async () => refresh.resolve({ currentVersion: '0.1.1', distribution: 'nsis', canInstall: true, autoCheck: true, phase: 'available', release }))
  expect(screen.getByRole('button', { name: 'Restart and update' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Download update' })).not.toBeInTheDocument()
})

it('installs with one click and disables duplicate requests without a second confirmation dialog', async () => {
  const f = fixture({ phase: 'downloaded', release })
  const install = deferred<void>()
  vi.mocked(f.api.install).mockReturnValueOnce(install.promise)
  render(<Harness api={f.api} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' }))
  const button = screen.getByRole('button', { name: 'Restart and update' })
  fireEvent.click(button)
  expect(f.api.install).toHaveBeenCalledOnce()
  expect(button).toBeDisabled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => install.resolve())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('surfaces a restart safety veto while leaving the verified update ready to retry', async () => {
  const f = fixture({ phase: 'downloaded', release })
  vi.mocked(f.api.install).mockRejectedValueOnce(new Error('An active connection prevents restart.'))
  render(<Harness api={f.api} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('An active connection prevents restart.')
  expect(screen.getByRole('button', { name: 'Restart and update' })).toBeEnabled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('updates automatic-check preference only on request and reports preference or release errors', async () => {
  const f = fixture()
  render(<Harness api={f.api} />)
  const checkbox = await screen.findByRole('checkbox', { name: 'Automatically check and download updates' })
  expect(checkbox).toBeChecked()
  expect(f.api.setAutoCheck).not.toHaveBeenCalled()
  fireEvent.click(checkbox)
  await waitFor(() => expect(checkbox).not.toBeChecked())
  expect(f.api.setAutoCheck).toHaveBeenCalledWith(false)
  vi.mocked(f.api.setAutoCheck).mockRejectedValueOnce(new Error('Could not save preference.'))
  fireEvent.click(checkbox)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save preference.')
  expect(checkbox).not.toBeChecked()
  vi.mocked(f.api.openRelease).mockRejectedValueOnce(new Error('Could not open browser.'))
  fireEvent.click(screen.getByRole('button', { name: 'Open release page' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not open browser.')
  expect(f.api.download).not.toHaveBeenCalled()
  expect(f.api.install).not.toHaveBeenCalled()
})
