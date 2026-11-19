import { z } from 'zod'

export type WidthLimits = { min: number; max: number }

/** Primary Browse tables. */
export const browseWidthLimits: WidthLimits = { min: 70, max: 650 }
/** Every other table: narrow number columns up to long result text. */
export const tableWidthLimits: WidthLimits = { min: 40, max: 1200 }
/** The width of a column that states none. */
export const defaultColumnWidth = 140

export const SavedWidthsSchema = z.record(
  z.string(),
  z.number().min(tableWidthLimits.min).max(tableWidthLimits.max),
)

/**
 * The width a drag or key press gives a column. `rendered` is the width the
 * column has on screen, which is more than its set width while it takes the
 * room left over in the table. Such a column grows from what is on screen and
 * keeps its set width until it is dragged below it.
 */
export function resizedWidth({
  width,
  rendered,
  delta,
  limits,
}: {
  width: number
  rendered?: number
  delta: number
  limits: WidthLimits
}) {
  const start = Math.max(width, Math.round(rendered ?? width))
  const next = start + delta
  if (next >= start)
    return start > limits.max ? width : Math.min(limits.max, next)
  return Math.max(limits.min, Math.min(width, next))
}

/**
 * Column widths for a fixed-layout table. `entries` are the columns in display
 * order: a column key, or a pixel width for a column that cannot be resized,
 * such as selection or row actions. Every column keeps its width except one,
 * which takes the room that is left and is never narrower than its own width:
 * the `fill` column when it is displayed, otherwise the last keyed one.
 */
export function tableColumnLayout(
  entries: readonly (string | number)[],
  widthFor: (key: string) => number,
  fill?: string,
) {
  const sizes = entries.map((entry) =>
    typeof entry === 'number' ? entry : widthFor(entry),
  )
  const lastKeyed = entries.reduce<number>(
    (last, entry, index) => (typeof entry === 'string' ? index : last),
    -1,
  )
  const chosen = fill === undefined ? -1 : entries.indexOf(fill)
  const filled = chosen === -1 ? lastKeyed : chosen
  return {
    widths: sizes.map((size, index) => (index === filled ? undefined : size)),
    minWidth: sizes.reduce((sum, size) => sum + size, 0),
  }
}
