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
  }).strict()).max(limit),
}).strict()
type Entry = z.infer<typeof cacheSchema>['entries'][number]
type Cache = { workspaceId?: string; entries: Entry[]; titles: Record<string, string>; error?: string }
export type SessionTitleUpdate = Pick<AgentHostSession, 'sessionId' | 'chatId' | 'owner' | 'title' | 'updatedAt'>

export function sessionTitle(target: Pick<AgentHostTarget, 'sessionId' | 'chatId'>, value: string | undefined): string | undefined {
  const title = value?.trim()
  return title && title.length <= 2000 && title !== target.sessionId && title !== target.chatId
    && !['Agent Host', 'Original Host chat', 'Untitled chat', 'New Copilot chat'].includes(title) ? title : undefined
}

function storageKey(workspaceId: string): string { return `taskcontinuum:session-titles:v1:${workspaceId}` }

function read(workspaceId: string | undefined): Cache {
  const empty: Cache = { workspaceId, entries: [], titles: {} }
  if (!workspaceId) return empty
  let stored: string | null
  try { stored = localStorage.getItem(storageKey(workspaceId)) }
  catch { return { ...empty, error: 'Saved chat titles could not be read on this device. Live titles and session access are unaffected.' } }
  if (stored === null) return empty
  try {
    if (stored.length > 2 * 1024 * 1024) throw new Error('Oversized title cache.')
    const { entries } = cacheSchema.parse(JSON.parse(stored))
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) throw new Error('Duplicate title cache entry.')
    return { workspaceId, entries, titles: Object.fromEntries(entries.map((entry) => [entry.key, entry.title])) }
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
    for (const update of updates) {
      const title = sessionTitle(update, update.title)
      const key = agentHostKey(update)
      if (!title || key.length > 2048) continue
      const previous = entries.find((entry) => entry.key === key)
      const date = Date.parse(update.updatedAt)
      const modifiedAt = Number.isFinite(date) && date >= 0 ? date : undefined
      if (previous?.title === title || previous?.modifiedAt !== undefined && modifiedAt !== undefined && modifiedAt < previous.modifiedAt) continue
      entries = [...entries.filter((entry) => entry.key !== key), { key, title, ...(modifiedAt !== undefined ? { modifiedAt } : {}) }].slice(-limit)
    }
    if (entries === before.entries) return
    let error: string | undefined
    if (workspaceId) {
      try { localStorage.setItem(storageKey(workspaceId), JSON.stringify({ version: 1, entries })) }
      catch { error = 'Chat titles could not be saved on this device. They will be remembered only until this workspace closes.' }
    }
    const next: Cache = { workspaceId, entries, titles: Object.fromEntries(entries.map((entry) => [entry.key, entry.title])), error }
    current.current = next
    setCache(next)
  }, [workspaceId])

  return { titles: cache.workspaceId === workspaceId ? cache.titles : {}, error: cache.workspaceId === workspaceId ? cache.error : undefined, remember }
}
