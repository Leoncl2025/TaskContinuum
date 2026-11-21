import { useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, KeyboardEventHandler, ReactNode } from 'react'

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} />
}

export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>
}

export function Dialog({
  title,
  onClose,
  children,
  className = '',
  closeDisabled = false,
  headerActions,
  onEscape,
  onKeyDown,
}: {
  title: string
  onClose(): void
  children: ReactNode
  className?: string
  closeDisabled?: boolean
  headerActions?: ReactNode
  onEscape?: () => boolean
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <dialog ref={ref} className={`dialog ${className}`} aria-label={title}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        if (closeDisabled || onEscape?.()) return
        onClose()
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose() }}>
      <div className="dialog-inner">
        <header className="dialog-header">
          <h2>{title}</h2>
          <div className="dialog-header-actions">
            {headerActions}
            <IconButton icon="close" label={`Close ${title}`} disabled={closeDisabled} onClick={onClose} />
          </div>
        </header>
        {children}
      </div>
    </dialog>
  )
}