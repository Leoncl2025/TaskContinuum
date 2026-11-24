export interface RestoredDraftEntry {
  readonly nonce: number
  readonly text: string
}

export function nextRestoredDraftNonce(
  entries: Readonly<Record<string, RestoredDraftEntry>>,
): number {
  let max = 0
  for (const value of Object.values(entries)) {
    if (value.nonce > max) max = value.nonce
  }
  return max + 1
}

export interface SessionDraftStore {
  record(groupId: string, taskId: string, sessionKey: string, draft: string): void
  readInitial(panelKey: string, localKey: string): string | undefined
  readForMove(groupId: string, taskId: string, sessionKey: string | undefined): string | undefined
  findLiveDraftForSession(taskId: string, sessionKey: string): string | undefined
  clearMovedPanel(groupId: string, taskId: string, sessionKey: string): { clearedSessionDraft: boolean }
  removeGroup(groupId: string): Array<{ localKey: string; draft: string }>
  forgetSession(taskId: string, sessionKey: string): void
}

export function createSessionDraftStore(initial?: {
  readonly groupId: string
  readonly taskId: string
  readonly sessionKey: string
  readonly draft: string
}): SessionDraftStore {
  const panelDrafts = new Map<string, string>()
  const sessionDrafts = new Map<string, string>()

  if (initial && initial.draft) {
    panelDrafts.set(`${initial.groupId}:${initial.taskId}:${initial.sessionKey}`, initial.draft)
    sessionDrafts.set(`${initial.taskId}:${initial.sessionKey}`, initial.draft)
  }

  return {
    record(groupId, taskId, sessionKey, draft) {
      const localKey = `${taskId}:${sessionKey}`
      const panelKey = `${groupId}:${localKey}`
      panelDrafts.set(panelKey, draft)
      if (draft.trim().length > 0) {
        sessionDrafts.set(localKey, draft)
      } else {
        let otherNonEmpty: string | undefined
        const suffix = `:${localKey}`
        for (const [key, value] of panelDrafts) {
          if (key !== panelKey && key.endsWith(suffix) && value.trim().length > 0) {
            otherNonEmpty = value
            break
          }
        }
        if (otherNonEmpty !== undefined) sessionDrafts.set(localKey, otherNonEmpty)
        else sessionDrafts.delete(localKey)
      }
    },

    readInitial(panelKey, localKey) {
      const exact = panelDrafts.get(panelKey)
      if (exact !== undefined && exact.length > 0) return exact
      return sessionDrafts.get(localKey)
    },

    readForMove(groupId, taskId, sessionKey) {
      if (!sessionKey) return undefined
      const localKey = `${taskId}:${sessionKey}`
      const panelKey = `${groupId}:${localKey}`
      const exact = panelDrafts.get(panelKey)
      if (exact !== undefined) return exact
      return sessionDrafts.get(localKey)
    },

    findLiveDraftForSession(taskId, sessionKey) {
      const localKey = `${taskId}:${sessionKey}`
      const suffix = `:${localKey}`
      for (const [key, value] of panelDrafts) {
        if (key.endsWith(suffix) && value.trim().length > 0) return value
      }
      const fallback = sessionDrafts.get(localKey)
      return fallback && fallback.trim().length > 0 ? fallback : undefined
    },

    clearMovedPanel(groupId, taskId, sessionKey) {
      const localKey = `${taskId}:${sessionKey}`
      const panelKey = `${groupId}:${localKey}`
      panelDrafts.delete(panelKey)
      const suffix = `:${localKey}`
      for (const [key, value] of panelDrafts) {
        if (key.endsWith(suffix) && value.trim().length > 0) {
          sessionDrafts.set(localKey, value)
          return { clearedSessionDraft: false }
        }
      }
      sessionDrafts.delete(localKey)
      return { clearedSessionDraft: true }
    },

    removeGroup(groupId) {
      const prefix = `${groupId}:`
      const orphans: Array<{ localKey: string; draft: string }> = []
      const removedEntries: Array<[string, string]> = []
      for (const [key, value] of panelDrafts) {
        if (key.startsWith(prefix)) {
          removedEntries.push([key, value])
          panelDrafts.delete(key)
        }
      }
      for (const [key, value] of removedEntries) {
        if (!value.trim()) continue
        const localKey = key.slice(prefix.length)
        const suffix = `:${localKey}`
        let survivingHasDraft = false
        for (const [otherKey, otherValue] of panelDrafts) {
          if (otherKey.endsWith(suffix) && otherValue.trim().length > 0) {
            survivingHasDraft = true
            break
          }
        }
        if (!survivingHasDraft) {
          sessionDrafts.set(localKey, value)
          orphans.push({ localKey, draft: value })
        }
      }
      return orphans
    },

    forgetSession(taskId, sessionKey) {
      const localKey = `${taskId}:${sessionKey}`
      const suffix = `:${localKey}`
      sessionDrafts.delete(localKey)
      for (const key of [...panelDrafts.keys()]) {
        if (key.endsWith(suffix)) panelDrafts.delete(key)
      }
    },
  }
}
