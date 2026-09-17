import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import type { WorkspaceRepositoryStatus } from '../src/shared/workspace'
import type { DesktopBridge } from '../src/shared/desktop'
import { taskWorkspaceFixture, workspaceBridgeFixture } from './workspace-ui-fixture'

afterEach(() => { delete window.workspace; delete window.desktop })

async function start() {
  const bridge = workspaceBridgeFixture()
  window.workspace = bridge
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create task repository' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Create task repository' }))
  return { bridge, user }
}

async function fillRepository(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Browse' }))
  await user.type(screen.getByRole('textbox', { name: 'Repository name' }), 'my-tasks')
}

async function createRepository(user: ReturnType<typeof userEvent.setup>) {
  await fillRepository(user)
  await user.click(screen.getByRole('button', { name: 'Create repository' }))
  await screen.findByRole('dialog', { name: 'Publish task repository' })
}

const readyStatus: WorkspaceRepositoryStatus = {
  workspaceId: 'created-workspace', name: 'my-tasks', branch: 'main', remoteUrl: null,
  credentialHelper: 'gcm',
}
const remoteUrl = 'https://github.com/fixture_emu/my-tasks.git'

async function preparePush(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'GitHub repository URL' }), remoteUrl)
  await user.click(screen.getByRole('button', { name: 'Get push commands' }))
  await screen.findByRole('button', { name: "I've pushed - Check" })
}

function installNativeClipboardFixture(copyText: DesktopBridge['copyText']): void {
  window.desktop = {
    copyText,
    getInfo: vi.fn(async () => ({
      name: 'Task Continuum', version: 'test', platform: 'win32',
      security: { contextIsolated: true, sandboxed: true },
    })),
    close: vi.fn(async () => {}), minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}),
  }
}

