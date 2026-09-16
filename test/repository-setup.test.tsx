import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/App'
import type { WorkspaceRepositoryStatus } from '../src/shared/workspace'
import { taskWorkspaceFixture, workspaceBridgeFixture } from './workspace-ui-fixture'

afterEach(() => { delete window.workspace })

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
  published: false, github: { installed: true, authenticated: true, login: 'fixture-user' },
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
    expect(bridge.publishRepository).not.toHaveBeenCalled()
  })

  it('creates only an empty local repository and keeps the guide open across workspace switching', async () => {
    const { bridge, user } = await start()
    await createRepository(user)
    expect(bridge.chooseParentFolder).toHaveBeenCalledOnce()
    expect(bridge.createRepository).toHaveBeenCalledExactlyOnceWith({ parentPath: 'Q:\\Workspaces', name: 'my-tasks' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeEnabled())
    const dialog = screen.getByRole('dialog', { name: 'Publish task repository' })
    expect(within(dialog).getByText('Q:\\Workspaces\\my-tasks')).toBeInTheDocument()
    expect(within(dialog).getByText('fixture-user/my-tasks')).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Private/ })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: /^Public/ })).not.toBeChecked()
    expect(bridge.getRepositoryStatus).toHaveBeenCalledWith('created-workspace')
    expect(bridge.publishRepository).not.toHaveBeenCalled()
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
    expect(bridge.publishRepository).not.toHaveBeenCalled()
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

  it('can resume publishing a local repository and only uploads after explicit confirmation', async () => {
    const { bridge, user } = await start()
    await createRepository(user)
    await user.click(screen.getByRole('button', { name: 'Keep local for now' }))
    await user.click(screen.getByRole('button', { name: 'Publish workspace to GitHub' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeEnabled())
    expect(bridge.publishRepository).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    expect(bridge.publishRepository).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'created-workspace', private: true })
    expect(await screen.findByRole('heading', { name: 'Repository is on GitHub' })).toBeInTheDocument()
    expect(screen.getByText('https://github.com/fixture-user/my-tasks')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await bridge.getState()).current?.tasks).toEqual([])
  })

  it('requires an explicit choice for public visibility and keeps failures retryable', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.publishRepository).mockRejectedValueOnce(new Error('GitHub push failed. The local repository is intact; retry publication.'))
    await createRepository(user)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeEnabled())
    await user.click(screen.getByRole('radio', { name: /^Public/ }))
    expect(screen.getByText(/Public repositories are visible to everyone/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('push failed')
    expect(screen.queryByRole('heading', { name: 'Repository is on GitHub' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Public/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Publish to GitHub' }))
    await screen.findByRole('heading', { name: 'Repository is on GitHub' })
    expect(bridge.publishRepository).toHaveBeenNthCalledWith(1, { workspaceId: 'created-workspace', private: false })
    expect(bridge.publishRepository).toHaveBeenNthCalledWith(2, { workspaceId: 'created-workspace', private: false })
    expect(bridge.createRepository).toHaveBeenCalledOnce()
  })

  it.each([
    { installed: false, authenticated: false, text: 'GitHub CLI (gh) is not installed.' },
    { installed: true, authenticated: false, text: 'Sign in with GitHub CLI' },
  ])('keeps local creation usable when GitHub prerequisites are unavailable: $text', async ({ installed, authenticated, text }) => {
    const { bridge, user } = await start()
    vi.mocked(bridge.getRepositoryStatus).mockResolvedValueOnce({ ...readyStatus, github: { installed, authenticated } })
    await createRepository(user)
    expect(await screen.findByText((content) => content.startsWith(text))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled()
    if (installed) expect(screen.getByText('gh auth login --hostname github.com')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeEnabled())
    expect(bridge.publishRepository).not.toHaveBeenCalled()
  })

  it('surfaces repository status failures and checks again without recreating the folder', async () => {
    const { bridge, user } = await start()
    vi.mocked(bridge.getRepositoryStatus).mockRejectedValueOnce(new Error('The repository branch changed. Review it before publishing.'))
    await createRepository(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('branch changed')
    expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeEnabled())
    expect(bridge.createRepository).toHaveBeenCalledOnce()
    expect(bridge.publishRepository).not.toHaveBeenCalled()
  })
})
