import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceDocument } from '../src/renderer/components/WorkspaceDocument'
import { WorkspacePicker } from '../src/renderer/components/WorkspacePicker'
import type { WorkspaceSnapshot } from '../src/shared/workspace'

const current: WorkspaceSnapshot = { id: 'first', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }

describe('workspace controls', () => {
  it('opens folders and switches to a recent workspace without confusing display names', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onSelect = vi.fn()
    render(<WorkspacePicker state={{ current, recent: [current, { ...current, id: 'second', name: 'Another-ad' }] }} busy={false} locked={false} onOpen={onOpen} onSelect={onSelect} onRefresh={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toHaveValue('first')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Workspace' }), 'second')
    expect(onSelect).toHaveBeenCalledWith('second')
    await user.click(screen.getByRole('button', { name: 'Open workspace folder' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('prevents workspace changes while a response or native operation is active', () => {
    render(<WorkspacePicker state={{ current, recent: [current] }} busy={false} locked onOpen={vi.fn()} onSelect={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Open workspace folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeDisabled()
  })

  it('renders task Markdown as inert content without loading images or navigating links', () => {
    const source = '# Requirements\n\n| ID | Requirement |\n|---|---|\n| FR-01 | Actual work |\n\n[External](https://example.com)\n\n![Remote image](https://example.com/track.png)\n\n<script>window.hacked = true</script>'
    const { container } = render(<WorkspaceDocument source={source} />)
    expect(within(screen.getByRole('table')).getByText('Actual work')).toBeInTheDocument()
    expect(screen.getByText('External')).toBeInTheDocument()
    expect(container.querySelectorAll('img, script, a')).toHaveLength(0)
  })
})