import { useEffect, useRef, useState } from 'react'
import { clampSplitRatio, defaultLayout, splitRatioLimits } from '../layout'
import type { LayoutPanel, SplitOrientation } from '../layout'

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
  const label = panel === 'sidebar' ? 'Resize Explorer' : 'Resize task details'
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

export function ChatSplitSash({ ratio, orientation = 'horizontal', onResize, onReset }: {
  ratio: number
  orientation?: SplitOrientation
  onResize(ratio: number): void
  onReset(): void
}) {
  const element = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; startCoord: number; ratio: number; containerSpan: number } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const percent = Math.round(ratio * 100)
  const verticalStack = orientation === 'vertical'

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
    if (cancel) onResize(current.ratio)
    if (element.current?.hasPointerCapture(current.pointerId)) element.current.releasePointerCapture(current.pointerId)
  }

  return <div ref={element} className="panel-sash chat-split-sash" data-orientation={orientation} role="separator" tabIndex={0}
    aria-label="Resize split chat panes" title="Drag to resize split panes (double-click to reset 50/50)"
    aria-orientation={verticalStack ? 'horizontal' : 'vertical'}
    aria-valuemin={Math.round(splitRatioLimits.min * 100)}
    aria-valuemax={Math.round(splitRatioLimits.max * 100)}
    aria-valuenow={percent}
    aria-valuetext={`${percent}% ${verticalStack ? 'top' : 'left'} pane`}
    data-dragging={dragging}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return
      event.preventDefault()
      event.currentTarget.focus()
      const rect = event.currentTarget.parentElement?.getBoundingClientRect()
      const containerSpan = Math.max(1, verticalStack ? rect?.height ?? 600 : rect?.width ?? 800)
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, startCoord: verticalStack ? event.clientY : event.clientX, ratio, containerSpan }
      setDragging(true)
    }}
    onPointerMove={(event) => {
      const current = drag.current
      if (current?.pointerId === event.pointerId) {
        const coord = verticalStack ? event.clientY : event.clientX
        onResize(clampSplitRatio(current.ratio + (coord - current.startCoord) / current.containerSpan))
      }
    }}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish() }}
    onPointerCancel={() => finish(true)}
    onLostPointerCapture={() => finish()}
    onDoubleClick={(event) => { event.preventDefault(); onReset() }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return }
      if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return
      const step = event.shiftKey ? 0.1 : 0.04
      const decrease = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      const increase = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      const next = decrease ? ratio - step : increase ? ratio + step
        : event.key === 'Home' ? splitRatioLimits.min : event.key === 'End' ? splitRatioLimits.max : undefined
      if (next !== undefined) { event.preventDefault(); onResize(clampSplitRatio(next)) }
      else if (event.key === 'Enter') { event.preventDefault(); onResize(defaultLayout.splitRatio); onReset() }
    }} />
}