describe('first-run task repository setup', () => {
  it('does not show seeded tasks while restoring a profile or when history cannot load', async () => {
    const bridge = workspaceBridgeFixture()
    let fail!: (reason: Error) => void
    vi.mocked(bridge.getState).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    window.workspace = bridge
    const view = render(<App />)
    expect(view.container.querySelector('[role="tab"]')).toBeNull()
    expect(view.container).not.toHaveTextContent('UI based on Electron')
    expect(view.container).not.toHaveTextContent('LOCAL DEMO')
    await act(async () => { fail(new Error('Saved workspace history could not be read.')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved workspace history')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create your task repository')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(bridge.createRepository).not.toHaveBeenCalled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })

  it('creates only an empty local repository and keeps the guide open across workspace switching', async () => {
    const { bridge, user } = await start()
    await createRepository(user)
    expect(bridge.chooseParentFolder).toHaveBeenCalledOnce()
    expect(bridge.createRepository).toHaveBeenCalledExactlyOnceWith({ parentPath: 'Q:\\Workspaces', name: 'my-tasks' })
    await waitFor(() => expect(screen.getByText(/Git Credential Manager is configured/)).toBeInTheDocument())
    const dialog = screen.getByRole('dialog', { name: 'Publish task repository' })
    expect(within(dialog).getByText('Q:\\Workspaces\\my-tasks')).toBeInTheDocument()
    expect(within(dialog).getByText(/Personal EMU repositories must be private/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    expect(bridge.getRepositoryStatus).toHaveBeenCalledWith('created-workspace')
    expect(bridge.openRepositoryCreation).not.toHaveBeenCalled()
    expect(bridge.getRepositoryPushPlan).not.toHaveBeenCalled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
    expect(bridge.getSessionLinks).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Keep local for now' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No tasks in this workspace')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue('created-workspace')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the chosen path when the native folder picker is cancelled', async () => {
    const { bridge, user } = await start()
    await user.type(screen.getByRole('textbox', { name: 'Parent directory' }), 'Q:\\Existing parent')
    vi.mocked(bridge.chooseParentFolder).mockResolvedValueOnce(null)
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    expect(screen.getByRole('textbox', { name: 'Parent directory' })).toHaveValue('Q:\\Existing parent')
    expect(bridge.createRepository).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create your task repository')
  })

  it('retains form input and the original workspace on creation failure', async () => {
    const current = taskWorkspaceFixture()
    const bridge = workspaceBridgeFixture({ current, recent: [current] })
    vi.mocked(bridge.createRepository).mockRejectedValueOnce(new Error('That folder already exists. Choose a new repository name.'))
    window.workspace = bridge
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New task repository' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'New task repository' }))
    await fillRepository(user)
    await user.click(screen.getByRole('button', { name: 'Create repository' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(screen.getByRole('textbox', { name: 'Parent directory' })).toHaveValue('Q:\\Workspaces')
    expect(screen.getByRole('textbox', { name: 'Repository name' })).toHaveValue('my-tasks')
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('UI based on Electron')
  })

  it('prevents duplicate creation and dismissal while native creation is pending', async () => {
    const { bridge, user } = await start()
    let fail!: (reason: Error) => void
    vi.mocked(bridge.createRepository).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await fillRepository(user)
    await user.click(screen.getByRole('button', { name: 'Create repository' }))
    const dialog = screen.getByRole('dialog', { name: 'Create task repository' })
    fireEvent.submit(dialog.querySelector('form')!)
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(within(dialog).getByRole('button', { name: 'Creating repository...' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Close Create task repository' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(bridge.createRepository).toHaveBeenCalledOnce()
    await act(async () => { fail(new Error('Configure your Git identity, then retry.')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Git identity')
    expect(screen.getByRole('button', { name: 'Create repository' })).toBeEnabled()
  })

  it('resumes local setup and opens the browser, copies commands and verifies only on explicit actions', async () => {
    const { bridge, user } = await start()
    await createRepository(user)
    await user.click(screen.getByRole('button', { name: 'Keep local for now' }))
    await user.click(screen.getByRole('button', { name: 'Publish workspace to GitHub' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create on GitHub' })).toBeEnabled())
    expect(bridge.openRepositoryCreation).not.toHaveBeenCalled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Create on GitHub' }))
    expect(bridge.openRepositoryCreation).toHaveBeenCalledExactlyOnceWith('created-workspace')
    await preparePush(user)
    expect(bridge.getRepositoryPushPlan).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'created-workspace', remoteUrl })
    expect(screen.getByLabelText('Git push commands')).toHaveTextContent('main:refs/heads/main')
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(screen.getByRole('button', { name: 'Copy commands' }))
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining(remoteUrl))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: "I've pushed - Check" }))
    expect(bridge.verifyRepositoryPublication).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'created-workspace', remoteUrl })
    expect(await screen.findByRole('heading', { name: 'Repository is on GitHub' })).toBeInTheDocument()
    expect(screen.getByText('https://github.com/fixture_emu/my-tasks')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await bridge.getState()).current?.tasks).toEqual([])
  })

  it('retains commands and the local repository when terminal push verification fails', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.verifyRepositoryPublication).mockRejectedValueOnce(new Error('The remote branch is missing. Finish git push in your terminal, then check again.'))
    await createRepository(user)
    await preparePush(user)
    await user.click(screen.getByRole('button', { name: "I've pushed - Check" }))
    expect(await screen.findByRole('alert')).toHaveTextContent('remote branch is missing')
    expect(screen.queryByRole('heading', { name: 'Repository is on GitHub' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Git push commands')).toHaveTextContent(remoteUrl)
    await user.click(screen.getByRole('button', { name: "I've pushed - Check" }))
    await screen.findByRole('heading', { name: 'Repository is on GitHub' })
    expect(bridge.verifyRepositoryPublication).toHaveBeenNthCalledWith(1, { workspaceId: 'created-workspace', remoteUrl })
    expect(bridge.verifyRepositoryPublication).toHaveBeenNthCalledWith(2, { workspaceId: 'created-workspace', remoteUrl })
    expect(bridge.createRepository).toHaveBeenCalledOnce()
  })

  it('uses the existing native clipboard bridge when browser clipboard permission is denied', async () => {
    const { user } = await start()
    const browserCopy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'))
    const nativeCopy = vi.fn(async () => {})
    installNativeClipboardFixture(nativeCopy)
    await createRepository(user)
    await preparePush(user)
    const commands = screen.getByLabelText('Git push commands').textContent
    await user.click(screen.getByRole('button', { name: 'Copy commands' }))
    expect(nativeCopy).toHaveBeenCalledExactlyOnceWith(commands)
    expect(browserCopy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports native clipboard failures and allows retry without discarding the commands', async () => {
    const { user } = await start()
    const nativeCopy = vi.fn(async () => {})
    installNativeClipboardFixture(nativeCopy)
    await createRepository(user)
    await preparePush(user)
    await user.click(screen.getByRole('button', { name: 'Copy commands' }))
    nativeCopy.mockRejectedValueOnce(new Error('Native clipboard is temporarily unavailable.'))
    await user.click(screen.getByRole('button', { name: 'Copied' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Native clipboard is temporarily unavailable')
    expect(screen.getByRole('button', { name: 'Copy commands' })).toBeEnabled()
    expect(screen.getByLabelText('Git push commands')).toHaveTextContent(remoteUrl)
    await user.click(screen.getByRole('button', { name: 'Copy commands' }))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    { credentialHelper: 'none' as const, text: 'No HTTPS credential helper was detected.' },
    { credentialHelper: 'configured' as const, text: 'Git has a credential helper configured.' },
  ])('keeps the guide usable without requiring a specific credential helper: $credentialHelper', async ({ credentialHelper, text }) => {
    const { bridge, user } = await start()
    vi.mocked(bridge.getRepositoryStatus).mockResolvedValueOnce({ ...readyStatus, credentialHelper })
    await createRepository(user)
    expect(await screen.findByText((content) => content.startsWith(text))).toBeInTheDocument()
    expect(screen.queryByText('gh auth login --hostname github.com')).not.toBeInTheDocument()
    await preparePush(user)
    expect(screen.getByRole('button', { name: "I've pushed - Check" })).toBeEnabled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })

  it('surfaces repository status failures and checks again without recreating the folder', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.getRepositoryStatus).mockRejectedValueOnce(new Error('The repository branch changed. Review it before publishing.'))
    await createRepository(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('branch changed')
    expect(screen.getByRole('button', { name: 'Get push commands' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Refresh Git status' }))
    await waitFor(() => expect(screen.getByText(/Git Credential Manager is configured/)).toBeInTheDocument())
    expect(bridge.createRepository).toHaveBeenCalledOnce()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })

  it('invalidates old commands when the pasted destination changes and never guesses publication success', async () => {
    const { bridge, user } = await start()
    await createRepository(user)
    await preparePush(user)
    await user.clear(screen.getByRole('textbox', { name: 'GitHub repository URL' }))
    expect(screen.queryByLabelText('Git push commands')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: "I've pushed - Check" })).not.toBeInTheDocument()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })

  it('prefills an existing remote but still requires read-only verification and never recreates it', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.getRepositoryStatus).mockResolvedValueOnce({ ...readyStatus, remoteUrl })
    await createRepository(user)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toHaveValue(remoteUrl))
    expect(screen.queryByRole('heading', { name: 'Repository is on GitHub' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Get push commands' }))
    await screen.findByRole('button', { name: "I've pushed - Check" })
    expect(bridge.openRepositoryCreation).not.toHaveBeenCalled()
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })

  it('surfaces native browser and command preparation failures without losing the local repository', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.openRepositoryCreation).mockRejectedValueOnce(new Error('The browser could not open.'))
    vi.mocked(bridge.getRepositoryPushPlan).mockRejectedValueOnce(new Error('The existing origin differs. It was not overwritten.'))
    await createRepository(user)
    await user.click(screen.getByRole('button', { name: 'Create on GitHub' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('browser could not open')
    await user.type(screen.getByRole('textbox', { name: 'GitHub repository URL' }), remoteUrl)
    await user.click(screen.getByRole('button', { name: 'Get push commands' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('origin differs')
    expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toHaveValue(remoteUrl)
    expect(bridge.verifyRepositoryPublication).not.toHaveBeenCalled()
  })
})
