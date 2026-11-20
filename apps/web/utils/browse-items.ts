import {
  canonicalBrowseKey,
  formatBrowseValue,
  type BrowseField,
  type BrowseFilter,
  type BrowseValues,
} from '@repo/schemas/browse'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { detailLocation, withoutDetailEntries } from './detail-inspector'

/** Copy a Browse destination, keeping its settings and scope outside the inspector. */
export function browseSearchHref(
  href: string,
  updates: Record<string, string | null>,
) {
  const url = new URL(href, 'https://workspace.invalid')
  const params = withoutDetailEntries(url.pathname, url.searchParams)
  for (const [key, value] of Object.entries(updates)) {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  params.delete('page')
  return detailLocation(url.pathname, params, url.hash)
}

export function browseFilterHref(href: string, filters: BrowseFilter[]) {
  return browseSearchHref(href, {
    filters: filters.length ? JSON.stringify(filters) : null,
  })
}

export type BrowseFilterHref = (filter: BrowseFilter) => string

/*
 * Card grid geometry for the virtual scroller. The numbers mirror `.ds-grid`
 * and `.ds-card` in components.css and the spacing tokens; keep them in step.
 */
const gridGutter = 12 // --ds-gutter, each side
const columnGap = 16 // --ds-6
export const gridRowGap = 20 // --ds-7
/** --ds-2 above the first row and --ds-8 below the last. */
const gridPadding = 4 + 24
/** Artwork margin, title, creator and meta line, and the gaps between them. */
const cardTextHeight = 6 + 18 + 16 + (2 + 16) + 3 * 2
/** The tags line and its gap. */
const cardTagsHeight = 20 + 2

/**
 * Columns and row height of a card grid `width` pixels wide. `min` is the
 * smallest card width; `ratio` is the artwork height over its width.
 */
export function itemGridGeometry({
  width,
  min,
  ratio = 1,
  tags = true,
}: {
  width: number
  min: number
  ratio?: number
  tags?: boolean
}) {
  const inner = Math.max(0, width - 2 * gridGutter)
  const columns = Math.max(
    2,
    Math.floor((inner + columnGap) / (min + columnGap)),
  )
  const cardWidth = Math.max(0, (inner - (columns - 1) * columnGap) / columns)
  const cardHeight = Math.round(
    cardWidth * ratio + cardTextHeight + (tags ? cardTagsHeight : 0),
  )
  return { columns, cardHeight, rowHeight: cardHeight + gridRowGap }
}

/** Height of the virtual grid for `height` reserved by the scroller. */
export function itemGridHeight(height: number) {
  return height > 0 ? height - gridRowGap + gridPadding : 0
}

/**
 * Fields in the resource's column order: identity, creator, parent,
 * properties, dates, counts, ratings, pills. Fields the order does not name,
 * such as plugin fields, follow in their own order.
 */
export function orderFields(
  fields: readonly BrowseField[],
  order: readonly string[],
) {
  const rank = (field: BrowseField) => {
    const index = order.indexOf(field.key)
    return index < 0 ? order.length : index
  }
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field)
}

/**
 * The owner's column order from the `columnOrder` URL value: column keys,
 * comma-separated. Null when the order is the default one.
 */
export function parseColumnOrder(value: string | null): string[] | null {
  const keys = [
    ...new Set((value ?? '').split(',').map(canonicalBrowseKey)),
  ].filter(Boolean)
  return keys.length ? keys : null
}

/**
 * Columns in the owner's order. Saved keys come first as saved; a column the
 * saved order does not name follows the column before it in `defaults`, so
 * new fields keep their default place. `pinned`, the identity column, leads.
 */
export function orderColumns<Column extends { key: string }>(
  defaults: readonly Column[],
  saved: readonly string[] | null,
  pinned?: string,
): Column[] {
  const ordered: Column[] = []
  for (const key of saved ?? []) {
    const column = defaults.find((item) => item.key === key)
    if (column && !ordered.includes(column)) ordered.push(column)
  }
  defaults.forEach((column, index) => {
    if (ordered.includes(column)) return
    const previous = defaults[index - 1]
    ordered.splice(previous ? ordered.indexOf(previous) + 1 : 0, 0, column)
  })
  const lead = ordered.find((column) => column.key === pinned)
  return lead ? [lead, ...ordered.filter((column) => column !== lead)] : ordered
}

/** The `columnOrder` URL value for `keys`: null when it is the default order. */
export function columnOrderParam(
  keys: readonly string[],
  defaults: readonly { key: string }[],
): string | null {
  return keys.join(',') === defaults.map(({ key }) => key).join(',')
    ? null
    : keys.join(',')
}

/**
 * Whether `ordered`, the columns as shown, differ from the default order. A
 * `columnOrder` value that names only the default order or unknown keys does not
 * count, so Reset order shows only when it would change something.
 */
export function hasCustomColumnOrder(
  ordered: readonly { key: string }[],
  defaults: readonly { key: string }[],
  pinned?: string,
) {
  return (
    columnOrderParam(
      ordered.map(({ key }) => key),
      orderColumns(defaults, null, pinned),
    ) !== null
  )
}

/**
 * Whether the toolbar count is still loading. Page one alone can give the
 * total, but the count query also brings the unfiltered total for `3 of 128`,
 * so the count waits for it rather than reading `3 albums` first. A failed
 * count query falls back to the total alone.
 */
export function isBrowseCounting({
  hasTotal,
  conflict,
  countSettled,
}: {
  hasTotal: boolean
  conflict: boolean
  countSettled: boolean
}) {
  return !hasTotal || conflict || !countSettled
}

/** A new sort starts ascending for text and descending for dates and numbers. */
export function initialSortDirection(field: BrowseField | undefined) {
  return field?.type === 'text' ? 'asc' : 'desc'
}

/** The direction after choosing `key`: the same key flips, a new key starts afresh. */
export function nextSortDirection(
  fields: readonly BrowseField[],
  key: string,
  current: { sortBy: string; direction: 'asc' | 'desc' },
): 'asc' | 'desc' {
  if (current.sortBy === key)
    return current.direction === 'desc' ? 'asc' : 'desc'
  return initialSortDirection(fields.find((field) => field.key === key))
}

/** A browse value in the app's formats: ISO dates, counts, track lengths, en dash when empty. */
export function formatFieldValue(
  field: BrowseField,
  value: BrowseValues[string] | undefined,
) {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE
  if (Array.isArray(value)) return value.length ? value.join(', ') : EMPTY_VALUE
  if (typeof value !== 'number') return value
  if (!Number.isFinite(value)) return EMPTY_VALUE
  if (field.type === 'date') return formatDate(value)
  if (field.format === 'seconds') return formatTrackLength(value * 1000)
  if (field.format === undefined || field.format === 'number')
    return formatCount(value)
  return formatBrowseValue(field, value)
}

/** The sorted field's value for a card's meta line, such as `Added 2026-11-16`. */
export function sortedValueLabel(
  field: BrowseField | undefined,
  value: BrowseValues[string] | undefined,
) {
  if (!field || field.type === 'text') return null
  const formatted = formatFieldValue(field, value)
  return formatted === EMPTY_VALUE ? null : `${field.label} ${formatted}`
}

/** Values of a text field as a list. */
export function textValues(value: BrowseValues[string] | undefined) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}
