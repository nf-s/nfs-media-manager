'use client'

import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from 'react'
import { z } from 'zod'

const WidthSchema = z.number().finite().min(360).max(2400)
const storageKey = 'media-inspector:width'
interface InspectorStyle extends CSSProperties {
  '--inspector-width': string
}

/** All detail drawers share a remembered, keyboard-adjustable desktop width. */
export const MediaInspector = forwardRef<
  HTMLElement,
  ComponentPropsWithoutRef<'aside'>
>(function MediaInspector({ children, className = '', style, ...props }, ref) {
  const [width, setWidth] = useState(600)
  const [maximum, setMaximum] = useState(1200)
  const [resizing, setResizing] = useState(false)
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
  const current = Math.min(width, maximum)
  const inspectorStyle: InspectorStyle = {
    ...style,
    '--inspector-width': `${current}px`,
  }
  return (
    <aside
      {...props}
      ref={ref}
      className={`media-inspector ${className}`.trim()}
      style={inspectorStyle}
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
      {children}
    </aside>
  )
})
