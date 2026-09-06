import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopilotInteractionDialog, CopilotSessionDialog } from '../src/renderer/components/CopilotDialogs'
import { LocalSessions } from '../src/renderer/components/LocalSessions'
import { mockCopilotBridge } from './copilot-fixtures'

describe('local session controls', () => {
  it('separates native resume from read-only VS Code preview and filters by source', async () => {
    const user = userEvent.setup()
    const host = mockCopilotBridge()
    const onOpen = vi.fn()
    render(<LocalSessions status={{ state: 'ready', workingDirectory: 'Q:\\src' }} listing={{ sessions: [host.native, host.source], warnings: [] }} busy={null} onConnect={vi.fn()} onDisconnect={vi.fn()} onRefresh={vi.fn()} onNew={vi.fn()} onOpen={onOpen} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Session source' }), 'vscode')
    expect(screen.queryByRole('button', { name: 'Resume Existing CLI work' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview Existing VS Code work' }))
    expect(onOpen).toHaveBeenCalledWith(host.source)
  })

  it('shows exactly the history that will be imported and requires explicit confirmation', async () => {
    const user = userEvent.setup()
    const host = mockCopilotBridge()
    const onSubmit = vi.fn()
    render(<CopilotSessionDialog preview={await host.bridge.previewImport(host.source.id)} directory="Q:\\src" models={[]} ready busy={false} error={null} onBrowse={host.bridge.chooseDirectory} onConnect={vi.fn()} onSubmit={onSubmit} onClose={vi.fn()} />)
    expect(screen.getByText('Previous local answer')).toBeInTheDocument()
    expect(screen.getByText(/VS Code source stays unchanged/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Continue in new session' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: host.source.workingDirectory }))
  })

  it('only exposes deny and one-time approval for tool requests', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(<CopilotInteractionDialog interaction={{ type: 'permission', id: 'permission', sessionId: 'native-session', kind: 'shell', details: 'git status --short' }} busy={false} error={null} onRespond={onRespond} />)
    const dialog = screen.getByRole('dialog', { name: 'Copilot permission' })
    expect(within(dialog).getByText('git status --short')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Allow once' }))
    expect(onRespond).toHaveBeenCalledWith(true)
  })

  it('forwards an offered answer and does not provide freeform input when disabled', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(<CopilotInteractionDialog interaction={{ type: 'user-input', id: 'question', sessionId: 'native-session', question: 'Which test?', choices: ['Unit', 'Desktop'], allowFreeform: false }} busy={false} error={null} onRespond={onRespond} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Desktop' }))
    await user.click(screen.getByRole('button', { name: 'Submit answer' }))
    expect(onRespond).toHaveBeenCalledWith('Desktop')
  })
})