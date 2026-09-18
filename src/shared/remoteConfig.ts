import type { SessionLink, SessionLinksSnapshot } from './sessionBindings'

export const remoteConfigFormat = 'immutable-operations-v1' as const
export const remoteConfigRecordsPath = '.taskcontinuum/records/v1'
export const remoteConfigLimits = {
  recordBytes: 32 * 1024,
  records: 10000,
  totalBytes: 64 * 1024 * 1024,
  parents: 256,
  notificationDependencies: 64,
  notificationBytes: 256 * 1024,
  overlayOperations: 128,
  overlayBytes: 1024 * 1024,
  overlayLifetimeMs: 60000,
} as const

export interface RemoteActor { deviceId: string; keyId: string }
export interface RemoteDeviceIdentity {
  machineName: string
  clientPublicKey: string
  hostPublicKey: string
  clientKeyId: string
  hostKeyId: string
  /** Optional only in historical records; new operational publications require this field. */
  username?: string
}
export interface RemoteDeviceRoute {
  kind: 'dev-tunnel'
  tunnelId: string
  sshPort: number
  /** Optional only in historical records; new operational publications require this field. */
  controlPort?: number
}
export type DevicePayload = {
  action: 'publish'
  deviceId: string
  identity: RemoteDeviceIdentity
  routes: RemoteDeviceRoute[]
} | { action: 'remove'; deviceId: string }

interface InvitationIdentity {
  issuerId: string
  recipientId: string
  grantId: string
  issuerIdentityRef: string
  recipientIdentityRef: string
}
export type InvitationPayload = InvitationIdentity & ({
  action: 'grant'
  capability: 'ah-link'
  issuedAt: string
  expiresAt: string
  routeRef: { identityRef: string; routeIndex: number }
} | { action: 'revoke'; revokes: string })
export type BindingPayload = { schemaVersion: 2; action: 'set'; taskId: string; target: SessionLink } | { schemaVersion: 2; action: 'delete'; taskId: string }
export interface RemoteSettings {
  autoLink: boolean
  tunnelEnabled: boolean
  connectTimeoutMs: number
}
export const remoteConfigDefaults: Readonly<RemoteSettings> = { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000 }
export type RemoteSettingKey = keyof RemoteSettings
export type RemoteSettingChanges = { [Key in RemoteSettingKey]?: RemoteSettings[Key] | null }
export type SettingScope = { scope: 'workspace' } | { scope: 'device'; deviceId: string }
export type SettingPayload = SettingScope & (
  { action: 'delete'; settingKey: RemoteSettingKey }
  | { action: 'set'; settingKey: 'autoLink' | 'tunnelEnabled'; value: boolean }
  | { action: 'set'; settingKey: 'connectTimeoutMs'; value: number }
)
export interface RemotePayloads { device: DevicePayload; invitation: InvitationPayload; binding: BindingPayload; setting: SettingPayload }
export type RemoteRecordKind = keyof RemotePayloads
export interface RemoteRecordHeader {
  schemaVersion: 1
  workspaceId: string
  nonce: string
  actor: RemoteActor
  parents: string[]
  createdAt: string
}
export type RemoteRecordBody<K extends RemoteRecordKind = RemoteRecordKind> = {
  [Kind in RemoteRecordKind]: RemoteRecordHeader & { kind: Kind; payload: RemotePayloads[Kind] }
}[K]
export type RemoteRecord<K extends RemoteRecordKind = RemoteRecordKind> = {
  [Kind in RemoteRecordKind]: RemoteRecordHeader & { kind: Kind; payload: RemotePayloads[Kind] } & {
    operationId: string
    signature: { algorithm: 'ed25519'; value: string }
  }
}[K]
export type DeviceRecord = RemoteRecord<'device'>
export type InvitationRecord = RemoteRecord<'invitation'>
export type BindingRecord = RemoteRecord<'binding'>
export type SettingRecord = RemoteRecord<'setting'>
export type RemoteEntityState = 'active' | 'deleted' | 'needs-resolution' | 'blocked' | 'expired'
export interface RemoteConfigDiagnostic {
  code: string
  message: string
  entityKey?: string
  operationId?: string
}
export interface ResolvedRemoteEntity {
  key: string
  kind: RemoteRecordKind
  state: RemoteEntityState
  heads: string[]
  records: RemoteRecord[]
  value?: RemoteRecord
}
export interface ResolvedRemoteConfig {
  revision: string
  records: RemoteRecord[]
  entities: Record<string, ResolvedRemoteEntity>
  heads: Record<string, string[]>
  /** Automatic-link eligible identities; incomplete historical values remain under entities with diagnostics. */
  devices: Record<string, DeviceRecord>
  invitations: Record<string, InvitationRecord>
  bindings: Record<string, SessionLink>
  settings: { workspace: Partial<RemoteSettings>; devices: Record<string, Partial<RemoteSettings>> }
  diagnostics: RemoteConfigDiagnostic[]
  blocked: boolean
}
export interface BindingChangedNotification {
  schemaVersion: 1
  kind: 'binding.changed'
  workspaceId: string
  recipientId: string
  operation: BindingRecord
  dependencies: RemoteRecord[]
}
export type BindingNotificationResult = 'provisional' | 'already-synced' | 'awaiting-sync' | 'conflict' | 'rejected'
export interface BindingNotificationAcknowledgement {
  workspaceId: string
  operationId: string
  result: BindingNotificationResult
  reason?: string
}
export interface PendingBindingMarker { operationId: string; taskId: string }
export interface RemoteConfigSnapshot extends SessionLinksSnapshot {
  initialized: boolean
  records: RemoteRecord[]
  resolution: ResolvedRemoteConfig
  provisional: string[]
  awaitingSync: PendingBindingMarker[]
}
export interface RemoteRecordFile { path: string; content: string }
export interface RemoteSettingsSnapshot {
  revision: string | null
  values: RemoteSettings
  diagnostics: RemoteConfigDiagnostic[]
}
export interface RemoteConfigStoreStatus {
  workspaceId: string
  initialized: boolean
  revision: string | null
  pendingOperationIds: string[]
  provisionalTasks: string[]
  awaitingSync: PendingBindingMarker[]
  blocked: boolean
  conflicts: Array<{
    entityKey: string
    kind: RemoteRecordKind
    state: 'needs-resolution' | 'blocked'
    heads: RemoteRecord[]
  }>
  diagnostics: RemoteConfigDiagnostic[]
}
