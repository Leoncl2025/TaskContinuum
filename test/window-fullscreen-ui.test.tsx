import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import type { DesktopBridge } from '../src/shared/desktop'

afterEach(() => { delete window.desktop })

function fixture() {
  const listeners = new Set<(value: boolean) => void>()
  const remove = vi.fn()
  const bridge: DesktopBridge = {
    getInfo: vi.fn(async () => ({ name: 'Task Continuum', version: 'test', platform: 'win32', security: { sandboxed: true, contextIsolated: true } })),
    minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}), close: vi.fn(async () => {}), copyText: vi.fn(async () => {}),
    getFullScreen: vi.fn(async () => false), toggleFullScreen: vi.fn(async () => {}),
    onFullScreenChanged: vi.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener); remove() } }),
  }
  window.desktop = bridge
  return { bridge, remove, emit: (value: boolean) => { for (const listener of listeners) listener(value) } }
}

describe('native full-screen window controls', () => {
  it('uses native state for enter/exit controls without optimistically changing the window state', async () => {
    const f = fixture()
    const mounted = render(<App />)
    const user = userEvent.setup()
    const enter = await screen.findByRole('button', { name: 'Enter full screen' })
    expect(enter).toHaveAttribute('aria-pressed', 'false')
    await user.click(enter)
    expect(f.bridge.toggleFullScreen).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Exit full screen' })).not.toBeInTheDocument()
    act(() => f.emit(true))
    const exit = screen.getByRole('button', { name: 'Exit full screen' })
    expect(exit).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Maximize or restore window' })).toBeDisabled()
    await user.click(exit)
    expect(f.bridge.toggleFullScreen).toHaveBeenCalledTimes(2)
    act(() => f.emit(false))
    expect(screen.getByRole('button', { name: 'Maximize or restore window' })).toBeEnabled()
    mounted.unmount()
    expect(f.remove).toHaveBeenCalledOnce()
  })

  it('does not replace a native transition event with an older initial state response', async () => {
    const f = fixture()
    let resolve!: (state: boolean) => void
    vi.mocked(f.bridge.getFullScreen).mockReturnValue(new Promise((done) => { resolve = done }))
    render(<App />)
    act(() => f.emit(true))
    await act(async () => resolve(false))
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument()
  })

  it('reports bridge failures and leaves exit state tied to the actual window', async () => {
    const f = fixture()
    vi.mocked(f.bridge.toggleFullScreen).mockRejectedValue(new Error('The native window is unavailable.'))
    render(<App />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enter full screen' }))
    await waitFor(() => expect(screen.getByText('Desktop bridge error')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not offer native window controls in browser-only preview', () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Enter full screen' })).not.toBeInTheDocument()
  })
})
