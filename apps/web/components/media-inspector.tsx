'use client'

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { z } from 'zod'

const WidthSchema = z.number().finite().min(360).max(2400)
const storageKey = 'media-inspector:width'
const mobileInspector = '(max-width: 700px)'
const dragSlop = 12
const dismissDistance = 96

interface InspectorStyle extends CSSProperties {
  '--inspector-width': string
  '--inspector-drag-y': string
}

type InspectorProps = ComponentPropsWithoutRef<'aside'> & {
  header: ReactNode
  onDismiss: () => void
}

type HeaderDrag = { pointerId: number; startX: number; startY: number }

function downwardDrag(x: number, y: number) {
  return y > 0 && y >= Math.abs(x) * 1.4
}

/** All detail drawers share a remembered, keyboard-adjustable desktop width. */
export const MediaInspector = forwardRef<HTMLElement, InspectorProps>(
  function MediaInspector(
    { children, className = '', header, onDismiss, style, ...props },
    ref,
  ) {
    const [width, setWidth] = useState(600)
    const [maximum, setMaximum] = useState(1200)
    const [resizing, setResizing] = useState(false)
    const [dragOffset, setDragOffset] = useState(0)
    const headerDrag = useRef<HeaderDrag | null>(null)
    useEffect(() => {
      try {
        const raw = window.localStorage.getItem(storageKey)
        const parsed = WidthSchema.safeParse(raw ? JSON.parse(raw) : null)
        if (parsed.success) setWidth(parsed.data)
      } catch {
        // Resizing remains available when browser storage is unavailable.
      }
      function measure() {
        setMaximum(Math.max(360, Math.min(2400, window.innerWidth - 32)))
      }
      measure()
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }, [])
    function resize(next: number) {
      const bounded = Math.round(Math.max(360, Math.min(maximum, next)))
      setWidth(bounded)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(bounded))
      } catch {
        // The current width still applies without persisted storage.
      }
    }

    function startDrag(event: PointerEvent<HTMLDivElement>) {
      if (
        !window.matchMedia(mobileInspector).matches ||
        !event.isPrimary ||
        event.button !== 0 ||
        (event.target instanceof Element &&
          event.target.closest('a, button, input, select, textarea'))
      )
        return
      headerDrag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    function cancelDrag(event: PointerEvent<HTMLDivElement>) {
      if (headerDrag.current?.pointerId !== event.pointerId) return
      headerDrag.current = null
      setDragOffset(0)
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
    }

    function moveDrag(event: PointerEvent<HTMLDivElement>) {
      const drag = headerDrag.current
      if (drag?.pointerId !== event.pointerId) return
      const x = event.clientX - drag.startX
      const y = event.clientY - drag.startY
      if (Math.max(Math.abs(x), Math.abs(y)) < dragSlop) {
        setDragOffset(0)
        return
      }
      if (downwardDrag(x, y)) setDragOffset(y)
      else cancelDrag(event)
    }

    function endDrag(event: PointerEvent<HTMLDivElement>) {
      const drag = headerDrag.current
      if (drag?.pointerId !== event.pointerId) return
      const y = event.clientY - drag.startY
      cancelDrag(event)
      if (y >= dismissDistance && downwardDrag(event.clientX - drag.startX, y))
        onDismiss()
    }
    const current = Math.min(width, maximum)
    const inspectorStyle: InspectorStyle = {
      ...style,
      '--inspector-width': `${current}px`,
      '--inspector-drag-y': `${dragOffset}px`,
    }
    return (
      <aside
        {...props}
        ref={ref}
        className={`media-inspector ${className}`.trim()}
        style={inspectorStyle}
        data-dragging={dragOffset > 0 || undefined}
      >
        <div
          className="inspector-resize-handle"
          role="separator"
          aria-label="Resize details panel"
          aria-orientation="vertical"
          aria-valuemin={360}
          aria-valuemax={maximum}
          aria-valuenow={current}
          tabIndex={0}
          title="Drag to resize; use arrow keys when focused"
          data-resizing={resizing || undefined}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              resize(window.innerWidth - event.clientX)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            setResizing(false)
          }}
          onLostPointerCapture={() => setResizing(false)}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 100 : 20
            if (event.key === 'ArrowLeft') resize(current + step)
            else if (event.key === 'ArrowRight') resize(current - step)
            else if (event.key === 'Home') resize(360)
            else if (event.key === 'End') resize(maximum)
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
        />
        <div
          className="detail-topbar"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
        >
          {header}
        </div>
        {children}
      </aside>
    )
  },
)
