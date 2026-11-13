import { z } from 'zod'

const GridDensitySchema = z.enum(['compact', 'standard', 'roomy'])
type GridDensity = z.infer<typeof GridDensitySchema>

export function parseGridDensity(value: unknown): GridDensity {
  const result = GridDensitySchema.safeParse(value)
  return result.success ? result.data : 'standard'
}

const ArtworkOverlaySchema = z.enum(['ratings', 'sort', 'tags'])
export type ArtworkOverlay = z.infer<typeof ArtworkOverlaySchema>
export const artworkOverlays = ArtworkOverlaySchema.options

/** Albums show tags on artwork unless a saved preference says otherwise. */
export function parseArtworkOverlays(
  value: string | null,
  mediaType: 'album' | 'film',
): ArtworkOverlay[] {
  if (value === null)
    return mediaType === 'album' ? [...artworkOverlays] : ['ratings', 'sort']
  return value.split(',').flatMap((key) => {
    const result = ArtworkOverlaySchema.safeParse(key)
    return result.success ? [result.data] : []
  })
}

export function formatArtworkOverlays(overlays: ArtworkOverlay[]): string {
  return overlays.length ? overlays.join(',') : 'none'
}

const BrowseViewSchema = z.enum(['grid', 'list', 'table'])

export function parseBrowseView(value: unknown) {
  const result = BrowseViewSchema.safeParse(value)
  return result.success ? result.data : 'grid'
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

export function mediaGridGeometry({
  width,
  mediaType,
  density,
  extraRow = true,
}: {
  width: number
  mediaType: 'album' | 'film'
  density: GridDensity
  /** Whether tiles keep a row under the byline for a sort value or links. */
  extraRow?: boolean
}) {
  const mobile = width <= 700
  const gap = mobile ? 8 : 12
  const targetWidths = {
    compact: mobile ? 84 : mediaType === 'album' ? 138 : 122,
    standard: mobile ? 112 : mediaType === 'album' ? 182 : 152,
    roomy: mediaType === 'album' ? 236 : 202,
  }
  const columns = Math.max(2, Math.floor(width / targetWidths[density]))
  const artworkWidth = Math.max(0, (width - (columns - 1) * gap) / columns)
  const artworkHeight = artworkWidth * (mediaType === 'album' ? 1 : 1.5)
  // Match the fixed metadata rows in media-browser.module.css and global tile styles.
  const cardHeight = artworkHeight + (extraRow ? 64 : 44)
  return { mobile, gap, columns, cardHeight, rowHeight: cardHeight + gap }
}
