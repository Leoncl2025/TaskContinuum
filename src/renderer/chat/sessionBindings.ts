export interface SessionBinding { id: string; title: string }
export type SessionBindings = Record<string, SessionBinding>
const key = 'taskcontinuum:session-bindings:v1'

function storageKey(workspaceId?: string): string {
  return workspaceId ? `${key}:${encodeURIComponent(workspaceId)}` : key
}

export function readSessionBindings(workspaceId?: string): SessionBindings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([taskId, binding]: [string, unknown]) => {
      if (taskId.length > 100 || !binding || typeof binding !== 'object') return false
      const entry = binding as Partial<SessionBinding>
      return typeof entry.id === 'string' && entry.id.length <= 240 && typeof entry.title === 'string' && entry.title.length <= 500
    }).slice(0, 100)) as SessionBindings
  } catch { return {} }
}

export function saveSessionBindings(bindings: SessionBindings, workspaceId?: string): void {
  try { localStorage.setItem(storageKey(workspaceId), JSON.stringify(bindings)) } catch { return }
}

export function clearSessionBindings(workspaceId: string): void {
  try { localStorage.removeItem(storageKey(workspaceId)) } catch { return }
}