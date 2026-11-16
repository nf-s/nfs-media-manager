'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis } from 'lucide-react'
import { Button, type ButtonSize } from '@repo/ui/components/ui/button'
import type { DetailCrumb } from '@/utils/detail-inspector'
import { useInspectorPage } from './detail-inspector-context'

/** A secondary action of an item: something to do, or somewhere to go. */
export type DetailMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean }
  | { label: string; href: string }

/**
 * More actions, the last button of every detail header: the item's own
 * secondary actions, then Open page in the drawer and Copy link. In the drawer
 * it also names the item in the breadcrumbs, and on a phone it moves to the
 * drawer bar.
 */
export function DetailMore({
  crumb,
  items = [],
}: {
  /** The item's breadcrumb; leave it out until the details have loaded. */
  crumb?: DetailCrumb
  items?: readonly DetailMenuItem[]
}) {
  const page = useInspectorPage()
  const setCrumb = page?.setCrumb
  const title = crumb?.title
  const batchHref = crumb?.batchHref
  useEffect(() => {
    if (setCrumb && title) setCrumb({ title, batchHref })
  }, [setCrumb, title, batchHref])
  const all: DetailMenuItem[] = [
    ...items,
    ...(page ? [{ label: 'Open page', href: page.pageHref }] : []),
  ]
  return (
    <>
      <MoreMenu
        items={all}
        pageHref={page?.pageHref}
        size="md"
        className={page?.moreSlot ? 'dtl-more' : undefined}
      />
      {page?.moreSlot &&
        createPortal(
          <MoreMenu items={all} pageHref={page.pageHref} size="sm" />,
          page.moreSlot,
        )}
    </>
  )
}

function MoreMenu({
  items,
  pageHref,
  size,
  className,
}: {
  items: readonly DetailMenuItem[]
  pageHref: string | undefined
  size: ButtonSize
  className?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (!open) {
      setCopy('idle')
      return
    }
    panel.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`
      const below = rect.bottom + 4
      panel.current.style.top = `${
        below + box.height > window.innerHeight - 8
          ? Math.max(8, rect.top - box.height - 4)
          : below
      }px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus({ preventScroll: true })
  }
  async function copyLink() {
    const url = pageHref
      ? new URL(pageHref, window.location.origin).href
      : window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? []),
    ]
    if (!options.length) return
    event.preventDefault()
    const current = options.findIndex(
      (option) => option === document.activeElement,
    )
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % options.length
            : (current - 1 + options.length) % options.length
    options[next]?.focus()
  }
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size={size}
        icon
        className={className}
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
      >
        <Ellipsis className="ds-i" aria-hidden="true" />
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="menu"
        aria-label="More actions"
        className="ds-pop dtl-more-pop"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={onKeyDown}
      >
        {items.map((item) =>
          'href' in item ? (
            <Link
              key={item.label}
              href={item.href}
              prefetch={false}
              role="menuitem"
              className="ds-menu-item"
              onClick={() => panel.current?.hidePopover()}
            >
              {item.label}
            </Link>
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="ds-menu-item"
              disabled={item.disabled}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ),
        )}
        <button
          type="button"
          role="menuitem"
          className="ds-menu-item"
          onClick={() => void copyLink()}
        >
          {copy === 'copied'
            ? 'Link copied'
            : copy === 'failed'
              ? 'Could not copy link'
              : 'Copy link'}
        </button>
        <span className="sr-only" role="status">
          {copy === 'copied'
            ? 'Link copied'
            : copy === 'failed'
              ? 'Could not copy link'
              : ''}
        </span>
      </div>
    </>
  )
}
