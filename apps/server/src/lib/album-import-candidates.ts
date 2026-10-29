import Papa from 'papaparse'
import { z } from 'zod'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { AlbumCsvPreviewInputSchema } from '@repo/schemas/album-imports'
import { ServerError } from './error'
import { createStableId } from './media-utils'
import { spotifyAlbumId, UpcSchema } from './spotify-api'

export const AlbumImportCandidateSchema = z.object({
  provider: z.enum(['spotify', 'album-csv', 'upc-csv']),
  source: z.string(),
  result: PluginResultSchema,
})
export type AlbumImportCandidate = z.infer<typeof AlbumImportCandidateSchema>
export const albumNameKey = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLowerCase()
export function albumCandidateArtists(candidate: AlbumImportCandidate) {
  return candidate.result.normalized.credits
    .filter((credit) => credit.role === 'artist')
    .map((credit) => credit.name)
}
export function albumCandidateNameKey(candidate: AlbumImportCandidate) {
  return JSON.stringify([
    albumNameKey(candidate.result.normalized.mediaPatch?.title ?? ''),
    [...new Set(albumCandidateArtists(candidate).map(albumNameKey))].sort(),
  ])
}
export function albumImportId(candidate: AlbumImportCandidate) {
  // Canonical identity is internal and remains independent of Spotify IDs.
  return createStableId('album', `import:${albumCandidateNameKey(candidate)}`)
}
export function albumReferenceKey(
  provider: string,
  referenceType: string,
  externalId: string,
) {
  if (
    referenceType === 'spotify' ||
    (provider === 'spotify' && referenceType === 'album')
  ) {
    const id = spotifyAlbumId(externalId)
    return id ? `spotify:${id}` : null
  }
  if (
    (referenceType === 'upc' || referenceType === 'ean') &&
    UpcSchema.safeParse(externalId).success
  ) {
    return `barcode:${externalId.padStart(14, '0')}`
  }
  return null
}
export function albumCandidateKeys(candidate: AlbumImportCandidate) {
  return candidate.result.normalized.references.flatMap((ref) => {
    const key = albumReferenceKey(
      candidate.provider,
      ref.referenceType,
      ref.externalId,
    )
    return key ? [key] : []
  })
}

function csvDate(value: string | undefined) {
  if (!value?.trim()) return undefined
  const trimmed = value.trim()
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : trimmed
  const parsed = z.string().datetime({ offset: true }).safeParse(iso)
  if (
    !parsed.success ||
    !Number.isFinite(Date.parse(iso)) ||
    (trimmed.length === 10 &&
      new Date(iso).toISOString().slice(0, 10) !== trimmed)
  )
    throw new Error('Use an ISO date or timestamp')
  return new Date(iso).toISOString()
}

export function collectAlbumCsv(
  input: z.infer<typeof AlbumCsvPreviewInputSchema>,
) {
  const options = AlbumCsvPreviewInputSchema.parse(input)
  if (Buffer.byteLength(options.content) > 20 * 1024 * 1024)
    throw new ServerError({ statusCode: 422, message: 'CSV exceeds 20 MB' })
  const parsed = Papa.parse<Record<string, string>>(options.content, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (header) => header.trim().toLowerCase(),
    preview: 10001,
  })
  if (
    parsed.errors.length ||
    parsed.meta.truncated ||
    parsed.data.length >= 10000
  )
    throw new ServerError({
      statusCode: 422,
      message:
        'CSV is malformed or exceeds 9,999 rows. Use a smaller valid CSV.',
    })
  const headers = parsed.meta.fields ?? []
  if (Object.keys(parsed.meta.renamedHeaders ?? {}).length)
    throw new ServerError({
      statusCode: 422,
      message: 'CSV contains duplicate column names',
    })
  const required =
    options.format === 'upc-csv'
      ? ['title', 'artist', 'upc']
      : ['title', 'artist']
  if (required.some((key) => !headers.includes(key)))
    throw new ServerError({
      statusCode: 422,
      message: `CSV requires columns: ${required.join(', ')}`,
    })
  const records: AlbumImportCandidate[] = []
  const warnings: string[] = []
  let skipped = 0
  for (const [index, raw] of parsed.data.entries()) {
    try {
      const row = z.record(z.string(), z.string()).parse(raw)
      const title = z.string().trim().min(1).max(1000).parse(row['title'])
      const artist = z.string().trim().min(1).max(1000).parse(row['artist'])
      const upc = row['upc']?.trim() || undefined
      if (upc) UpcSchema.parse(upc)
      if (options.format === 'upc-csv' && !upc) throw new Error('Missing UPC')
      const spotifyInput =
        row['spotify']?.trim() ||
        row['spotifyid']?.trim() ||
        row['spotifyurl']?.trim()
      const spotify = spotifyInput ? spotifyAlbumId(spotifyInput) : null
      if (spotifyInput && !spotify)
        throw new Error('Invalid Spotify album identifier')
      const addedAt = csvDate(
        row['date'] || row['addeddate'] || row['dateadded'],
      )
      const url = spotify
        ? `https://open.spotify.com/album/${spotify}`
        : undefined
      records.push(
        AlbumImportCandidateSchema.parse({
          provider: options.format,
          source: options.fileName,
          result: {
            payload: {
              title,
              artist,
              upc: upc ?? null,
              spotify,
              addedAt: addedAt ?? null,
            },
            normalized: {
              mediaPatch: { title, sourceLabel: 'Album CSV' },
              albumPatch: { dateAdded: addedAt, spotifyUrl: url },
              credits: [{ name: artist, role: 'artist', billingOrder: 0 }],
              references: [
                ...(spotify
                  ? [
                      {
                        referenceType: 'spotify',
                        externalId: spotify,
                        isPrimary: true,
                      },
                    ]
                  : []),
                ...(upc ? [{ referenceType: 'upc', externalId: upc }] : []),
              ],
              links: url
                ? [{ provider: 'spotify', label: 'Spotify', url }]
                : [],
            },
          },
        }),
      )
    } catch {
      skipped++
      if (warnings.length < 20)
        warnings.push(
          `Row ${index + 2}: invalid title, artist, identifier or date; skipped`,
        )
    }
  }
  return { records, warnings, skipped }
}
