import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostSession, AgentHostTarget } from '../../shared/agentHost'

const limit = 256
const cacheSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    key: z.string().min(1).max(2048),
    title: z.string().min(1).max(2000),
    modifiedAt: z.number().finite().nonnegative().optional(),
    createdAt: z.number().finite().nonnegative().optional(),
  }).strict()).max(limit),
}).strict()
type Entry = z.infer<typeof cacheSchema>['entries'][number]
export interface SessionTimestamps {
  updatedAt?: number
  createdAt?: number
}
type Cache = {
  workspaceId?: string
  entries: Entry[]
  titles: Record<string, string>
  timestamps: Record<string, SessionTimestamps>
  error?: string
}
export type SessionTitleUpdate = Pick<AgentHostSession, 'sessionId' | 'chatId' | 'owner' | 'title' | 'updatedAt'> & { createdAt?: string }
const emptyTimestamps: Readonly<Record<string, SessionTimestamps>> = Object.freeze({})

export function sessionTitle(target: Pick<AgentHostTarget, 'sessionId' | 'chatId'>, value: string | undefined): string | undefined {
  const title = value?.trim()
  return title && title.length <= 2000 && title !== target.sessionId && title !== target.chatId
    && !['Agent Host', 'Original Host chat', 'Untitled chat', 'New Copilot chat'].includes(title) ? title : undefined
}

function storageKey(workspaceId: string): string { return `taskcontinuum:session-titles:v1:${workspaceId}` }

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
  const empty: Cache = { workspaceId, entries: [], titles: {}, timestamps: {} }
  if (!workspaceId) return empty
  let stored: string | null
  try { stored = localStorage.getItem(storageKey(workspaceId)) }
  catch { return { ...empty, error: 'Saved chat titles could not be read on this device. Live titles and session access are unaffected.' } }
  if (stored === null) return empty
  try {
    if (stored.length > 2 * 1024 * 1024) throw new Error('Oversized title cache.')
    const { entries } = cacheSchema.parse(JSON.parse(stored))
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error('Duplicate title cache entry.')
    return {
      workspaceId,
      entries,
      titles: Object.fromEntries(entries.map((entry) => [entry.key, entry.title])),
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
      entries = [...entries.filter((entry) => entry.key !== key), {
        key,
        title,
        ...(savedModified !== undefined ? { modifiedAt: savedModified } : {}),
        ...(savedCreated !== undefined ? { createdAt: savedCreated } : {}),
      }].slice(-limit)
    }
    if (entries === before.entries && timestamps === before.timestamps) return
    let error = before.error
    if (entries !== before.entries && workspaceId) {
      error = undefined
      try { localStorage.setItem(storageKey(workspaceId), JSON.stringify({ version: 1, entries })) }
      catch { error = 'Chat titles could not be saved on this device. They will be remembered only until this workspace closes.' }
    }
    const next: Cache = {
      workspaceId,
      entries,
      titles: entries === before.entries ? before.titles : Object.fromEntries(entries.map((entry) => [entry.key, entry.title])),
      timestamps,
      error,
    }
    current.current = next
    setCache(next)
  }, [workspaceId])

  const active = cache.workspaceId === workspaceId
  return {
    titles: active ? cache.titles : {},
    timestamps: active ? cache.timestamps : emptyTimestamps,
    error: active ? cache.error : undefined,
    remember,
  }
}
