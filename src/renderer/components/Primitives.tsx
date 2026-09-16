import { useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} />
}

export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>
}

export function Dialog({ title, onClose, children, className = '', closeDisabled = false }: { title: string; onClose(): void; children: ReactNode; className?: string; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  return (
    <dialog ref={ref} className={`dialog ${className}`} aria-label={title}
      onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose() }}>
      <div className="dialog-inner">
        <header className="dialog-header"><h2>{title}</h2><IconButton icon="close" label={`Close ${title}`} disabled={closeDisabled} onClick={onClose} /></header>
        {children}
      </div>
    </dialog>
  )
}