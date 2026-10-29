import { z } from 'zod'

const GridDensitySchema = z.enum(['compact', 'standard', 'roomy'])
type GridDensity = z.infer<typeof GridDensitySchema>

export function parseGridDensity(value: unknown): GridDensity {
  const result = GridDensitySchema.safeParse(value)
  return result.success ? result.data : 'standard'
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
}: {
  width: number
  mediaType: 'album' | 'film'
  density: GridDensity
}) {
  const mobile = width <= 700
  const gap = mobile ? 8 : 12
  const targetWidths = {
    compact: mobile ? 112 : mediaType === 'album' ? 138 : 122,
    standard: mediaType === 'album' ? 182 : 152,
    roomy: mediaType === 'album' ? 236 : 202,
  }
  const columns = Math.max(2, Math.floor(width / targetWidths[density]))
  const artworkWidth = Math.max(0, (width - (columns - 1) * gap) / columns)
  const artworkHeight = artworkWidth * (mediaType === 'album' ? 1 : 1.5)
  // Match the fixed metadata rows in media-browser.module.css and global tile styles.
  const cardHeight = artworkHeight + 64
  return { mobile, gap, columns, cardHeight, rowHeight: cardHeight + gap }
}
