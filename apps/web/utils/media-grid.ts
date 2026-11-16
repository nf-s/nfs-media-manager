import { z } from 'zod'

const GridDensitySchema = z.enum(['compact', 'standard', 'roomy'])
type GridDensity = z.infer<typeof GridDensitySchema>

export function parseGridDensity(value: unknown): GridDensity {
  const result = GridDensitySchema.safeParse(value)
  return result.success ? result.data : 'standard'
}

const CardDetailSchema = z.enum(['ratings', 'sort', 'tags'])
/**
 * What a grid card shows under its title and creator: `ratings` puts the
 * headline rating on the meta line, `sort` puts the sorted value there, and
 * `tags` adds the tags line. Stored in the `overlays` URL parameter, which
 * held the same three options when they sat on the artwork.
 */
export type CardDetail = z.infer<typeof CardDetailSchema>
export const cardDetails = CardDetailSchema.options

/** Every detail is shown unless a saved preference says otherwise. */
export function parseCardDetails(value: string | null): CardDetail[] {
  if (value === null) return [...cardDetails]
  return value.split(',').flatMap((key) => {
    const result = CardDetailSchema.safeParse(key)
    return result.success ? [result.data] : []
  })
}

export function formatCardDetails(details: CardDetail[]): string {
  return details.length ? details.join(',') : 'none'
}

const BrowseViewSchema = z.enum(['grid', 'list', 'table'])
export type BrowseView = z.infer<typeof BrowseViewSchema>

export function parseBrowseView(value: unknown, fallback: BrowseView = 'grid') {
  const result = BrowseViewSchema.safeParse(value)
  return result.success ? result.data : fallback
}

export function preserveGridScroll(
  scrollTop: number,
  previous: { columns: number; rowHeight: number },
  next: { columns: number; rowHeight: number },
): number {
  if (
    previous.columns === next.columns &&
    previous.rowHeight === next.rowHeight
  )
    return scrollTop
  const row = Math.max(0, scrollTop) / previous.rowHeight
  const firstItem = Math.floor(row) * previous.columns
  return (Math.floor(firstItem / next.columns) + (row % 1)) * next.rowHeight
}

/*
 * Card grid geometry. These mirror the design system so the virtual grid
 * reserves exactly what the cards draw: `.ds-grid` gaps (--ds-7 rows,
 * --ds-6 columns), its padding (--ds-2 top, --ds-gutter sides, --ds-8
 * bottom), and the card's lines (artwork margin --ds-3, 2px between lines,
 * 18px title, 16px creator, 18px meta line, 20px tags line).
 */
export const cardGrid = {
  rowGap: 20,
  columnGap: 16,
  gutter: 12,
  paddingTop: 4,
  paddingBottom: 24,
}

const cardLines = { art: 6, line: 2, title: 18, by: 16, meta: 18, tags: 20 }

/** Smallest card width per density, in px, as in `CardGrid min`. */
const cardMin = {
  album: { compact: 104, standard: 164, roomy: 220 },
  film: { compact: 96, standard: 118, roomy: 160 },
}

export function mediaGridGeometry({
  width,
  mediaType,
  density,
  extraRow = true,
  tagsBelowArtwork = false,
}: {
  width: number
  mediaType: 'album' | 'film'
  density: GridDensity
  /** Whether cards show the meta line (year and one value). */
  extraRow?: boolean
  /** Whether cards show the tags line. */
  tagsBelowArtwork?: boolean
}) {
  const mobile = width <= 700
  const inner = Math.max(0, width - cardGrid.gutter * 2)
  const minimum = cardMin[mediaType][density]
  const columns = Math.max(
    2,
    Math.floor((inner + cardGrid.columnGap) / (minimum + cardGrid.columnGap)),
  )
  const artworkWidth = Math.max(
    0,
    (inner - (columns - 1) * cardGrid.columnGap) / columns,
  )
  const artworkHeight = artworkWidth * (mediaType === 'album' ? 1 : 1.5)
  const lines =
    cardLines.art +
    cardLines.line +
    cardLines.title +
    cardLines.line +
    cardLines.by +
    (extraRow ? cardLines.line + cardLines.meta : 0) +
    (tagsBelowArtwork ? cardLines.line + cardLines.tags : 0)
  const cardHeight = artworkHeight + lines
  return {
    mobile,
    /** The gap between rows; columns use `columnGap`. */
    gap: cardGrid.rowGap,
    columnGap: cardGrid.columnGap,
    columns,
    cardHeight,
    rowHeight: cardHeight + cardGrid.rowGap,
    /** The grid's own top and bottom padding, outside the virtual rows. */
    padding: cardGrid.paddingTop + cardGrid.paddingBottom,
  }
}
