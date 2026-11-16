import {
  formatBrowseValue,
  type BrowseField,
  type BrowseValues,
} from '@repo/schemas/browse'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatTrackLength,
} from '@repo/ui/lib/format'

/*
 * Card grid geometry for the virtual scroller. The numbers mirror `.ds-grid`
 * and `.ds-card` in components.css and the spacing tokens; keep them in step.
 */
const gridGutter = 12 // --ds-gutter, each side
const columnGap = 16 // --ds-6
const rowGap = 20 // --ds-7
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
  return { columns, cardHeight, rowHeight: cardHeight + rowGap }
}

/** Height of the virtual grid for `height` reserved by the scroller. */
export function itemGridHeight(height: number) {
  return height > 0 ? height - rowGap + gridPadding : 0
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
