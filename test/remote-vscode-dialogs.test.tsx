import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteVSCodeAccessDialog, RemoteVSCodeDialog } from '../src/renderer/components/RemoteVSCodeDialogs'
import type { RemoteVSCodeBridge, RemoteVSCodeConnection } from '../src/shared/remoteVSCode'
import type { DevTunnelStatus } from '../src/shared/devTunnel'

const connection: RemoteVSCodeConnection = {
  id: 'remote-one', target: { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32), remoteMachineName: 'Machine-B' },
  title: 'Original on B', hostAlias: 'owner', participant: { clientId: 'client-a', username: 'Alice', machineName: 'Machine-A' },
  execution: { agentName: 'GitHub Copilot', machineName: 'Machine-B' }, canSend: true, expiresAt: '2099-01-01T00:00:00Z', state: 'disconnected',
}

function bridge(): RemoteVSCodeBridge {
  return { exportIdentity: vi.fn(async () => true), importInvitation: vi.fn(async () => connection), list: vi.fn(async () => []),
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), forget: vi.fn(async () => {}),
    share: vi.fn(async () => true), grants: vi.fn(async () => []), revoke: vi.fn(async () => {}) }
}

function pendingOperation() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

afterEach(() => { cleanup(); delete window.remoteVSCode })

describe('remote original-session dialogs', () => {
  it('connects at device scope and shares another session without exporting another invitation', async () => {
    const remote = bridge()
    remote.devTunnels = { status: vi.fn(async (): Promise<DevTunnelStatus> => ({ installed: true, account: 'owner@example.test', state: 'hosting' })), login: vi.fn(async () => {}), publish: vi.fn(async () => {}), stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}), reset: vi.fn(async () => {}), installationGuide: vi.fn(async () => {}) }
    remote.devices = { list: vi.fn(async () => [{ id: 'device-b', machineName: 'Machine-B', state: 'offline' as const, enabled: false, expiresAt: connection.expiresAt }]),
      recipients: vi.fn(async () => [{ id: 'device-a', username: 'Alice', machineName: 'Machine-A', expiresAt: connection.expiresAt }]),
      pair: vi.fn(async () => true), import: vi.fn(async () => true), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), forget: vi.fn(async () => {}), revoke: vi.fn(async () => {}), share: vi.fn(async () => true), unshare: vi.fn(async () => {}) }
    remote.list = vi.fn(async () => [{ ...connection, deviceId: 'device-b' }])
    window.remoteVSCode = remote
    const view = render(<RemoteVSCodeDialog taskId="T-0003" onLink={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect device Machine-B' }))
    await waitFor(() => expect(remote.devices!.connect).toHaveBeenCalledWith('device-b'))
    expect(screen.queryByRole('button', { name: 'Connect Machine-B' })).not.toBeInTheDocument()
    expect(remote.connect).not.toHaveBeenCalled()
    view.unmount()
    const identity = { nativeSessionId: 'second', workspaceStorageId: 'a'.repeat(32) }
    render(<RemoteVSCodeAccessDialog identity={identity} onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'Alice @ Machine-A' })
    fireEvent.change(screen.getByLabelText('Paired recipient device'), { target: { value: 'device-a' } })
    fireEvent.change(screen.getByLabelText('Remote invitation access'), { target: { value: 'send' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share session' }))
    await waitFor(() => expect(remote.devices!.share).toHaveBeenCalledWith('device-a', identity, true))
    expect(remote.share).not.toHaveBeenCalled()
    expect(remote.devices.pair).not.toHaveBeenCalled()
  })

  it('exports a managed key and imports a Dev Tunnel invitation without manual SSH fields or auto-connect', async () => {
    const remote = bridge()
    remote.devTunnels = { status: vi.fn(async (): Promise<DevTunnelStatus> => ({ installed: true, account: 'owner@example.test', state: 'idle' })), login: vi.fn(async () => {}), publish: vi.fn(async () => {}), stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}), reset: vi.fn(async () => {}), installationGuide: vi.fn(async () => {}) }
    window.remoteVSCode = remote
    render(<RemoteVSCodeDialog taskId="T-0003" onLink={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('owner@example.test')
    fireEvent.click(screen.getByText('Legacy session invitation'))
    expect(screen.queryByLabelText('SSH host alias')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import invitation' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Export client identity' }))
    await screen.findByText('Client identity exported.')
    expect(remote.exportIdentity).toHaveBeenCalledWith(true)
    vi.mocked(remote.list).mockResolvedValue([{ ...connection, transport: 'dev-tunnel' }])
    fireEvent.click(screen.getByRole('button', { name: 'Import invitation' }))
    await screen.findByText('Invitation imported for Machine-B.')
    expect(remote.importInvitation).toHaveBeenCalledWith()
    expect(remote.connect).not.toHaveBeenCalled()
    const pending = pendingOperation()
    vi.mocked(remote.connect).mockImplementation(() => pending.promise)
    vi.mocked(remote.disconnect).mockImplementation(async () => pending.resolve())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Machine-B' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Connect Machine-B' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel connection to Machine-B' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    await waitFor(() => expect(remote.disconnect).toHaveBeenCalledWith(connection.id))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Machine-B' })).toBeEnabled())
    fireEvent.click(screen.getByRole('radio', { name: 'SSH alias' }))
    expect(screen.getByLabelText('SSH host alias')).toBeInTheDocument()
  })

  it('publishes from the owner dialog before creating a managed invitation and supports stopping', async () => {
    const remote = bridge()
    let state: DevTunnelStatus = { installed: true, account: 'owner@example.test', state: 'idle' }
    remote.devTunnels = { status: vi.fn(async () => state), login: vi.fn(async () => {}), publish: vi.fn(async () => { state = { ...state, state: 'hosting', tunnelId: 'owner.jpe1' } }), stop: vi.fn(async () => { state = { ...state, state: 'idle' } }), cancel: vi.fn(async () => {}), reset: vi.fn(async () => {}), installationGuide: vi.fn(async () => {}) }
    window.remoteVSCode = remote
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    render(<RemoteVSCodeAccessDialog identity={identity} onClose={vi.fn()} />)
    await screen.findByText('owner@example.test')
    expect(screen.getByRole('button', { name: 'Choose recipient' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Publish this machine' }))
    await screen.findByRole('button', { name: 'Stop publication' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose recipient' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Choose recipient' }))
    await screen.findByText('Private invitation saved. Expires in 24 hours or when the bridge stops.')
    expect(remote.share).toHaveBeenCalledWith(identity, false, true)
    fireEvent.click(screen.getByRole('button', { name: 'Stop publication' }))
    await waitFor(() => expect(remote.devTunnels!.stop).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset saved publication' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Reset saved publication' }))
    await waitFor(() => expect(remote.devTunnels!.reset).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled())
    const signingIn = pendingOperation()
    vi.mocked(remote.devTunnels!.login).mockImplementation(() => signingIn.promise)
    vi.mocked(remote.devTunnels!.cancel).mockImplementation(async () => signingIn.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Dev Tunnel operation' }))
    await waitFor(() => expect(remote.devTunnels!.cancel).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled())
    expect(remote.devTunnels!.stop).toHaveBeenCalledOnce()
  })

  it('separates import, connection, task linking, and local disconnect', async () => {
    const remote = bridge()
    window.remoteVSCode = remote
    const onLink = vi.fn(async () => {})
    render(<RemoteVSCodeDialog taskId="T-0003" onLink={onLink} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Import invitation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Export client identity' }))
    await screen.findByText('Client identity exported.')
    fireEvent.change(screen.getByLabelText('SSH host alias'), { target: { value: '-oProxyCommand=bad' } })
    expect(screen.getByRole('button', { name: 'Import invitation' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('SSH host alias'), { target: { value: 'owner' } })
    vi.mocked(remote.list).mockResolvedValue([connection])
    fireEvent.click(screen.getByRole('button', { name: 'Import invitation' }))
    await screen.findByText('Invitation imported for Machine-B.')
    expect(remote.importInvitation).toHaveBeenCalledWith('owner')
    expect(remote.connect).not.toHaveBeenCalled()
    expect(onLink).not.toHaveBeenCalled()
    expect(screen.getByText('GitHub Copilot @ Machine-B')).toBeInTheDocument()
    expect(screen.getByText('Alice @ Machine-A')).toBeInTheDocument()
    vi.mocked(remote.list).mockResolvedValue([{ ...connection, state: 'connected' }])
    fireEvent.click(screen.getByRole('button', { name: 'Connect Machine-B' }))
    await screen.findByRole('button', { name: 'Disconnect Machine-B' })
    expect(remote.connect).toHaveBeenCalledWith(connection.id)
    fireEvent.click(screen.getByRole('button', { name: 'Link to T-0003' }))
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(expect.objectContaining({ target: connection.target })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect Machine-B' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Machine-B' }))
    await waitFor(() => expect(remote.disconnect).toHaveBeenCalledWith(connection.id))
  })

  it('defaults invitations to read-only and permits explicit owner revocation', async () => {
    const remote = bridge()
    window.remoteVSCode = remote
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    render(<RemoteVSCodeAccessDialog identity={identity} onClose={() => {}} />)
    expect(screen.getByLabelText('Remote invitation access')).toHaveValue('read')
    fireEvent.click(screen.getByRole('button', { name: 'Choose recipient' }))
    await screen.findByText('Private invitation saved. Expires in 24 hours or when the bridge stops.')
    expect(remote.share).toHaveBeenCalledWith(identity, false)
    vi.mocked(remote.grants).mockResolvedValue([{ id: 'grant-one', participant: connection.participant, canSend: true, expiresAt: connection.expiresAt }])
    fireEvent.change(screen.getByLabelText('Remote invitation access'), { target: { value: 'send' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose recipient' }))
    await screen.findByRole('button', { name: 'Revoke Alice on Machine-A' })
    expect(remote.share).toHaveBeenCalledWith(identity, true)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Alice on Machine-A' }))
    await waitFor(() => expect(remote.revoke).toHaveBeenCalledWith(identity, 'grant-one'))
  })
})