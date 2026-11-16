import type { ArtistEnrichmentResult } from '@repo/schemas/artist-profiles'
import { ArtistMetadataQuerySchema } from '@repo/schemas/creators'

export function artistMetadataQuery(params: URLSearchParams) {
  const fields = ArtistMetadataQuerySchema.shape
  const sort = fields.sortBy.safeParse(params.get('sortBy') ?? undefined)
  const source = fields.provider.safeParse(params.get('provider') ?? undefined)
  const freshness = fields.freshness.safeParse(
    params.get('freshness') ?? undefined,
  )
  const playlists = fields.playlistIds.safeParse(
    params.get('playlistIds') ?? undefined,
  )
  const filters = fields.filters.safeParse(params.get('filters') ?? undefined)
  const ranges = fields.ranges.safeParse(params.get('ranges') ?? undefined)
  const limit = fields.limitResults.safeParse(
    params.get('limitResults') ?? undefined,
  )
  const provider = source.success ? source.data : undefined
  const sortBy = sort.success ? sort.data : 'name'
  return ArtistMetadataQuerySchema.parse({
    q: params.get('q')?.slice(0, 200),
    direction: params.get('direction') === 'desc' ? 'desc' : 'asc',
    sortBy: sortBy === 'lastScrapedAt' && !provider ? 'name' : sortBy,
    provider,
    freshness: freshness.success ? freshness.data : [],
    playlistIds: playlists.success ? playlists.data : [],
    filters: filters.success ? filters.data : [],
    ranges: ranges.success ? ranges.data : [],
    limitResults: limit.success ? limit.data : undefined,
  })
}

/** Queue bounded, explicit selections without automatically retrying uncertain requests. */
export async function dispatchArtistSelection(
  selected: string[],
  send: (ids: string[]) => Promise<ArtistEnrichmentResult>,
  onProgress: (count: number) => void,
) {
  const ids = [...new Set(selected)]
  const completed: string[] = []
  let queued = 0
  let skipped = 0
  const warnings = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100)
    try {
      const result = await send(chunk)
      completed.push(...chunk)
      queued += result.jobs.length
      skipped += result.skipped.length
      result.skipped.forEach((entry) => warnings.add(entry.reason))
      onProgress(completed.length)
    } catch {
      warnings.add(
        'Stopped: this batch could not be confirmed. Check artist jobs before retrying the remaining selection.',
      )
      return { queued, skipped, completed, warnings: [...warnings] }
    }
  }
  return { queued, skipped, completed, warnings: [...warnings] }
}
