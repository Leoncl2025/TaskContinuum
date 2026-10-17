export const PRIVATE_DEVICE_LIFETIME_MS = 30 * 86400000
export const PRIVATE_DEVICE_RENEWAL_MS = 3600000
export const PEER_REQUEST_LIFETIME_MS = 60000

export const DEVICE_TRUST_LIMITS = {
  devices: 32,
  workspaces: 10,
} as const
