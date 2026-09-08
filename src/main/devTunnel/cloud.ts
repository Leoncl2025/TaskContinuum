import type { Duplex } from 'node:stream'
import { TunnelRelayTunnelClient, TunnelRelayTunnelHost, ConnectionStatus } from '@microsoft/dev-tunnels-connections'
import { ManagementApiVersions, TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management'
import type { Tunnel } from '@microsoft/dev-tunnels-contracts'
import { DevTunnelCli } from './cli'
import { devTunnelIdSchema } from './protocol'

type Cancellation = NonNullable<Parameters<TunnelRelayTunnelClient['connect']>[2]>
export interface CloudConnection { close(): Promise<void>; connected(): boolean }
export interface TunnelCloud {
  host(id: string, port: number, signal: AbortSignal): Promise<CloudConnection>
  connect(id: string, port: number, signal: AbortSignal): Promise<CloudConnection & { stream: Duplex }>
}

function cancellation(signal: AbortSignal): Cancellation {
  return {
    get isCancellationRequested() { return signal.aborted },
    onCancellationRequested: (listener) => {
      const abort = () => listener(undefined)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) queueMicrotask(abort)
      return { dispose: () => signal.removeEventListener('abort', abort) }
    },
  }
}

function reference(id: string): Tunnel {
  const [tunnelId, clusterId] = devTunnelIdSchema.parse(id).split('.')
  return { tunnelId, clusterId }
}

function privateTunnel(tunnel: Tunnel | null, id: string, requireAccessControl = true): Tunnel {
  if (!tunnel || tunnel.clusterId !== reference(id).clusterId || tunnel.tunnelId !== reference(id).tunnelId) throw new Error('The Dev Tunnel identity changed or is unavailable.')
  if (requireAccessControl && !tunnel.accessControl || tunnel.accessControl?.entries.length) throw new Error('Only owner-private Dev Tunnels are supported. No shared or anonymous endpoint was accepted.')
  for (const port of tunnel.ports ?? []) if (port.accessControl?.entries.length) throw new Error('The tunnel port has an unexpected sharing policy.')
  for (const endpoint of tunnel.endpoints ?? []) {
    for (const key of ['hostRelayUri', 'clientRelayUri'] as const) {
      const value = (endpoint as unknown as Record<string, unknown>)[key]
      if (!value) continue
      const url = new URL(String(value))
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.rel.tunnels.api.visualstudio.com') || url.username || url.password || url.port && url.port !== '443') throw new Error('The tunnel service returned an untrusted relay endpoint.')
    }
  }
  return tunnel
}

