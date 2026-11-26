'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Search } from 'lucide-react'
import { ButtonFeedbackLabel, type ButtonFeedback } from '../ui/button'

export type SortOption<Key extends string> = { key: Key; label: string }

/**
 * The fields whose name holds `query`, in the order given: names that start
 * with it first, then names with a word that starts with it, then the rest.
 */
export function matchSortOptions<Key extends string>(
  options: readonly SortOption<Key>[],
  query: string,
): SortOption<Key>[] {
  const text = query.trim().toLowerCase()
  if (!text) return [...options]
  const ranked = options.flatMap((option) => {
    const label = option.label.toLowerCase()
    const at = label.indexOf(text)
    if (at < 0) return []
    const rank = at === 0 ? 0 : label.includes(` ${text}`) ? 1 : 2
    return [{ option, rank }]
  })
  return ranked.sort((a, b) => a.rank - b.rank).map(({ option }) => option)
}

/** The width below which the field list is a sheet, as in the stylesheet. */
const phone = '(max-width: 700px)'

/**
 * Picks the field a list is sorted by. The button is the select's box at a
 * fixed width, so a long field name is cut short and shown in full on hover.
 * It opens every field under a search field: typing narrows the list, Enter
 * picks the first match and Escape closes it. On a phone the list is a sheet
 * from the bottom edge and the search field waits for a tap.
 */
type PickerProps<Key extends string> = {
  value: Key
  options: readonly SortOption<Key>[]
  onChange: (key: Key) => void
  feedback?: ButtonFeedback
}

export function SortPicker<Key extends string>(props: PickerProps<Key>) {
  return (
    <SearchSelect
      {...props}
      label="Sort by"
      searchLabel="Find a field"
      emptyMessage="No field matches"
    />
  )
}

/** A searchable list of choices. Only picking a listed option commits a value. */
export function SearchSelect<Key extends string>({
  value,
  options,
  onChange,
  feedback,
  label,
  selectedLabel,
  searchLabel,
  emptyMessage,
  statusMessage,
  onSearch,
  onOpenChange,
}: PickerProps<Key> & {
  label: string
  selectedLabel?: string
  searchLabel: string
  emptyMessage: string
  statusMessage?: string
  /** When supplied, the caller loads matching options for this draft. */
  onSearch?: (query: string) => void
  onOpenChange?: (open: boolean) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [preferredKey, setPreferredKey] = useState<Key | undefined>(value)
  const selection =
    selectedLabel ??
    options.find((option) => option.key === value)?.label ??
    value
  const accessibleLabel = `${label}: ${selection}`
  const matches = onSearch ? options : matchSortOptions(options, query)
  const active = Math.max(
    0,
    matches.findIndex((option) => option.key === preferredKey),
  )
  const activeKey = matches[active]?.key

  useEffect(() => {
    if (!open) return
    panel.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'center' })
    if (!window.matchMedia(phone).matches)
      input.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    function position() {
      const button = trigger.current
      const box = panel.current
      if (!button || !box) return
      if (window.matchMedia(phone).matches) {
        box.style.left = ''
        box.style.top = ''
        return
      }
      const rect = button.getBoundingClientRect()
      const size = box.getBoundingClientRect()
      box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8))}px`
      const below = rect.bottom + 4
      box.style.top = `${
        below + size.height > window.innerHeight - 8
          ? Math.max(8, rect.top - size.height - 4)
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
  }, [open, matches.length])

  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus({ preventScroll: true })
  }

  function pick(key: Key) {
    close()
    if (key !== value) onChange(key)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // Closes the list only, not the drawer it may sit in.
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (activeKey !== undefined) pick(activeKey)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!matches.length) return
    const next =
      event.key === 'ArrowDown'
        ? (active + 1) % matches.length
        : (active - 1 + matches.length) % matches.length
    setPreferredKey(matches[next]?.key)
    const rows = panel.current?.querySelectorAll('[role="option"]')
    rows?.[next]?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ds-select ds-sort"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={
          feedback ? `${feedback.label} · ${accessibleLabel}` : accessibleLabel
        }
        aria-busy={feedback?.phase === 'pending' || undefined}
        aria-live={feedback ? 'polite' : undefined}
        data-feedback={feedback?.phase}
        title={feedback?.label ?? selection}
        popoverTarget={id}
      >
        {feedback ? (
          <ButtonFeedbackLabel feedback={feedback}>
            {selection}
          </ButtonFeedbackLabel>
        ) : (
          selection
        )}
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="ds-pop ds-sortpop"
        onBeforeToggle={(event) => {
          if (event.newState === 'open') setPreferredKey(value)
          else {
            setQuery('')
            onSearch?.('')
          }
          onOpenChange?.(event.newState === 'open')
        }}
        onToggle={(event) => {
          setOpen(event.newState === 'open')
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          // Tabbing out closes the list; a click on its own padding does not.
          const next = event.relatedTarget
          if (next instanceof Node && !event.currentTarget.contains(next))
            event.currentTarget.hidePopover()
        }}
      >
        <label className="ds-search">
          <Search className="ds-i" data-size="sm" aria-hidden />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={
              activeKey === undefined
                ? undefined
                : `${id}-${encodeURIComponent(activeKey)}`
            }
            placeholder={searchLabel}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              onSearch?.(event.target.value)
              setPreferredKey(undefined)
            }}
          />
        </label>
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="ds-sortpop-list"
        >
          {matches.map((option, index) => (
            <button
              key={option.key}
              id={`${id}-${encodeURIComponent(option.key)}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.key === value}
              data-active={index === active ? '' : undefined}
              className="ds-menu-item"
              onPointerMove={() => {
                if (index !== active) setPreferredKey(option.key)
              }}
              onClick={() => pick(option.key)}
            >
              {option.key === value ? (
                <Check className="ds-i" data-size="sm" aria-hidden />
              ) : (
                <span className="ds-menu-slot" />
              )}
              {option.label}
            </button>
          ))}
          {(statusMessage || matches.length === 0) && (
            <p className="ds-sortpop-none" role="status">
              {statusMessage ?? emptyMessage}
            </p>
          )}
        </div>
      </div>
    </>
  )
}
