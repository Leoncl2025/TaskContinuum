export interface LayoutPreferences {
  sidebar: boolean
  chat: boolean
  details: boolean
  theme: 'dark' | 'light'
  sidebarWidth: number
  detailsWidth: number
}

export type LayoutPanel = 'sidebar' | 'details'
export const panelLimits = { sidebar: { min: 220, max: 600 }, details: { min: 320, max: 960 } }
const key = 'taskcontinuum:layout:v2'
const legacyKey = 'taskcontinuum:layout:v1'
export const defaultLayout: LayoutPreferences = { sidebar: true, chat: true, details: true, theme: 'dark', sidebarWidth: 258, detailsWidth: 380 }

function panelWidth(value: unknown, panel: LayoutPanel): number {
  const { min, max } = panelLimits[panel]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : defaultLayout[`${panel}Width`]
}

export function panelSizes(layout: LayoutPreferences, viewportWidth: number) {
  const available = Math.max(0, Math.floor(viewportWidth - 48 - 400))
  const detailsDocked = layout.details && layout.chat
  let sidebarWidth = panelWidth(layout.sidebarWidth, 'sidebar')
  let detailsWidth = panelWidth(layout.detailsWidth, 'details')
  const minimum = (layout.sidebar ? panelLimits.sidebar.min : 0) + (detailsDocked ? panelLimits.details.min : 0)
  const sidebarExtra = layout.sidebar ? sidebarWidth - panelLimits.sidebar.min : 0
  const detailsExtra = detailsDocked ? detailsWidth - panelLimits.details.min : 0
  const totalExtra = sidebarExtra + detailsExtra
  if (totalExtra > 0 && minimum + totalExtra > available) {
    const extra = Math.max(0, available - minimum)
    const sidebarShare = Math.floor(extra * sidebarExtra / totalExtra)
    if (layout.sidebar) sidebarWidth = panelLimits.sidebar.min + sidebarShare
    if (detailsDocked) detailsWidth = panelLimits.details.min + extra - sidebarShare
  }
  return {
    sidebar: { width: sidebarWidth, min: panelLimits.sidebar.min, max: Math.max(panelLimits.sidebar.min, Math.min(panelLimits.sidebar.max, available - (detailsDocked ? detailsWidth : 0))) },
    details: { width: detailsWidth, min: panelLimits.details.min, max: Math.max(panelLimits.details.min, Math.min(panelLimits.details.max, available - (layout.sidebar ? sidebarWidth : 0))) },
  }
}

export function resizePanel(layout: LayoutPreferences, panel: LayoutPanel, width: number, viewportWidth: number): LayoutPreferences {
  const sizes = panelSizes(layout, viewportWidth)
  return { ...layout, sidebarWidth: sizes.sidebar.width, detailsWidth: sizes.details.width,
    [`${panel}Width`]: Math.max(sizes[panel].min, Math.min(sizes[panel].max, panelWidth(width, panel))) }
}

export function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function viewportWidth(): number { return window.innerWidth }

export function readLayout(): LayoutPreferences {
  try {
    const stored = localStorage.getItem(key)
    const value: unknown = JSON.parse(stored ?? localStorage.getItem(legacyKey) ?? 'null')
    if (!value || typeof value !== 'object') return { ...defaultLayout }
    const saved = value as Record<string, unknown>
    const details = typeof saved.details === 'boolean' ? saved.details : true
    return {
      sidebar: typeof saved.sidebar === 'boolean' ? saved.sidebar : true,
      chat: !details || typeof saved.chat !== 'boolean' || saved.chat,
      details,
      theme: saved.theme === 'light' ? 'light' : 'dark',
      sidebarWidth: panelWidth(saved.sidebarWidth, 'sidebar'),
      detailsWidth: panelWidth(stored === null ? saved.chatWidth : saved.detailsWidth, 'details'),
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