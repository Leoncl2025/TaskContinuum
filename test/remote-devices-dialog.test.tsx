import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteDevicesDialog } from '../src/renderer/components/RemoteDevicesDialog'
import { RemoteDeviceConnections } from '../src/renderer/components/RemoteDeviceControls'
import { MachineAliasesProvider } from '../src/renderer/MachineAliasesProvider'
import type { RemoteVSCodeBridge } from '../src/shared/remoteVSCode'
import type { DevTunnelStatus } from '../src/shared/devTunnel'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

type Device = Awaited<ReturnType<NonNullable<RemoteVSCodeBridge['devices']>['list']>>[number]

function fixture() {
  const git = gitSyncUiFixture()
  git.setStatus({
    enabled: true, state: 'idle', intervalMs: 15000, pending: 0, provisionalTasks: [], conflicts: [], revision: null,
    peers: [{ deviceId: 'device-b', machineName: 'Machine-B', state: 'linked' }],
  })
  let status: DevTunnelStatus = { installed: true, account: 'owner@example.test', state: 'idle' }
  const device: Device = { id: 'device-b', machineName: 'Machine-B', state: 'connected', enabled: true, expiresAt: '2099-01-01T00:00:00Z' }
  let forgotten = false
  const devices: NonNullable<RemoteVSCodeBridge['devices']> = {
    list: vi.fn(async () => forgotten ? [] : [{ ...device }]),
    connect: vi.fn(async () => { device.enabled = true; device.state = 'connected' }),
    disconnect: vi.fn(async () => { device.enabled = false; device.state = 'offline' }),
    forget: vi.fn(async () => { forgotten = true }),
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

afterEach(() => { delete window.remoteVSCode; delete window.agentHost })

describe('native Agent Host remote device controls', () => {
  it('propagates alias saves by authenticated owner UUID while device actions retain pairing IDs', async () => {
    const setup = fixture()
    const ownerClientId = crypto.randomUUID()
    const device: Device = { id: 'pairing-connection-id', ownerClientId, machineName: 'Machine-B', enabled: true, state: 'connected', expiresAt: '2099-01-01T00:00:00Z' }
    const ownerless: Device = { ...device, id: ownerClientId, ownerClientId: undefined, machineName: 'Ownerless-host' }
    vi.mocked(setup.devices.list).mockResolvedValue([device, ownerless])
    setup.setStatus({
      ...setup.getStatus(), peers: [{ deviceId: ownerClientId, machineName: device.machineName, state: 'offline' }],
      machineAliases: { [ownerClientId]: 'Office', [device.id]: 'Wrong pairing alias', [device.machineName]: 'Wrong hostname alias' },
    })
    render(<MachineAliasesProvider workspaceId="workspace"><RemoteDevicesDialog onClose={vi.fn()} /></MachineAliasesProvider>)
    await screen.findByRole('button', { name: 'Disconnect device Office (Machine-B)' })
    expect(screen.getByRole('button', { name: 'Disconnect device Ownerless-host' })).toBeInTheDocument()
    expect(screen.queryByText(/Wrong pairing alias|Wrong hostname alias/)).not.toBeInTheDocument()
    expect(setup.api.status).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Machine-B' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Machine alias for Machine-B' }), { target: { value: 'Studio' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Machine alias for Machine-B' })).not.toBeInTheDocument())
    const disconnect = await screen.findByRole('button', { name: 'Disconnect device Studio (Machine-B)' })
    expect(setup.api.setMachineAlias).toHaveBeenCalledExactlyOnceWith(ownerClientId, 'Studio', null)
    expect(setup.devices.connect).not.toHaveBeenCalled()
    expect(setup.devices.disconnect).not.toHaveBeenCalled()
    fireEvent.click(disconnect)
    await waitFor(() => expect(setup.devices.disconnect).toHaveBeenCalledExactlyOnceWith(device.id))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect device Studio (Machine-B)' }))
    await waitFor(() => expect(setup.devices.connect).toHaveBeenCalledExactlyOnceWith(device.id))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget device Studio (Machine-B)' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Forget device Studio (Machine-B)' }))
    await waitFor(() => expect(setup.devices.forget).toHaveBeenCalledExactlyOnceWith(device.id))
    expect(device.ownerClientId).toBe(ownerClientId)
    expect(device.machineName).toBe('Machine-B')
    fireEvent.click(screen.getByRole('button', { name: 'Rename Machine-B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear alias' }))
    await screen.findByRole('button', { name: 'Disconnect device Machine-B' })
    expect(setup.api.revokeDevice).not.toHaveBeenCalled()
  })

  it('uses original device names when rendered outside the workspace alias provider', async () => {
    const setup = fixture()
    setup.setStatus({ ...setup.getStatus(), machineAliases: { 'device-b': 'Not available outside this workspace' } })
    render(<RemoteDeviceConnections />)
    await screen.findByRole('button', { name: 'Disconnect device Machine-B' })
    expect(setup.api.status).not.toHaveBeenCalled()
    expect(screen.queryByText('Not available outside this workspace')).not.toBeInTheDocument()
  })

  it('shows trusted automatic links without manual pairing, permission controls or automatic session actions', async () => {
    const { devices, api, devTunnels } = fixture()
    const send = vi.fn()
    const create = vi.fn()
    Reflect.set(window, 'agentHost', { send, create })
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Remote devices' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Dev Tunnel service' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workspace Git synchronization' })).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Disconnect device Machine-B' })
    expect(screen.getByText('linked', { exact: true })).toBeInTheDocument()
    expect(screen.getByText(/Trusted devices can access linked sessions/)).toHaveTextContent('Native approvals still apply; no automatic messages or new sessions.')
    for (const name of [
      'Pair device', 'Import device invitation', 'Export device identity', 'Confirm existing Agent Host links',
      'Enable linked sessions', 'Disable linked sessions for this workspace', 'Revoke paired device',
      'Import invitation', 'Share session', 'Choose recipient', 'Link to T-0003', 'Export client identity',
    ]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Paired recipient device')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Linked-session workspace access')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Read only|Read and send/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('SSH host alias')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'SSH alias' })).not.toBeInTheDocument()
    expect(screen.queryByText('Legacy session invitation')).not.toBeInTheDocument()
    expect(devices.connect).not.toHaveBeenCalled()
    expect(devices.disconnect).not.toHaveBeenCalled()
    expect(devices.forget).not.toHaveBeenCalled()
    expect(api.enable).not.toHaveBeenCalled()
    expect(api.disable).not.toHaveBeenCalled()
    expect(api.revokeDevice).not.toHaveBeenCalled()
    expect(devTunnels.publish).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('retains automatic link revocation and pause without per-device permission grants', async () => {
    const { api } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke automatic link' }))
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('device-b'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause automatic links' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic links' }))
    await screen.findByRole('button', { name: 'Enable automatic links' })
    expect(api.disable).toHaveBeenCalledOnce()
  })

  it('guards automatic link operations while revoking and surfaces failures', async () => {
    const { api } = fixture()
    let reject!: (reason: Error) => void
    vi.mocked(api.revokeDevice).mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke automatic link' }))
    expect(screen.getByRole('button', { name: 'Revoke automatic link' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause automatic links' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke automatic link' }))
    expect(api.revokeDevice).toHaveBeenCalledOnce()
    reject(new Error('Automatic link revocation failed.'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic link revocation failed.')
    expect(screen.getByRole('button', { name: 'Revoke automatic link' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke automatic link' }))
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('connects and disconnects devices without invoking session controls', async () => {
    const { devices } = fixture()
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect device Machine-B' }))
    await screen.findByRole('button', { name: 'Connect device Machine-B' })
    expect(devices.disconnect).toHaveBeenCalledWith('device-b')
    fireEvent.click(screen.getByRole('button', { name: 'Connect device Machine-B' }))
    await screen.findByRole('button', { name: 'Disconnect device Machine-B' })
    expect(devices.connect).toHaveBeenCalledWith('device-b')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect device Machine-B' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect device Machine-B' }))
    await waitFor(() => expect(devices.connect).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget device Machine-B' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Forget device Machine-B' }))
    await waitFor(() => expect(devices.forget).toHaveBeenCalledWith('device-b'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect device Machine-B' })).not.toBeInTheDocument())
    expect(await screen.findByText('No linked devices')).toBeInTheDocument()
  })

  it('surfaces device discovery failures', async () => {
    const { devices } = fixture()
    vi.mocked(devices.list).mockRejectedValueOnce(new Error('Device discovery unavailable.'))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Device discovery unavailable.')
    expect(screen.queryByText('No linked devices')).not.toBeInTheDocument()
  })

  it('surfaces connection failures and keeps disconnect available while another connection is pending', async () => {
    const { devices } = fixture()
    vi.mocked(devices.connect).mockRejectedValueOnce(new Error('Device connection failed.'))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect device Machine-B' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Device connection failed.')
    let finish!: () => void
    vi.mocked(devices.connect).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect device Machine-B' }))
    expect(screen.getByRole('button', { name: 'Reconnect device Machine-B' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Forget device Machine-B' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect device Machine-B' }))
    expect(devices.connect).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Disconnect device Machine-B' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect device Machine-B' }))
    await screen.findByRole('button', { name: 'Connect device Machine-B' })
    expect(devices.disconnect).toHaveBeenCalledWith('device-b')
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Forget device Machine-B' })).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports disconnection errors and allows an explicit retry', async () => {
    const { devices } = fixture()
    vi.mocked(devices.disconnect).mockRejectedValueOnce(new Error('Device disconnect failed.'))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect device Machine-B' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Device disconnect failed.')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect device Machine-B' }))
    await screen.findByRole('button', { name: 'Connect device Machine-B' })
    expect(devices.disconnect).toHaveBeenCalledTimes(2)
  })

  it('keeps workspace links available without a devices API and reports a missing bridge', async () => {
    const { remote } = fixture()
    delete remote.devices
    const { unmount } = render(<RemoteDevicesDialog onClose={vi.fn()} />)
    await screen.findByRole('button', { name: 'Pause automatic links' })
    unmount()
    delete window.remoteVSCode
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The remote device desktop API is unavailable.')
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
    const { api, setStatus } = fixture()
    setStatus({ enabled: false, state: 'disabled', intervalMs: 15000, pending: 0, provisionalTasks: [], conflicts: [], peers: [], revision: null })
    vi.mocked(api.enable).mockRejectedValueOnce(new Error('Git upstream is required.'))
    render(<RemoteDevicesDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic links' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Git upstream is required.')
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic links' }))
    await screen.findByRole('button', { name: 'Pause automatic links' })
    expect(api.enable).toHaveBeenCalledTimes(2)
  })
})
