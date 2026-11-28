import {
  formatBrowseFilterValue,
  formatBrowseValue,
  type BrowseField,
  type BrowseRange,
  type BrowseValues,
} from './browse'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatTrackLength,
} from './value-format'
import { formatVideoDuration } from './youtube'

/** A browse value in the app's formats: ISO dates, counts, track lengths, en dash when empty. */
export function formatFieldValue(
  field: BrowseField,
  value: BrowseValues[string] | undefined,
  timeZone?: string,
) {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE
  if (Array.isArray(value)) return value.length ? value.join(', ') : EMPTY_VALUE
  if (typeof value !== 'number')
    return formatBrowseFilterValue(field.key, value)
  if (!Number.isFinite(value)) return EMPTY_VALUE
  if (field.type === 'date') return formatDate(value, timeZone)
  if (field.format === 'seconds') return formatTrackLength(value * 1000)
  if (field.format === undefined || field.format === 'number')
    return formatCount(value)
  return formatBrowseValue(field, value)
}

function rangeText(
  range: BrowseRange,
  fields: readonly BrowseField[],
  bound: (field: BrowseField | undefined, value: number) => string,
) {
  const field = fields.find((field) => field.key === range.field)
  const side = (value: number | undefined) =>
    value === undefined ? '*' : bound(field, value)
  return `${field?.label ?? range.field}: ${side(range.min)} to ${side(range.max)}${range.includeMissing ? ' + missing' : ''}`
}

/** A Tracks range as its chip reads: "Duration: 3:00 to *". */
export function trackRangeLabel(
  range: BrowseRange,
  fields: readonly BrowseField[],
  timeZone?: string,
) {
  return rangeText(range, fields, (field, value) =>
    field ? formatFieldValue(field, value, timeZone) : String(value),
  )
}

/** An Albums or Films range as its chip reads: dates in ISO form, other values as entered. */
export function mediaRangeLabel(
  range: BrowseRange,
  fields: readonly BrowseField[],
) {
  return rangeText(range, fields, (field, value) =>
    field?.type === 'date' ? formatBrowseValue(field, value) : String(value),
  )
}

function rangeBound(field: BrowseField | undefined, value: number) {
  if (field?.key === 'durationSec') return formatVideoDuration(value)
  if (field) return formatBrowseValue(field, value)
  return String(value)
}

/** "Published: 2024-01-01 to *", with durations as m:ss. */
export function subscriptionRangeLabel(
  range: BrowseRange,
  fields: readonly BrowseField[],
) {
  return rangeText(range, fields, rangeBound)
}
