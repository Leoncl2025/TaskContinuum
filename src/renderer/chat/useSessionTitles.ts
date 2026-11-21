import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { agentHostKey, MAX_SESSION_TITLE_LENGTH } from '../../shared/agentHost'
import type { AgentHostSession, AgentHostTarget } from '../../shared/agentHost'

const limit = 256
const entrySchema = z.object({
  key: z.string().min(1).max(2048),
  title: z.string().min(1).max(2000).optional(),
  customTitle: z.string().trim().min(1).max(MAX_SESSION_TITLE_LENGTH).optional(),
  modifiedAt: z.number().finite().nonnegative().optional(),
  createdAt: z.number().finite().nonnegative().optional(),
}).strict().refine((entry) => Boolean(entry.title || entry.customTitle), 'Entry must contain a title.')

const cacheSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema).max(limit),
}).strict()

type Entry = z.infer<typeof entrySchema>
export interface SessionTimestamps {
  updatedAt?: number
  createdAt?: number
}
type Cache = {
  workspaceId?: string
  entries: Entry[]
  titles: Record<string, string>
  customTitles: Record<string, string>
  timestamps: Record<string, SessionTimestamps>
  error?: string
}
export type SessionTitleUpdate = Pick<AgentHostSession, 'sessionId' | 'chatId' | 'owner' | 'title' | 'updatedAt'> & { createdAt?: string }
const emptyTimestamps: Readonly<Record<string, SessionTimestamps>> = Object.freeze({})
const emptyCustomTitles: Readonly<Record<string, string>> = Object.freeze({})

export function sessionTitle(target: Pick<AgentHostTarget, 'sessionId' | 'chatId'>, value: string | undefined): string | undefined {
  const title = value?.trim()
  return title && title.length <= 2000 && title !== target.sessionId && title !== target.chatId
    && !['Agent Host', 'Original Host chat', 'Untitled chat', 'New Copilot chat'].includes(title) ? title : undefined
}

function storageKey(workspaceId: string): string { return `taskcontinuum:session-titles:v1:${workspaceId}` }

function entriesTitles(entries: readonly Entry[]): { titles: Record<string, string>; customTitles: Record<string, string> } {
  const titles: Record<string, string> = {}
  const customTitles: Record<string, string> = {}
  for (const entry of entries) {
    const resolved = entry.customTitle ?? entry.title
    if (resolved) titles[entry.key] = resolved
    if (entry.customTitle) customTitles[entry.key] = entry.customTitle
  }
  return { titles, customTitles }
}

function boundedEntries(entries: readonly Entry[]): Entry[] {
  if (entries.length <= limit) return [...entries]
  const pinned = entries.filter((entry) => Boolean(entry.customTitle)).slice(-limit)
  if (pinned.length >= limit) return pinned
  const pinnedKeys = new Set(pinned.map((entry) => entry.key))
  const remaining = entries.filter((entry) => !pinnedKeys.has(entry.key)).slice(-(limit - pinned.length))
  const keep = new Set([...pinned.map((entry) => entry.key), ...remaining.map((entry) => entry.key)])
  return entries.filter((entry) => keep.has(entry.key))
}

function entriesTimestamps(entries: readonly Entry[]): Record<string, SessionTimestamps> {
  const result: Record<string, SessionTimestamps> = {}
  for (const entry of entries) {
    if (entry.modifiedAt !== undefined || entry.createdAt !== undefined) {
      result[entry.key] = {
        ...(entry.modifiedAt !== undefined ? { updatedAt: entry.modifiedAt } : {}),
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
      }
    }
  }
  return result
}

function read(workspaceId: string | undefined): Cache {
  const empty: Cache = { workspaceId, entries: [], titles: {}, customTitles: {}, timestamps: {} }
  if (!workspaceId) return empty
  let stored: string | null
  try { stored = localStorage.getItem(storageKey(workspaceId)) }
  catch { return { ...empty, error: 'Saved chat titles could not be read on this device. Live titles and session access are unaffected.' } }
  if (stored === null) return empty
  try {
    if (stored.length > 2 * 1024 * 1024) throw new Error('Oversized title cache.')
    const { entries } = cacheSchema.parse(JSON.parse(stored))
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error('Duplicate title cache entry.')
    const derived = entriesTitles(entries)
    return {
      workspaceId,
      entries,
      titles: derived.titles,
      customTitles: derived.customTitles,
      timestamps: entriesTimestamps(entries),
    }
  } catch { return { ...empty, error: 'Saved chat titles are invalid. Titles will be refreshed from the Host; session access is unaffected.' } }
}

