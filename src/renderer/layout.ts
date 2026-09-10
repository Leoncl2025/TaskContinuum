export interface LayoutPreferences {
  sidebar: boolean
  chat: boolean
  theme: 'dark' | 'light'
  sidebarWidth: number
  chatWidth: number
}

export type LayoutPanel = 'sidebar' | 'chat'
export const panelLimits = { sidebar: { min: 220, max: 600 }, chat: { min: 310, max: 960 } }
const key = 'taskcontinuum:layout:v1'
export const defaultLayout: LayoutPreferences = { sidebar: true, chat: true, theme: 'dark', sidebarWidth: 258, chatWidth: 355 }

function panelWidth(value: unknown, panel: LayoutPanel): number {
  const { min, max } = panelLimits[panel]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : defaultLayout[`${panel}Width`]
}

export function panelSizes(layout: LayoutPreferences, viewportWidth: number) {
  const available = Math.max(0, Math.floor(viewportWidth - 48 - 400))
  let sidebarWidth = panelWidth(layout.sidebarWidth, 'sidebar')
  let chatWidth = panelWidth(layout.chatWidth, 'chat')
  const minimum = (layout.sidebar ? panelLimits.sidebar.min : 0) + (layout.chat ? panelLimits.chat.min : 0)
  const sidebarExtra = layout.sidebar ? sidebarWidth - panelLimits.sidebar.min : 0
  const chatExtra = layout.chat ? chatWidth - panelLimits.chat.min : 0
  const totalExtra = sidebarExtra + chatExtra
  if (totalExtra > 0 && minimum + totalExtra > available) {
    const extra = Math.max(0, available - minimum)
    const sidebarShare = Math.floor(extra * sidebarExtra / totalExtra)
    if (layout.sidebar) sidebarWidth = panelLimits.sidebar.min + sidebarShare
    if (layout.chat) chatWidth = panelLimits.chat.min + extra - sidebarShare
  }
  return {
    sidebar: { width: sidebarWidth, min: panelLimits.sidebar.min, max: Math.max(panelLimits.sidebar.min, Math.min(panelLimits.sidebar.max, available - (layout.chat ? chatWidth : 0))) },
    chat: { width: chatWidth, min: panelLimits.chat.min, max: Math.max(panelLimits.chat.min, Math.min(panelLimits.chat.max, available - (layout.sidebar ? sidebarWidth : 0))) },
  }
}

export function resizePanel(layout: LayoutPreferences, panel: LayoutPanel, width: number, viewportWidth: number): LayoutPreferences {
  const sizes = panelSizes(layout, viewportWidth)
  return { ...layout, sidebarWidth: sizes.sidebar.width, chatWidth: sizes.chat.width,
    [`${panel}Width`]: Math.max(sizes[panel].min, Math.min(sizes[panel].max, panelWidth(width, panel))) }
}

export function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function viewportWidth(): number { return window.innerWidth }

export function readLayout(): LayoutPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return { ...defaultLayout }
    const saved = value as Record<string, unknown>
    return {
      sidebar: typeof saved.sidebar === 'boolean' ? saved.sidebar : true,
      chat: typeof saved.chat === 'boolean' ? saved.chat : true,
      theme: saved.theme === 'light' ? 'light' : 'dark',
      sidebarWidth: panelWidth(saved.sidebarWidth, 'sidebar'),
      chatWidth: panelWidth(saved.chatWidth, 'chat'),
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