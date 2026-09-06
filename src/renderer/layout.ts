export interface LayoutPreferences {
  sidebar: boolean
  chat: boolean
  theme: 'dark' | 'light'
}

const key = 'taskcontinuum:layout:v1'
export const defaultLayout: LayoutPreferences = { sidebar: true, chat: true, theme: 'dark' }

export function readLayout(): LayoutPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return { ...defaultLayout }
    const saved = value as Record<string, unknown>
    return {
      sidebar: typeof saved.sidebar === 'boolean' ? saved.sidebar : true,
      chat: typeof saved.chat === 'boolean' ? saved.chat : true,
      theme: saved.theme === 'light' ? 'light' : 'dark',
    }
  } catch {
    return { ...defaultLayout }
  }
}

export function saveLayout(value: LayoutPreferences): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Preferences are optional in restricted environments. */ }
}

export function subscribeCompact(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia('(max-width: 1000px)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function isCompact(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1000px)').matches
}