export function useSessionTitles(workspaceId: string | undefined) {
  const [cache, setCache] = useState(() => read(workspaceId))
  const current = useRef(cache)
  useEffect(() => {
    if (current.current.workspaceId === workspaceId) return
    const next = read(workspaceId)
    current.current = next
    setCache(next)
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    const key = storageKey(workspaceId)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return
      const next = read(workspaceId)
      current.current = next
      setCache(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [workspaceId])

  const remember = useCallback((updates: readonly SessionTitleUpdate[]) => {
    const before = current.current.workspaceId === workspaceId ? current.current : read(workspaceId)
    let entries = before.entries
    let timestamps = before.timestamps
    for (const update of updates) {
      const key = agentHostKey(update)
      if (!key || key.length > 2048) continue
      const parsedModified = Date.parse(update.updatedAt)
      const modifiedAt = Number.isFinite(parsedModified) && parsedModified >= 0 ? parsedModified : undefined
      const parsedCreated = update.createdAt ? Date.parse(update.createdAt) : Number.NaN
      const createdAt = Number.isFinite(parsedCreated) && parsedCreated >= 0 ? parsedCreated : undefined

      const priorTime = timestamps[key]
      const nextUpdated = modifiedAt !== undefined && (priorTime?.updatedAt === undefined || modifiedAt > priorTime.updatedAt)
        ? modifiedAt : priorTime?.updatedAt
      const nextCreated = createdAt !== undefined && (priorTime?.createdAt === undefined || createdAt < priorTime.createdAt)
        ? createdAt : priorTime?.createdAt
      if (nextUpdated !== priorTime?.updatedAt || nextCreated !== priorTime?.createdAt) {
        timestamps = {
          ...timestamps,
          [key]: {
            ...(nextUpdated !== undefined ? { updatedAt: nextUpdated } : {}),
            ...(nextCreated !== undefined ? { createdAt: nextCreated } : {}),
          },
        }
      }

      const title = sessionTitle(update, update.title)
      if (!title) continue
      const previous = entries.find((entry) => entry.key === key)
      if (previous?.modifiedAt !== undefined && modifiedAt !== undefined && modifiedAt < previous.modifiedAt) continue
      const savedCreated = previous?.createdAt ?? createdAt
      if (previous?.title === title && previous.createdAt === savedCreated) continue
      const savedModified = modifiedAt ?? previous?.modifiedAt
      entries = boundedEntries([...entries.filter((entry) => entry.key !== key), {
        key,
        title,
        ...(previous?.customTitle ? { customTitle: previous.customTitle } : {}),
        ...(savedModified !== undefined ? { modifiedAt: savedModified } : {}),
        ...(savedCreated !== undefined ? { createdAt: savedCreated } : {}),
      }])
    }
    if (entries === before.entries && timestamps === before.timestamps) return
    let error = before.error
    if (entries !== before.entries && workspaceId) {
      error = undefined
      try { localStorage.setItem(storageKey(workspaceId), JSON.stringify({ version: 1, entries })) }
      catch { error = 'Chat titles could not be saved on this device. They will be remembered only until this workspace closes.' }
    }
    const derived = entries === before.entries
      ? { titles: before.titles, customTitles: before.customTitles }
      : entriesTitles(entries)
    const next: Cache = {
      workspaceId,
      entries,
      titles: derived.titles,
      customTitles: derived.customTitles,
      timestamps,
      error,
    }
    current.current = next
    setCache(next)
  }, [workspaceId])

  const rename = useCallback((target: AgentHostTarget, nextName: string | null) => {
    const key = agentHostKey(target)
    if (!key || key.length > 2048) return
    const trimmed = nextName?.trim().slice(0, MAX_SESSION_TITLE_LENGTH) || undefined
    const before = current.current.workspaceId === workspaceId ? current.current : read(workspaceId)
    const previous = before.entries.find((entry) => entry.key === key)
    if ((previous?.customTitle ?? undefined) === trimmed) return

    let entries: Entry[]
    if (trimmed) {
      entries = boundedEntries([...before.entries.filter((entry) => entry.key !== key), {
        key,
        ...(previous?.title ? { title: previous.title } : {}),
        customTitle: trimmed,
        ...(previous?.modifiedAt !== undefined ? { modifiedAt: previous.modifiedAt } : {}),
        ...(previous?.createdAt !== undefined ? { createdAt: previous.createdAt } : {}),
      }])
    } else if (!previous) {
      return
    } else if (previous.title) {
      entries = before.entries.map((entry) => {
        if (entry.key !== key) return entry
        const { customTitle: _removed, ...rest } = entry
        void _removed
        return rest
      })
    } else {
      entries = before.entries.filter((entry) => entry.key !== key)
    }

    let error: string | undefined
    if (workspaceId) {
      try { localStorage.setItem(storageKey(workspaceId), JSON.stringify({ version: 1, entries })) }
      catch { error = 'Chat titles could not be saved on this device. They will be remembered only until this workspace closes.' }
    }
    const derived = entriesTitles(entries)
    const next: Cache = {
      workspaceId,
      entries,
      titles: derived.titles,
      customTitles: derived.customTitles,
      timestamps: before.timestamps,
      error,
    }
    current.current = next
    setCache(next)

    const nativeTitle = trimmed ?? previous?.title
    if (nativeTitle) {
      void window.agentHost?.rename?.(target, nativeTitle).catch(() => undefined)
    }
  }, [workspaceId])

  const active = cache.workspaceId === workspaceId
  return {
    titles: active ? cache.titles : {},
    customTitles: active ? cache.customTitles : emptyCustomTitles,
    timestamps: active ? cache.timestamps : emptyTimestamps,
    error: active ? cache.error : undefined,
    remember,
    rename,
  }
}
