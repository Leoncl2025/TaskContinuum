import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SessionWindowMode } from '../../shared/desktop'
import type { SessionBinding } from '../chat/sessionBindings'
import type { SplitDirection, SplitOrientation } from '../layout'
import { Icon } from './Primitives'

export interface SessionContextMenuTarget {
  readonly x: number
  readonly y: number
  readonly groupId: string
  readonly taskId: string
  readonly binding?: SessionBinding
  readonly getDraft?: () => string
  readonly clearDraft?: (snapshot: string) => void
  readonly beginRename?: () => void
  readonly detailsOpen?: boolean
  readonly toggleDetails?: () => void
  readonly unlink?: () => void
}

interface Props {
  readonly target: SessionContextMenuTarget
  readonly theme: 'dark' | 'light'
  readonly splitActive: boolean
  readonly splitOrientation: SplitOrientation
  readonly canSwap: boolean
  readonly allowOpenWindow?: boolean
  onRename?(): void
  onResetName?(): void
  onToggleDetails?(): void
  onUnlink?(): void
  onSplit?(direction: SplitDirection, moveSource: boolean): void
  onToggleOrientation?(): void
  onSwap?(): void
  onCloseSplit?(): void
  onOpenWindow?(mode: SessionWindowMode): void
  onClose(): void
}

const SUBMENU_DIRECTIONS: readonly { direction: SplitDirection; label: string }[] = [
  { direction: 'up', label: 'Split Up' },
  { direction: 'down', label: 'Split Down' },
  { direction: 'left', label: 'Split Left' },
  { direction: 'right', label: 'Split Right' },
]

