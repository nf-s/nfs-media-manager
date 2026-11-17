import { z } from 'zod'

const GridDensitySchema = z.enum(['compact', 'standard', 'roomy'])
export type GridDensity = z.infer<typeof GridDensitySchema>
export const gridDensities = GridDensitySchema.options

/** The width at which the interface switches to its phone layout. */
export const phoneMediaQuery = '(max-width: 700px)'

/** Phones start compact so more of the library fits; wider screens start standard. */
export function defaultGridDensity(phone: boolean): GridDensity {
  return phone ? 'compact' : 'standard'
}

export function parseGridDensity(
  value: unknown,
  fallback: GridDensity = 'standard',
): GridDensity {
  const result = GridDensitySchema.safeParse(value)
  return result.success ? result.data : fallback
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

/**
 * The view a list of `kind` items starts in, in Browse and inside details:
 * Table for tracks, Grid for albums and films. Other lists keep `otherwise`.
 */
export function defaultBrowseView(
  kind: string,
  otherwise: BrowseView = 'table',
): BrowseView {
  if (kind === 'track') return 'table'
  if (kind === 'album' || kind === 'film') return 'grid'
  return otherwise
}

type BrowseStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Raised when the default views change. Version 2 starts Tracks in Table
 * and Albums and Films in Grid.
 */
const savedViewVersion = '2'
/** Libraries whose default view changed in the current version. */
const librariesWithNewDefaults = ['albums', 'films', 'tracks']

/**
 * The Browse state saved for `library` (`browse:<library>`), ready to put in
 * the URL. A view saved under the previous defaults is dropped once, so the
 * new default applies; a view chosen afterwards is kept. Everything else
 * saved (filters, sort, columns, density) is kept.
 */
export function restoreSavedBrowse(
  storage: BrowseStorage,
  library: string,
): string | null {
  const key = `browse:${library}`
  const versionKey = `browse-view-version:${library}`
  const saved = storage.getItem(key)
  if (
    !librariesWithNewDefaults.includes(library) ||
    storage.getItem(versionKey) === savedViewVersion
  )
    return saved
  storage.setItem(versionKey, savedViewVersion)
  if (saved === null) return null
  const params = new URLSearchParams(saved)
  if (!params.has('view')) return saved
  params.delete('view')
  const next = params.toString()
  storage.setItem(key, next)
  return next
}

/**
 * The view saved for a nested list. Version 2 of the key holds views chosen
 * since the defaults changed; a value under the earlier key is removed, so
 * the list starts in its new default.
 */
export function readNestedView(
  storage: BrowseStorage,
  scope: string,
  fallback: BrowseView,
): BrowseView {
  storage.removeItem(`nested-media-view:${scope}`)
  return parseBrowseView(storage.getItem(nestedViewKey(scope)), fallback)
}

export function nestedViewKey(scope: string) {
  return `nested-media-view:v${savedViewVersion}:${scope}`
}

/** Where a nested grid's density is kept: one value per artwork shape. */
export function nestedGridDensityKey(mediaType: GridKind) {
  return `nested-grid-density:${mediaType}`
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

export type GridKind = 'album' | 'film' | 'track' | 'artist' | 'subscription'

/**
 * Smallest card width per density, in px, as in `CardGrid min`. Standard is
 * the design system's width for each resource; compact fits three columns
 * on a 375px phone, whose grid is 355px wide inside the page margins.
 */
const cardMin: Record<GridKind, Record<GridDensity, number>> = {
  album: { compact: 96, standard: 164, roomy: 220 },
  track: { compact: 96, standard: 164, roomy: 220 },
  film: { compact: 96, standard: 118, roomy: 160 },
  artist: { compact: 96, standard: 120, roomy: 160 },
  subscription: { compact: 96, standard: 200, roomy: 280 },
}

export function gridCardMin(kind: GridKind, density: GridDensity) {
  return cardMin[kind][density]
}

/**
 * Fewest columns a grid shows. Compact keeps three where the card width
 * alone would leave two, as in a detail tab on a phone, which is narrower
 * than the page.
 */
export function fewestGridColumns(density: GridDensity) {
  return density === 'compact' ? 3 : 2
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
    fewestGridColumns(density),
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
