'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'

export function FilterPanelSection({
  title,
  icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  icon: ReactNode
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details
      className="filter-panel-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {icon}
        <span>{title}</span>
        {Boolean(count) && <span className="filter-panel-count">{count}</span>}
        <ChevronDown size={15} className="filter-panel-chevron" />
      </summary>
      <div className="filter-panel-section-body">{children}</div>
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
      className="tag-drawer browse-filter-panel"
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
      <div className="filter-panel-inner">
        <div className="detail-topbar filter-panel-header">
          <h2 id={titleId}>Filters</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Close filters"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </div>
        <div className="filter-panel-body">{children}</div>
      </div>
    </dialog>,
    document.body,
  )
}

export default function BrowseFilterPanel({
  count,
  children,
}: {
  count: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const id = useId()
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="filter-panel-trigger gap-1"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        <SlidersHorizontal size={15} /> Filters
        {count > 0 && <span className="filter-panel-count">{count}</span>}
      </Button>
      {mounted && (
        <FilterDialog id={id} open={open} onClose={() => setOpen(false)}>
          {children}
        </FilterDialog>
      )}
    </>
  )
}
