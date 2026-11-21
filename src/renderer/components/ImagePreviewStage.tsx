import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent } from 'react'
import { Icon, IconButton } from './Primitives'
import '../sessions.css'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 6
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6] as const
const STAGE_PADDING = 16

interface Dimensions {
  width: number
  height: number
}

interface FocalZoom {
  prevZoom: number
  nextZoom: number
  offsetX: number
  offsetY: number
  scrollLeft: number
  scrollTop: number
}

interface PanState {
  pointerId: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

function nextZoomStep(current: number, direction: 'in' | 'out'): number {
  if (direction === 'in') {
    for (const step of ZOOM_STEPS) {
      if (step > current + 0.01) return step
    }
    return MAX_ZOOM
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index] < current - 0.01) return ZOOM_STEPS[index]
  }
  return MIN_ZOOM
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function PreviewFullScreenButton({
  fullScreen,
  onToggle,
}: {
  fullScreen: boolean
  onToggle(): void
}) {
  return (
    <button
      type="button"
      className="markdown-expand-button preview-fullscreen-button"
      data-active={fullScreen || undefined}
      aria-label={fullScreen ? 'Exit full screen preview' : 'Full screen preview'}
      title={fullScreen ? 'Exit full screen preview (F)' : 'Full screen preview (F)'}
      aria-pressed={fullScreen}
      onClick={onToggle}
    >
      <Icon name={fullScreen ? 'screen-normal' : 'screen-full'} />
      <span>{fullScreen ? 'Exit full screen' : 'Full screen'}</span>
    </button>
  )
}

