'use client'

import Link from 'next/link'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Check } from 'lucide-react'
import { BrowseActions, MoreButton } from '@repo/ui/components/ds/play'
import { cn } from '@repo/ui/lib/utils'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'

/**
 * A secondary action of an item: something to do, somewhere to go, or a
 * setting chosen from a named group, the current choice ticked. An action
 * receives the menu's button, so a popover that replaces the menu can open
 * where the menu was. `icon` goes before the label, as in a row's menu.
 */
export type DetailMenuItem =
  | {
      label: string
      onSelect: (anchor: HTMLElement) => void
      disabled?: boolean
      workspaceHref?: string
      icon?: ReactNode
    }
  | { label: string; href: string; workspaceLabel?: string; icon?: ReactNode }
  | {
      group: string
      choices: readonly {
        label: string
        checked: boolean
        onSelect: () => void
      }[]
      disabled?: boolean
    }

/** The width below which a sheet popover sits at the bottom edge, as in the stylesheet. */
const phone = '(max-width: 700px)'

/**
 * Keeps an open popover beside its button: right edges aligned, below the
 * button, or above it where there is no room below. On a phone a `sheet`
 * popover is left to the stylesheet, which puts it at the bottom edge.
 */
export function useAnchoredPopover(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  sheet = false,
) {
  useEffect(() => {
    if (!open) return
    function position() {
      if (!anchor.current || !panel.current) return
      if (sheet && window.matchMedia(phone).matches) {
        panel.current.style.left = ''
        panel.current.style.top = ''
        return
      }
      const rect = anchor.current.getBoundingClientRect()
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
    // A popover whose content changes, such as a picker's steps, moves too.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(position)
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [anchor, panel, open, sheet])
}

/**
 * The item a key moves focus to among `count` enabled items, from `current`
 * (-1 when focus is on none): Down and Up wrap round, Home and End go to the
 * first and last. Undefined for any other key.
 */
export function menuFocusIndex(
  key: string,
  current: number,
  count: number,
): number | undefined {
  if (!count) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowUp') return (current - 1 + count) % count
  return undefined
}

/**
 * The items of a menu. `close` hides the menu and returns focus to its
 * button; `hide` only hides it, for a link that moves focus itself. An
 * action runs after `close`, with the menu's button from `anchor`.
 */
export function ActionMenuItems({
  items,
  close,
  hide,
  anchor,
}: {
  items: readonly DetailMenuItem[]
  close: () => void
  hide: () => void
  anchor: () => HTMLElement | null
}) {
  return items.map((item) =>
    'choices' in item ? (
      <div
        key={item.group}
        role="group"
        aria-label={item.group}
        className="ds-menu-group"
      >
        <div className="ds-pop-head" aria-hidden="true">
          {item.group}
        </div>
        {item.choices.map((choice) => (
          <button
            key={choice.label}
            type="button"
            role="menuitemradio"
            aria-checked={choice.checked}
            className="ds-menu-item"
            disabled={item.disabled}
            onClick={() => {
              close()
              if (!choice.checked) choice.onSelect()
            }}
          >
            {choice.checked ? (
              <Check className="ds-i" data-size="sm" aria-hidden />
            ) : (
              <span className="ds-menu-slot" />
            )}
            {choice.label}
          </button>
        ))}
      </div>
    ) : 'href' in item ? (
      <Link
        key={item.label}
        {...(item.workspaceLabel
          ? workspaceTabLinkProps(item.href, item.workspaceLabel)
          : undefined)}
        href={item.href}
        prefetch={false}
        role="menuitem"
        className="ds-menu-item"
        onClick={hide}
      >
        {item.icon}
        {item.label}
      </Link>
    ) : (
      <button
        key={item.label}
        {...(item.workspaceHref
          ? workspaceTabLinkProps(item.workspaceHref, item.label)
          : undefined)}
        type="button"
        role="menuitem"
        className="ds-menu-item"
        disabled={item.disabled}
        onClick={() => {
          const button = anchor()
          close()
          if (button) item.onSelect(button)
        }}
      >
        {item.icon}
        {item.label}
      </button>
    ),
  )
}

/** What a menu's button needs: spread these onto it. */
export type ActionMenuTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string
  popoverTarget: string
}

/**
 * A menu of an item's actions on a native popover, opened by the button that
 * `trigger` draws. It focuses its first item when it opens, moves between
 * items with the arrow keys, Home and End, closes on Escape, an outside click
 * or a chosen item, and returns focus to its button. `sheet` is for a menu
 * opened from a row or card: clicks and keys inside it stay out of the row,
 * and on a phone it is a sheet at the bottom of the screen.
 */
export function ActionMenu({
  items,
  trigger,
  label = 'More actions',
  className,
  sheet = false,
  onOpenChange,
  children,
}: {
  items: readonly DetailMenuItem[]
  trigger: (props: ActionMenuTriggerProps) => ReactNode
  /** The menu's accessible name. */
  label?: string
  /** Classes for the menu besides `ds-pop`. */
  className?: string
  sheet?: boolean
  onOpenChange?: (open: boolean) => void
  /** Drawn after the items, inside the menu. */
  children?: ReactNode
}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    panel.current
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
      ?.focus({ preventScroll: true })
  }, [open])
  useAnchoredPopover(button, panel, open, sheet)
  function close() {
    panel.current?.hidePopover()
    button.current?.focus({ preventScroll: true })
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (sheet && (event.key === 'Enter' || event.key === ' '))
      event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([disabled])',
      ) ?? []),
    ]
    const next = menuFocusIndex(
      event.key,
      options.findIndex((option) => option === document.activeElement),
      options.length,
    )
    if (next === undefined) return
    event.preventDefault()
    options[next]?.focus()
  }
  return (
    <>
      {trigger({
        ref: button,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        popoverTarget: id,
      })}
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="menu"
        aria-label={label}
        className={cn('ds-pop', className)}
        data-sheet={sheet ? '' : undefined}
        onToggle={(event) => {
          const next = event.newState === 'open'
          setOpen(next)
          onOpenChange?.(next)
        }}
        onKeyDown={onKeyDown}
        onClick={sheet ? (event) => event.stopPropagation() : undefined}
        onDoubleClick={sheet ? (event) => event.stopPropagation() : undefined}
      >
        <ActionMenuItems
          items={items}
          close={close}
          hide={() => panel.current?.hidePopover()}
          anchor={() => button.current}
        />
        {children}
      </div>
    </>
  )
}

/**
 * More actions for one item in a table row, list row or card: the
 * `MoreButton` and its menu, which is a sheet on a phone. Pass it as a play
 * control's `more`, or give it `place` to stand alone where the play group
 * would be, for an item that cannot be played.
 */
export function RowMoreMenu({
  title,
  items,
  place,
  expanded = false,
  variant,
}: {
  /** The item's name, used in the button's and the menu's accessible names. */
  title: string
  items: readonly DetailMenuItem[]
  /** Draws the group around the button, for an item that cannot be played. */
  place?: 'tile' | 'row'
  /**
   * Keeps the button expanded, and its group shown, while a popover opened
   * from the menu, such as a playlist picker, is showing.
   */
  expanded?: boolean
  /** `ghost` for a button outside a play group, as in the player. */
  variant?: 'ghost'
}) {
  const menu = (
    <ActionMenu
      items={items}
      label={`More actions for ${title}`}
      sheet
      trigger={({ 'aria-expanded': open, ...props }) => (
        <MoreButton
          {...props}
          title={title}
          expanded={open || expanded}
          variant={variant}
        />
      )}
    />
  )
  return place ? <BrowseActions place={place}>{menu}</BrowseActions> : menu
}
