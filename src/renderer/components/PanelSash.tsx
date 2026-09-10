import { useEffect, useRef, useState } from 'react'
import type { LayoutPanel } from '../layout'

export function PanelSash({ panel, width, min, max, onResize, onReset }: {
  panel: LayoutPanel
  width: number
  min: number
  max: number
  onResize(width: number): void
  onReset(): void
}) {
  const element = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startX: number; width: number } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const direction = panel === 'sidebar' ? 1 : -1
  const label = panel === 'sidebar' ? 'Resize Explorer' : 'Resize Chat'
  const clamp = (value: number) => Math.max(min, Math.min(max, Math.round(value)))

  useEffect(() => {
    if (!dragging) return
    const finish = () => {
      const current = drag.current
      drag.current = undefined
      setDragging(false)
      if (current && element.current?.hasPointerCapture(current.pointerId)) element.current.releasePointerCapture(current.pointerId)
    }
    window.addEventListener('blur', finish)
    return () => window.removeEventListener('blur', finish)
  }, [dragging])

  function finish(cancel = false): void {
    const current = drag.current
    if (!current) return
    drag.current = undefined
    setDragging(false)
    if (cancel) onResize(current.width)
    if (element.current?.hasPointerCapture(current.pointerId)) element.current.releasePointerCapture(current.pointerId)
  }

  return <div ref={element} className="panel-sash" role="separator" tabIndex={0} aria-label={label} title={label}
    aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    data-dragging={dragging}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return
      event.preventDefault()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, startX: event.clientX, width }
      setDragging(true)
    }}
    onPointerMove={(event) => {
      const current = drag.current
      if (current?.pointerId === event.pointerId) onResize(clamp(current.width + direction * (event.clientX - current.startX)))
    }}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish() }}
    onPointerCancel={() => finish(true)}
    onLostPointerCapture={() => finish()}
    onDoubleClick={(event) => { event.preventDefault(); onReset() }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return }
      if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return
      const step = event.shiftKey ? 50 : 10
      const next = event.key === 'ArrowLeft' ? width - direction * step : event.key === 'ArrowRight' ? width + direction * step : event.key === 'Home' ? min : event.key === 'End' ? max : undefined
      if (next !== undefined) { event.preventDefault(); onResize(clamp(next)) }
      else if (event.key === 'Enter') { event.preventDefault(); onReset() }
    }} />
}