export class SdkTunnelCloud implements TunnelCloud {
  constructor(private readonly cli: DevTunnelCli) {}
  async host(id: string, port: number, signal: AbortSignal): Promise<CloudConnection> {
    const management = new TunnelManagementHttpClient({ name: 'TaskContinuum', version: '0.1.0' }, ManagementApiVersions.Version20230927preview)
    management.trace = () => {}
    management.enableEventsReporting = false
    const host = new TunnelRelayTunnelHost(management, () => {})
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => { signal.removeEventListener('abort', abort); await host.dispose(); await management.dispose() })()
    const abort = () => { void close().catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    const token = cancellation(signal)
    let stage = 'port authorization'
    try {
      signal.throwIfAborted()
      const portsToken = await this.cli.token(id, 'manage:ports', signal)
      stage = 'tunnel lookup'
      let tunnel = privateTunnel(await management.getTunnel(reference(id), { accessToken: portsToken, includePorts: true }, token), id)
      if ((tunnel.ports ?? []).some((item) => item.portNumber !== port)) throw new Error('This app-owned tunnel contains other ports. No local service was exposed.')
      stage = 'port registration'
      await management.createOrUpdateTunnelPort(tunnel, { portNumber: port, protocol: 'auto' }, { accessToken: portsToken }, token)
      stage = 'host authorization'
      const hostToken = await this.cli.token(id, 'host', signal)
      stage = 'host lookup'
      tunnel = privateTunnel(await management.getTunnel(reference(id), { accessToken: hostToken, includePorts: true }, token), id)
      tunnel.accessTokens = { host: hostToken }
      host.forwardedPortConnecting((event) => { if (event.port !== port) event.transformPromise = Promise.resolve(null) })
      host.refreshingTunnelAccessToken((event) => { event.tunnelAccessToken = this.cli.token(id, 'host', signal) })
      stage = 'relay handshake'
      await host.connect(tunnel, { enableRetry: false, enableReconnect: false, keepAliveIntervalInSeconds: 15 }, token)
      signal.throwIfAborted()
      return { close, connected: () => host.connectionStatus === ConnectionStatus.Connected }
    } catch (error) {
      await close().catch(() => undefined)
      if (signal.aborted) throw new Error('Dev Tunnel publishing cancelled.')
      if (error instanceof Error && /other ports|app-owned|owner-private|sharing policy/.test(error.message)) throw error
      const status = (error as { response?: { status?: unknown } })?.response?.status
      const detail = typeof status === 'number' ? ` (HTTP ${status})` : error instanceof Error && error.name === 'ZodError' ? ' (invalid CLI response)' : ''
      throw new Error(`Dev Tunnel could not publish at ${stage}${detail}. Check sign-in, owner access, expiry, quota and network policy; retry explicitly.`)
    }
  }

  async connect(id: string, port: number, signal: AbortSignal): Promise<CloudConnection & { stream: Duplex }> {
    const management = new TunnelManagementHttpClient({ name: 'TaskContinuum', version: '0.1.0' }, ManagementApiVersions.Version20230927preview)
    management.trace = () => {}
    management.enableEventsReporting = false
    const client = new TunnelRelayTunnelClient(management, () => {})
    client.acceptLocalConnectionsForForwardedPorts = false
    client.portForwarding((event) => { if (event.portNumber !== port) event.cancel = true })
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => { signal.removeEventListener('abort', abort); await client.dispose(); await management.dispose() })()
    const abort = () => { void close().catch(() => undefined) }
    signal.addEventListener('abort', abort, { once: true })
    const token = cancellation(signal)
    let stage = 'client authorization'
    try {
      signal.throwIfAborted()
      await this.cli.inspect(id, signal, true)
      const accessToken = await this.cli.token(id, 'connect', signal)
      stage = 'endpoint lookup'
      const tunnel = privateTunnel(await management.getTunnel(reference(id), { accessToken, includePorts: true }, token), id, false)
      if (!tunnel.ports?.some((item) => item.portNumber === port)) throw new Error('The invited tunnel port is no longer published.')
      tunnel.accessTokens = { connect: accessToken }
      client.refreshingTunnelAccessToken((event) => { event.tunnelAccessToken = this.cli.token(id, 'connect', signal) })
      stage = 'relay handshake'
      await client.connect(tunnel, { enableRetry: false, enableReconnect: false, keepAliveIntervalInSeconds: 15 }, token)
      stage = 'port announcement'
      await client.waitForForwardedPort(port, token)
      stage = 'port connection'
      const stream = await client.connectToForwardedPort(port, token)
      signal.throwIfAborted()
      return { stream, close, connected: () => client.connectionStatus === ConnectionStatus.Connected }
    } catch (error) {
      await close().catch(() => undefined)
      if (error instanceof Error && /^(The Dev Tunnel identity|Only owner-private|The tunnel port has|The tunnel service returned|The invited tunnel port)/.test(error.message)) throw error
      const status = (error as { response?: { status?: unknown } })?.response?.status
      throw new Error(signal.aborted ? 'Dev Tunnel connection cancelled.' : `Dev Tunnel could not connect at ${stage}${typeof status === 'number' ? ` (HTTP ${status})` : ''}. Use the same company account as the owner and ensure its publication is online. No message was sent.`)
    }
  }
}