export function ImagePreviewStage({
  src,
  alt,
  fullScreen = false,
  className = '',
}: {
  src: string
  alt: string
  fullScreen?: boolean
  className?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [naturalSize, setNaturalSize] = useState<Dimensions>()
  const [stageSize, setStageSize] = useState<Dimensions>()
  const [panning, setPanning] = useState(false)
  const zoomRef = useRef(1)
  const focalRef = useRef<FocalZoom | undefined>(undefined)
  const panRef = useRef<PanState | undefined>(undefined)

  useLayoutEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  const applyZoom = useCallback((targetZoom: number, clientX?: number, clientY?: number) => {
    const clamped = clampZoom(targetZoom)
    const current = zoomRef.current
    if (clamped === current) return
    const viewport = viewportRef.current
    if (viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      const rect = viewport.getBoundingClientRect()
      const offsetX = clientX !== undefined ? clientX - rect.left : rect.width / 2
      const offsetY = clientY !== undefined ? clientY - rect.top : rect.height / 2
      focalRef.current = {
        prevZoom: current,
        nextZoom: clamped,
        offsetX,
        offsetY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      }
    }
    zoomRef.current = clamped
    setZoom(clamped)
  }, [])

  const resetZoom = useCallback(() => {
    focalRef.current = undefined
    zoomRef.current = 1
    setZoom(1)
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
    }
  }, [])

  useLayoutEffect(() => {
    const focal = focalRef.current
    focalRef.current = undefined
    const viewport = viewportRef.current
    if (!focal || !viewport || focal.prevZoom <= 0) return
    const ratio = focal.nextZoom / focal.prevZoom
    if (viewport.scrollWidth > viewport.clientWidth) {
      viewport.scrollLeft = Math.max(0, Math.round((focal.scrollLeft + focal.offsetX) * ratio - focal.offsetX))
    }
    if (viewport.scrollHeight > viewport.clientHeight) {
      viewport.scrollTop = Math.max(0, Math.round((focal.scrollTop + focal.offsetY) * ratio - focal.offsetY))
    }
  }, [zoom, stageSize, naturalSize, fullScreen])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let frame: number | undefined
    const measure = () => {
      frame = undefined
      const width = viewport.clientWidth
      const height = viewport.clientHeight
      if (width <= 0 || height <= 0) return
      setStageSize((prior) => (prior?.width === width && prior?.height === height ? prior : { width, height }))
    }
    frame = requestAnimationFrame(measure)
    const sync = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure)
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined
    observer?.observe(viewport)
    window.addEventListener('resize', sync)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', sync)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [fullScreen])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || event.deltaY === 0) return
      event.preventDefault()
      const rawDelta = event.deltaMode === 1 ? event.deltaY * 24 : event.deltaY
      const boundedDelta = Math.max(-160, Math.min(160, rawDelta))
      const factor = Math.exp(-boundedDelta * 0.002)
      const next = Math.abs(zoomRef.current * factor - 1) < 0.02 ? 1 : zoomRef.current * factor
      applyZoom(next, event.clientX, event.clientY)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  useEffect(() => {
    const host: HTMLElement | Window = viewportRef.current?.closest('dialog') ?? window
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
      if (isEditableElement(event.target)) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        applyZoom(nextZoomStep(zoomRef.current, 'in'))
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        applyZoom(nextZoomStep(zoomRef.current, 'out'))
      } else if (event.key === '0') {
        event.preventDefault()
        resetZoom()
      }
    }
    host.addEventListener('keydown', onKeyDown)
    return () => host.removeEventListener('keydown', onKeyDown)
  }, [applyZoom, resetZoom])

  function handleDoubleClick(event: MouseEvent<HTMLDivElement>): void {
    if (Math.abs(zoom - 1) < 0.01) {
      applyZoom(2, event.clientX, event.clientY)
    } else {
      resetZoom()
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (zoom <= 1 || event.button !== 0) return
    const viewport = viewportRef.current
    if (!viewport) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    }
    viewport.setPointerCapture?.(event.pointerId)
    setPanning(true)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const pan = panRef.current
    const viewport = viewportRef.current
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX)
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.startY)
  }

  function endPan(event: PointerEvent<HTMLDivElement>): void {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    panRef.current = undefined
    const viewport = viewportRef.current
    if (viewport?.hasPointerCapture?.(event.pointerId)) {
      viewport.releasePointerCapture?.(event.pointerId)
    }
    setPanning(false)
  }

  let imageStyle: CSSProperties | undefined
  if (naturalSize && stageSize && naturalSize.width > 0 && naturalSize.height > 0) {
    const availWidth = Math.max(1, stageSize.width - STAGE_PADDING)
    const availHeight = Math.max(1, stageSize.height - STAGE_PADDING)
    const fitScale = fullScreen
      ? Math.min(availWidth / naturalSize.width, availHeight / naturalSize.height)
      : Math.min(1, availWidth / naturalSize.width, availHeight / naturalSize.height)
    const width = Math.max(1, Math.round(naturalSize.width * fitScale * zoom))
    const height = Math.max(1, Math.round(naturalSize.height * fitScale * zoom))
    imageStyle = { width: `${width}px`, height: `${height}px`, maxWidth: 'none', maxHeight: 'none' }
  } else if (zoom !== 1) {
    imageStyle = { width: `${Math.round(zoom * 100)}%`, maxWidth: 'none', maxHeight: 'none' }
  }

  const zoomPercent = Math.round(zoom * 100)

  return (
    <div className={`image-preview-shell ${className}`.trim()}>
      <div className="image-preview-toolbar" role="toolbar" aria-label="Image zoom controls">
        <span className="image-preview-hint">Scroll or double-click to zoom{zoom > 1 ? ' · Drag to pan' : ''}</span>
        <div className="image-preview-controls">
          <IconButton
            icon="zoom-out"
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => applyZoom(nextZoomStep(zoom, 'out'))}
          />
          <button
            type="button"
            className="image-preview-zoom-reset"
            aria-label="Reset zoom"
            title="Reset zoom to fit (0)"
            disabled={zoom === 1}
            onClick={resetZoom}
          >
            {zoomPercent}%
          </button>
          <IconButton
            icon="zoom-in"
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => applyZoom(nextZoomStep(zoom, 'in'))}
          />
        </div>
      </div>
      <div
        ref={viewportRef}
        className="image-preview-viewport"
        data-zoom={zoomPercent}
        data-zoomed={zoom > 1 || undefined}
        data-panning={panning || undefined}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <img
          className="chat-file-image"
          src={src}
          alt={alt}
          style={imageStyle}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth > 0 && naturalHeight > 0) {
              setNaturalSize((prior) =>
                prior?.width === naturalWidth && prior?.height === naturalHeight
                  ? prior
                  : { width: naturalWidth, height: naturalHeight },
              )
            }
          }}
        />
      </div>
    </div>
  )
}
