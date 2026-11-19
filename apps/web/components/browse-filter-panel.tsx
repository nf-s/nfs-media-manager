'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { Count } from '@repo/ui/components/ds/pill'

export function FilterPanelSection({
  title,
  icon,
  count,
  defaultOpen = false,
  onToggle,
  children,
}: {
  title: string
  icon: ReactNode
  count?: number
  defaultOpen?: boolean
  /** Told when the section opens or closes, to load its content on demand. */
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details
      className="browse-disclosure"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        onToggle?.(event.currentTarget.open)
      }}
    >
      <summary>
        {icon}
        <span>{title}</span>
        {Boolean(count) && <Count>{count}</Count>}
        <ChevronDown
          className="ds-i browse-disclosure-chevron"
          data-size="sm"
          aria-hidden
        />
      </summary>
      <div className="browse-disclosure-body">{children}</div>
    </details>
  )
}

function FilterDialog({
  id,
  open,
  children,
  onClose,
}: {
  id: string
  open: boolean
  children: ReactNode
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [open])

  return createPortal(
    <dialog
      id={id}
      ref={dialog}
      className="sec-drawer browse-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="ds-inspector">
        <div className="ds-inspector-bar">
          <h2 id={titleId} className="browse-drawer-title">
            Filters and view
          </h2>
          <Button
            type="button"
            variant="ghost"
            icon
            aria-label="Close filters"
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden />
          </Button>
        </div>
        <div className="ds-inspector-body browse-drawer-body">{children}</div>
      </div>
    </dialog>,
    document.body,
  )
}

/**
 * The one button for everything a list keeps off its toolbar: filters,
 * columns and grid size. It is named Filters on a Browse page. With `short`,
 * as inside a detail, and on every phone it is the icon with the number of
 * filters that are on.
 */
export default function BrowseFilterPanel({
  count,
  short = false,
  children,
}: {
  count: number
  short?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const id = useId()
  const name =
    count > 0
      ? `Filters, columns and grid size, ${count} ${count === 1 ? 'filter' : 'filters'} on`
      : 'Filters, columns and grid size'
  return (
    <>
      <Button
        type="button"
        data-filters={short ? 'short' : 'full'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={name}
        title={name}
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        <SlidersHorizontal className="ds-i" data-size="sm" aria-hidden />
        <span>{count > 0 ? `Filters · ${count}` : 'Filters'}</span>
        {count > 0 && <Count>{count}</Count>}
      </Button>
      {mounted && (
        <FilterDialog id={id} open={open} onClose={() => setOpen(false)}>
          {children}
        </FilterDialog>
      )}
    </>
  )
}
