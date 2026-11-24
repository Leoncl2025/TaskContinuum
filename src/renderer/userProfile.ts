import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { DesktopUserProfile } from '../shared/desktop'

export const USER_DISPLAY_NAME_MAX_LENGTH = 80
const STORAGE_KEY = 'taskcontinuum:user-display-name'

export interface UserProfileValue {
  readonly clientId?: string
  readonly loginUsername?: string
  readonly displayName?: string
  readonly customDisplayName: string
  readonly effectiveDisplayName?: string
  readonly setCustomDisplayName: (next: string) => void
}

const defaultProfileValue: UserProfileValue = Object.freeze({
  customDisplayName: '',
  setCustomDisplayName: () => {},
})

export const UserProfileContext = createContext<UserProfileValue>(defaultProfileValue)

export function readSavedUserDisplayName(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ''
    return raw.trim().slice(0, USER_DISPLAY_NAME_MAX_LENGTH)
  } catch {
    return ''
  }
}

export function saveUserDisplayName(value: string): string {
  const trimmed = value.trim().slice(0, USER_DISPLAY_NAME_MAX_LENGTH)
  try {
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage quota / privacy failures and keep in-memory state.
  }
  return trimmed
}

export function useUserProfileState(desktopProfile?: DesktopUserProfile): UserProfileValue {
  const [customDisplayName, setCustomState] = useState(readSavedUserDisplayName)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return
      setCustomState(readSavedUserDisplayName())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setCustomDisplayName = useCallback((next: string) => {
    const saved = saveUserDisplayName(next)
    setCustomState(saved)
  }, [])

  const effectiveDisplayName = customDisplayName || desktopProfile?.displayName || desktopProfile?.loginUsername

  return useMemo(() => ({
    clientId: desktopProfile?.clientId,
    loginUsername: desktopProfile?.loginUsername,
    displayName: desktopProfile?.displayName,
    customDisplayName,
    effectiveDisplayName,
    setCustomDisplayName,
  }), [desktopProfile?.clientId, desktopProfile?.loginUsername, desktopProfile?.displayName, customDisplayName, effectiveDisplayName, setCustomDisplayName])
}

export function useUserProfile(): UserProfileValue {
  return useContext(UserProfileContext)
}

export interface TurnActorMetadata {
  readonly clientId?: string
  readonly username?: string
  readonly displayName?: string
  readonly machineName?: string
}

export function resolveTurnActorName(actor: TurnActorMetadata | undefined, profile: UserProfileValue): {
  readonly name: string
  readonly rawUsername?: string
  readonly initial?: string
} {
  const rawUsername = typeof actor?.username === 'string' && actor.username.trim() ? actor.username.trim() : undefined
  const actorDisplay = typeof actor?.displayName === 'string' && actor.displayName.trim() ? actor.displayName.trim() : undefined
  const matchesLocalById = Boolean(actor?.clientId && profile.clientId && actor.clientId === profile.clientId)
  const matchesLocalByLogin = Boolean(
    rawUsername && profile.loginUsername && rawUsername.toLowerCase() === profile.loginUsername.toLowerCase(),
  )

  let name: string
  if (matchesLocalById || matchesLocalByLogin) {
    name = profile.customDisplayName || actorDisplay || profile.displayName || rawUsername || 'User'
  } else {
    name = actorDisplay || rawUsername || 'User'
  }

  const trimmed = name.trim() || 'User'
  const firstChar = Array.from(trimmed)[0]
  const initial = trimmed !== 'User' && firstChar ? firstChar.toUpperCase() : undefined
  return {
    name: trimmed,
    ...(rawUsername && rawUsername !== trimmed ? { rawUsername } : {}),
    ...(initial ? { initial } : {}),
  }
}