export function SessionContextMenu({
  target,
  theme,
  splitActive,
  splitOrientation,
  canSwap,
  allowOpenWindow = true,
  onRename,
  onResetName,
  onToggleDetails,
  onUnlink,
  onSplit,
  onToggleOrientation,
  onSwap,
  onCloseSplit,
  onOpenWindow,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [submenuOpen, setSubmenuOpen] = useState(false)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const zoom = Number.parseFloat(getComputedStyle(document.body).zoom) || 1
    const viewportW = window.innerWidth / zoom
    const viewportH = window.innerHeight / zoom
    menu.style.maxHeight = `${Math.max(120, viewportH - 16)}px`
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const clampedX = Math.max(8, Math.min(viewportW - width - 8, target.x / zoom))
    const clampedY = Math.max(8, Math.min(viewportH - height - 8, target.y / zoom))
    menu.style.left = `${clampedX}px`
    menu.style.top = `${clampedY}px`
  }, [target.x, target.y, splitActive, canSwap])

  useLayoutEffect(() => {
    const menu = menuRef.current
    const sub = submenuRef.current
    const trigger = triggerRef.current
    if (!submenuOpen || !menu || !sub || !trigger) return
    const zoom = Number.parseFloat(getComputedStyle(document.body).zoom) || 1
    const viewportW = window.innerWidth / zoom
    const viewportH = window.innerHeight / zoom
    const menuRect = menu.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    const subWidth = sub.offsetWidth || 184
    const subHeight = sub.offsetHeight || 132
    const menuRight = menuRect.right / zoom
    const menuLeft = menuRect.left / zoom
    const flipLeft = menuRight + 3 + subWidth + 8 > viewportW && menuLeft - 3 - subWidth >= 8
    const left = flipLeft
      ? Math.max(8, menuLeft - subWidth - 3)
      : Math.min(viewportW - subWidth - 8, menuRight + 3)
    const top = Math.max(8, Math.min(viewportH - subHeight - 8, triggerRect.top / zoom - 4))
    sub.dataset.side = flipLeft ? 'left' : 'right'
    sub.style.left = `${left}px`
    sub.style.top = `${top}px`
  }, [submenuOpen])

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)')
    first?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || submenuRef.current?.contains(event.target))) return
      onClose()
    }
    const onWindowBlur = () => onClose()
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || submenuRef.current?.contains(event.target))) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('resize', onWindowBlur)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      clearTimeout(hoverTimer.current)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('resize', onWindowBlur)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  function scheduleSubmenu(open: boolean): void {
    clearTimeout(hoverTimer.current)
    if (open) setSubmenuOpen(true)
    else hoverTimer.current = setTimeout(() => setSubmenuOpen(false), 120)
  }

  function moveFocusInContainer(container: HTMLElement | null, step: number | 'first' | 'last'): void {
    if (!container) return
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"], :scope > .session-context-submenu-anchor > [role="menuitem"]'))
      .filter((item) => !item.disabled)
    if (!items.length) return
    if (step === 'first') { items[0].focus(); return }
    if (step === 'last') { items.at(-1)!.focus(); return }
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = currentIndex < 0 ? (step > 0 ? 0 : items.length - 1) : (currentIndex + step + items.length) % items.length
    items[nextIndex].focus()
  }

  function onRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const insideSubmenu = event.target instanceof Node && Boolean(submenuRef.current?.contains(event.target))
    if (insideSubmenu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocusInContainer(menuRef.current, 1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveFocusInContainer(menuRef.current, -1); return }
    if (event.key === 'Home') { event.preventDefault(); moveFocusInContainer(menuRef.current, 'first'); return }
    if (event.key === 'End') { event.preventDefault(); moveFocusInContainer(menuRef.current, 'last'); return }
    if (event.key === 'ArrowRight' && document.activeElement === triggerRef.current) {
      event.preventDefault()
      setSubmenuOpen(true)
      requestAnimationFrame(() => moveFocusInContainer(submenuRef.current, 'first'))
    }
  }

  function onSubmenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      setSubmenuOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); moveFocusInContainer(submenuRef.current, 1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); moveFocusInContainer(submenuRef.current, -1); return }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); moveFocusInContainer(submenuRef.current, 'first'); return }
    if (event.key === 'End') { event.preventDefault(); event.stopPropagation(); moveFocusInContainer(submenuRef.current, 'last') }
  }

  function run(action: () => void): void {
    onClose()
    action()
  }

  return createPortal(
    <div className="repository-dialog-theme session-context-portal" data-theme={theme}>
      <div
        ref={menuRef}
        className="session-context-menu"
        role="menu"
        aria-label="Session view actions"
        style={{ left: `${target.x}px`, top: `${target.y}px` }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={onRootKeyDown}
      >
        {(onRename || onResetName || onToggleDetails) && <>
          {onRename && (
            <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onRename)}>
              <span>Rename Session...</span>
              <span className="session-context-shortcut">F2</span>
            </button>
          )}
          {onResetName && (
            <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onResetName)}>
              <span>Reset Session Name</span>
            </button>
          )}
          {onToggleDetails && (
            <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onToggleDetails)}>
              <span>{target.detailsOpen ? 'Hide Session Details' : 'Session Details'}</span>
            </button>
          )}
          {(onSplit || (allowOpenWindow && onOpenWindow) || onUnlink) && <div className="session-context-separator" role="separator" />}
        </>}
        {onSplit && <>
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onSplit('right', false))}>
            <span>Split Right</span>
            <span className="session-context-shortcut">Ctrl+\</span>
          </button>
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onSplit('down', false))}>
            <span>Split Down</span>
            <span className="session-context-shortcut">Ctrl+K Ctrl+\</span>
          </button>
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onSplit('up', false))}>
            <span>Split Up</span>
          </button>
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onSplit('left', false))}>
            <span>Split Left</span>
          </button>

          <div className="session-context-submenu-anchor" onMouseEnter={() => scheduleSubmenu(true)} onMouseLeave={() => scheduleSubmenu(false)}>
            <button
              ref={triggerRef}
              type="button"
              role="menuitem"
              className="session-context-item"
              aria-haspopup="menu"
              aria-expanded={submenuOpen}
              onClick={() => {
                const next = !submenuOpen
                setSubmenuOpen(next)
                if (next) requestAnimationFrame(() => moveFocusInContainer(submenuRef.current, 'first'))
              }}
            >
              <span>Split &amp; Move</span>
              <Icon name="chevron-right" className="session-context-chevron" />
            </button>
          </div>
        </>}

        {splitActive && onToggleOrientation && onCloseSplit && <>
          <div className="session-context-separator" role="separator" />
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onToggleOrientation)}>
            <span>{splitOrientation === 'vertical' ? 'Switch to Left/Right Split' : 'Switch to Top/Bottom Split'}</span>
          </button>
          {canSwap && onSwap && (
            <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onSwap)}>
              <span>Swap Split Panes</span>
            </button>
          )}
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onCloseSplit)}>
            <span>Close Split Pane</span>
            <span className="session-context-shortcut">Ctrl+Shift+\</span>
          </button>
        </>}

        {allowOpenWindow && onOpenWindow && <>
          <div className="session-context-separator" role="separator" />
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onOpenWindow('move'))}>
            <span>Move into New Window</span>
          </button>
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(() => onOpenWindow('copy'))}>
            <span>Copy into New Window</span>
            <span className="session-context-shortcut">Ctrl+K O</span>
          </button>
        </>}

        {onUnlink && <>
          {(onSplit || (allowOpenWindow && onOpenWindow)) && <div className="session-context-separator" role="separator" />}
          <button type="button" role="menuitem" className="session-context-item" onMouseEnter={() => scheduleSubmenu(false)} onClick={() => run(onUnlink)}>
            <span>Unlink Session</span>
          </button>
        </>}
      </div>

      {submenuOpen && onSplit && (
        <div
          ref={submenuRef}
          className="session-context-menu session-context-submenu"
          data-side="right"
          role="menu"
          aria-label="Split and Move"
          onContextMenu={(event) => event.preventDefault()}
          onMouseEnter={() => scheduleSubmenu(true)}
          onMouseLeave={() => scheduleSubmenu(false)}
          onKeyDown={onSubmenuKeyDown}
        >
          {SUBMENU_DIRECTIONS.map((item) => (
            <button key={item.direction} type="button" role="menuitem" className="session-context-item" onClick={() => run(() => onSplit(item.direction, true))}>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
