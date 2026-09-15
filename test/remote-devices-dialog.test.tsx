import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDevicesDialog } from '../src/renderer/components/RemoteDevicesDialog'
import type { RemoteVSCodeBridge } from '../src/shared/remoteVSCode'
import type { DevTunnelStatus } from '../src/shared/devTunnel'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

type Device = Awaited<ReturnType<NonNullable<RemoteVSCodeBridge['devices']>['list']>>[number]

function fixture() {
  const git = gitSyncUiFixture()
  let status: DevTunnelStatus = { installed: true, account: 'owner@example.test', state: 'idle' }
  const device: Device = { id: 'device-b', machineName: 'Machine-B', state: 'offline', enabled: false, expiresAt: '2099-01-01T00:00:00Z' }
  let access: 'none' | 'read' | 'send' = 'none'
  const devices: NonNullable<RemoteVSCodeBridge['devices']> = {
    list: vi.fn(async () => [{ ...device }]),
    recipients: vi.fn(async () => [{ id: 'device-a', username: 'Alice', machineName: 'Machine-A', expiresAt: device.expiresAt, linkedAccess: access }]),
    pair: vi.fn(async () => true),
    workspace: vi.fn(async (_id, value) => { access = value; return true }),
    adoptLinks: vi.fn(async () => true),
    import: vi.fn(async () => true),
    connect: vi.fn(async () => { device.enabled = true; device.state = 'connected' }),
    disconnect: vi.fn(async () => { device.enabled = false; device.state = 'offline' }),
    forget: vi.fn(async () => {}), revoke: vi.fn(async () => {}),
  }
  const devTunnels: NonNullable<RemoteVSCodeBridge['devTunnels']> = {
    status: vi.fn(async () => status), login: vi.fn(async () => {}),
    publish: vi.fn(async () => { status = { ...status, state: 'hosting', tunnelId: 'owner.jpe1' } }),
    stop: vi.fn(async () => { status = { ...status, state: 'idle' } }),
    cancel: vi.fn(async () => {}), reset: vi.fn(async () => {}), installationGuide: vi.fn(async () => {}),
  }
  const remote: RemoteVSCodeBridge = { ...git.remote, devices, devTunnels }
  window.remoteVSCode = remote
  return { ...git, remote, devices, devTunnels }
}

afterEach(() => { delete window.remoteVSCode })

describe('native Agent Host remote device controls', () => {
  it('shows device, tunnel and Git controls without session invitations, SSH aliases or legacy links', async () => {
    const { devices } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Remote devices' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dev Tunnel service' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workspace Git synchronization' })).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Connect device Machine-B' })
    expect(screen.getByRole('button', { name: 'Import device invitation' })).toBeInTheDocument()
    for (const name of ['Import invitation', 'Share session', 'Choose recipient', 'Link to T-0003', 'Export client identity']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('SSH host alias')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'SSH alias' })).not.toBeInTheDocument()
    expect(screen.queryByText('Legacy session invitation')).not.toBeInTheDocument()
    expect(devices.connect).not.toHaveBeenCalled()
    expect(devices.pair).not.toHaveBeenCalled()
  })

  it('exports only the managed device identity and does not claim a cancelled export succeeded', async () => {
    const { remote } = fixture()
    vi.mocked(remote.exportIdentity).mockResolvedValueOnce(false)
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    await screen.findByText('owner@example.test')
    fireEvent.click(screen.getByRole('button', { name: 'Export device identity' }))
    await waitFor(() => expect(remote.exportIdentity).toHaveBeenCalledWith(true))
    expect(screen.queryByText('Device identity exported.')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export device identity' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Export device identity' }))
    await screen.findByText('Device identity exported.')
    vi.mocked(remote.exportIdentity).mockRejectedValueOnce(new Error('Secure device storage unavailable.'))
    fireEvent.click(screen.getByRole('button', { name: 'Export device identity' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure device storage unavailable.')
  })

  it('grants and revokes workspace AH access without per-session sharing', async () => {
    const { devices } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'Alice @ Machine-A' })
    fireEvent.change(screen.getByLabelText('Paired recipient device'), { target: { value: 'device-a' } })
    fireEvent.change(screen.getByLabelText('Linked-session workspace access'), { target: { value: 'read' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable linked sessions' }))
    await waitFor(() => expect(devices.workspace).toHaveBeenCalledWith('device-a', 'read'))
    await screen.findByText('Workspace access: read')
    fireEvent.click(screen.getByRole('button', { name: 'Disable linked sessions for this workspace' }))
    await waitFor(() => expect(devices.workspace).toHaveBeenCalledWith('device-a', 'none'))
    await screen.findByText('Workspace access: none')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke paired device' }))
    await waitFor(() => expect(devices.revoke).toHaveBeenCalledWith('device-a'))
    expect(devices).not.toHaveProperty('share')
    expect(devices).not.toHaveProperty('unshare')
  })

  it('keeps explicit device import, pairing and AH-link confirmation', async () => {
    const { devices } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import device invitation' }))
    await waitFor(() => expect(devices.import).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pair device' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Pair device' }))
    await waitFor(() => expect(devices.pair).toHaveBeenCalledWith(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm existing Agent Host links' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm existing Agent Host links' }))
    await screen.findByText('Existing Agent Host links confirmed on this device.')
    expect(devices.adoptLinks).toHaveBeenCalledOnce()
  })

  it('connects and disconnects devices without invoking session controls', async () => {
    const { devices } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect device Machine-B' }))
    await screen.findByRole('button', { name: 'Disconnect device Machine-B' })
    expect(devices.connect).toHaveBeenCalledWith('device-b')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect device Machine-B' }))
    await screen.findByRole('button', { name: 'Connect device Machine-B' })
    expect(devices.disconnect).toHaveBeenCalledWith('device-b')
    fireEvent.click(screen.getByRole('button', { name: 'Forget device Machine-B' }))
    await waitFor(() => expect(devices.forget).toHaveBeenCalledWith('device-b'))
  })

  it('retains publication, reset and cancellable sign-in without legacy invitation controls', async () => {
    const { devTunnels } = fixture()
    const close = vi.fn()
    render(<RemoteDevicesDialog onClose={close} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish this machine' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Publish this machine' }))
    await screen.findByRole('button', { name: 'Stop publication' })
    expect(devTunnels.publish).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Stop publication' }))
    await waitFor(() => expect(devTunnels.stop).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset saved publication' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Reset saved publication' }))
    await waitFor(() => expect(devTunnels.reset).toHaveBeenCalledOnce())
    let finish!: () => void
    vi.mocked(devTunnels.login).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.mocked(devTunnels.cancel).mockImplementation(async () => finish())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close Remote devices' }))
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Dev Tunnel operation' }))
    await waitFor(() => expect(devTunnels.cancel).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled())
  })

  it('keeps Automatic workspace links available and surfaces enrollment errors', async () => {
    const { api } = fixture()
    vi.mocked(api.enable).mockRejectedValueOnce(new Error('Git upstream is required.'))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic links' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Git upstream is required.')
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic links' }))
    await screen.findByRole('button', { name: 'Pause automatic links' })
    expect(api.enable).toHaveBeenCalledTimes(2)
  })
})
