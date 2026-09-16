import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import { taskWorkspaceFixture, workspaceBridgeFixture } from './workspace-ui-fixture'

function explorer() { return within(screen.getByRole('complementary', { name: 'Task explorer' })) }
async function renderWorkspace() {
  const current = taskWorkspaceFixture()
  window.workspace = workspaceBridgeFixture({ current, recent: [current] })
  const view = render(<App />)
  await screen.findByRole('heading', { level: 1, name: 'UI based on Electron' })
  return view
}
afterEach(() => {
  delete window.workspace
  vi.unstubAllGlobals()
  for (const name of ['copilot', 'vscodeChat', 'sharedSessions']) Reflect.deleteProperty(window, name)
})

describe('workbench', () => {
  it('starts with empty panes and repository guidance, never sample tasks', () => {
    render(<App />)
    expect(screen.getByRole('navigation', { name: 'Workbench navigation' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Task chat' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create your task repository')
    expect(screen.getByText('No Agent Host linked')).toBeInTheDocument()
    expect(screen.getByText('NO WORKSPACE')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo', { name: 'Workbench status' })).toHaveTextContent('0 tasks')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/Local demo|Demo data|local sandbox/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create task repository' })).toBeDisabled()
    expect(screen.getByText(/Open the desktop app/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Message/ })).not.toBeInTheDocument()
  })

  it('filters and selects tasks without starting a conversation', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    await user.type(screen.getByRole('textbox', { name: 'Filter tasks' }), 'backend')
    expect(explorer().queryByRole('button', { name: 'T-0002 UI based on Electron' })).not.toBeInTheDocument()
    await user.click(explorer().getByRole('button', { name: 'T-0003 Backend service' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Backend service')
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    expect(screen.getByText(/No Agent Host chat is linked to T-0003/)).toBeInTheDocument()
  })

  it('shows a recoverable empty search state', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    await user.type(screen.getByRole('textbox', { name: 'Filter tasks' }), 'missing-task')
    expect(screen.getByText('No matching tasks')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(explorer().getByRole('button', { name: 'T-0003 Backend service' })).toBeInTheDocument()
  })

  it('filters by status and collapses the task group', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    await user.click(screen.getByRole('button', { name: 'Collapse T-0001' }))
    expect(explorer().queryByRole('button', { name: 'T-0003 Backend service' })).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('group', { name: 'Task status filter' })).getByRole('button', { name: /^Done/ }))
    expect(explorer().getByRole('button', { name: 'T-0005 Map the first user journey' })).toBeInTheDocument()
  })

  it('keeps real task statuses and checklist progress read-only', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '40')
    await user.click(screen.getByRole('checkbox', { name: /Build the task explorer/ }))
    expect(screen.getByRole('checkbox', { name: /Build the task explorer/ })).toBeDisabled()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '40')
    expect(screen.getByRole('combobox', { name: 'Task status' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Task status' })).toHaveValue('in-progress')
  })

  it('supports document tab keyboard navigation', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    screen.getByRole('tab', { name: 'Overview' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Requirements' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'What success looks like' })).toBeInTheDocument()
  })

  it('toggles panels independently with shortcuts', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('complementary', { name: 'Task explorer' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Task chat' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true, altKey: true })
    expect(screen.queryByRole('complementary', { name: 'Task chat' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('complementary', { name: 'Task explorer' })).toBeInTheDocument()
  })

  it('resizes both panel edges with the keyboard and preserves hidden widths', () => {
    vi.stubGlobal('innerWidth', 1440)
    render(<App />)
    const sidebar = screen.getByRole('separator', { name: 'Resize Explorer' })
    const chat = screen.getByRole('separator', { name: 'Resize Chat' })
    fireEvent.keyDown(sidebar, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(chat, { key: 'ArrowLeft', shiftKey: true })
    expect(sidebar).toHaveAttribute('aria-valuenow', '308')
    expect(chat).toHaveAttribute('aria-valuenow', '405')
    expect(chat).toHaveAttribute('aria-orientation', 'vertical')
    expect(JSON.parse(localStorage.getItem('taskcontinuum:layout:v1')!)).toMatchObject({ sidebarWidth: 308, chatWidth: 405 })
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('separator', { name: 'Resize Explorer' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('separator', { name: 'Resize Explorer' })).toHaveAttribute('aria-valuenow', '308')
    fireEvent.keyDown(chat, { key: 'End' })
    expect(chat).toHaveAttribute('aria-valuenow', chat.getAttribute('aria-valuemax')!)
    fireEvent.keyDown(chat, { key: 'Home' })
    expect(chat).toHaveAttribute('aria-valuenow', '310')
  })

  it('restores widths, fits a smaller window without overwriting preferences, and resets sizing', async () => {
    vi.stubGlobal('innerWidth', 1440)
    localStorage.setItem('taskcontinuum:layout:v1', JSON.stringify({ sidebar: true, chat: true, theme: 'light', sidebarWidth: 400, chatWidth: 500 }))
    const view = render(<App />)
    expect(screen.getByRole('separator', { name: 'Resize Explorer' })).toHaveAttribute('aria-valuenow', '400')
    expect(screen.getByRole('separator', { name: 'Resize Chat' })).toHaveAttribute('aria-valuenow', '500')
    vi.stubGlobal('innerWidth', 1001)
    fireEvent.resize(window)
    expect(Number(screen.getByRole('separator', { name: 'Resize Explorer' }).getAttribute('aria-valuenow'))).toBeLessThan(400)
    expect(JSON.parse(localStorage.getItem('taskcontinuum:layout:v1')!)).toMatchObject({ sidebarWidth: 400, chatWidth: 500 })
    vi.stubGlobal('innerWidth', 1440)
    fireEvent.resize(window)
    expect(screen.getByRole('separator', { name: 'Resize Chat' })).toHaveAttribute('aria-valuenow', '500')
    view.unmount()
    const reopened = render(<App />)
    expect(screen.getByRole('separator', { name: 'Resize Explorer' })).toHaveAttribute('aria-valuenow', '400')
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize Explorer' }))
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Chat' }), { key: 'Enter' })
    expect(screen.getByRole('separator', { name: 'Resize Explorer' })).toHaveAttribute('aria-valuenow', '258')
    expect(screen.getByRole('separator', { name: 'Resize Chat' })).toHaveAttribute('aria-valuenow', '355')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Explorer' }), { key: 'ArrowRight' })
    await userEvent.click(screen.getByRole('button', { name: 'Preferences' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset panel layout' }))
    expect(reopened.container.querySelector('.workbench')).toHaveAttribute('data-theme', 'light')
    expect(JSON.parse(localStorage.getItem('taskcontinuum:layout:v1')!)).toMatchObject({ sidebarWidth: 258, chatWidth: 355, theme: 'light' })
  })

  it('opens and searches the quick switcher', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Quick open' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Find a task' }), 'T-0004')
    await user.click(within(dialog).getByRole('button', { name: /Technical design/ }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Technical design')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('persists display preferences and reports only native integration capabilities', async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole('button', { name: 'Preferences' }))
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(container.querySelector('.workbench')).toHaveAttribute('data-theme', 'light')
    expect(screen.getByText('Native Agent Host (AHP)')).toBeInTheDocument()
    expect(screen.getAllByText('Desktop API unavailable')).toHaveLength(2)
    expect(screen.queryByText('GitHub Copilot CLI')).not.toBeInTheDocument()
    expect(localStorage.getItem('taskcontinuum:layout:v1')).toContain('light')
  })

  it('handles closing the last task without inventing another selection', async () => {
    const user = userEvent.setup()
    await renderWorkspace()
    await user.click(screen.getByRole('button', { name: 'Close UI based on Electron' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Make room for meaningful work.')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create demo task' })).not.toBeInTheDocument()
  })

  it('uses a single pane on a compact viewport and returns to the task after selection', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: true, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true }))
    const user = userEvent.setup()
    await renderWorkspace()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    await user.click(explorer().getByRole('button', { name: 'T-0003 Backend service' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Backend service')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Toggle chat panel' }))
    expect(screen.getByRole('complementary', { name: 'Task chat' })).toBeInTheDocument()
    expect(screen.queryByRole('main')).not.toBeInTheDocument()
  })

  it('never reads legacy runtime globals or activates old browser session data', async () => {
    const legacyKeys = ['taskcontinuum:copilot-mode', 'taskcontinuum:session-bindings:v1', 'taskcontinuum:session-bindings:v1:workspace-one']
    for (const key of legacyKeys) localStorage.setItem(key, 'preserved-old-data')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const legacyAccess = vi.fn(() => { throw new Error('A retired runtime was accessed.') })
    for (const name of ['copilot', 'vscodeChat', 'sharedSessions']) Object.defineProperty(window, name, { configurable: true, get: legacyAccess })
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Agent Host sessions' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Open a task workspace')
    expect(legacyAccess).not.toHaveBeenCalled()
    for (const key of legacyKeys) expect(getItem).not.toHaveBeenCalledWith(key)
    expect(setItem.mock.calls.some(([key]) => legacyKeys.includes(key))).toBe(false)
    expect(removeItem).not.toHaveBeenCalled()
    for (const key of legacyKeys) expect(localStorage.getItem(key)).toBe('preserved-old-data')
    for (const name of ['Sessions', 'Shared sessions', 'Connect Copilot', 'New Copilot session', 'Remote VS Code sessions']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })
})
