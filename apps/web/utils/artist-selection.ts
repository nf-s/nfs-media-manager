import type { ArtistEnrichmentResult } from '@repo/schemas/artist-profiles'
import { ArtistMetadataQuerySchema } from '@repo/schemas/creators'
import type { ArtistSelectionSnapshotPage } from '@repo/schemas/artist-selection'
import { parseListeningParams } from './listening-filters'
import { libraryScopeQuery, readLibraryScope } from './library-scope'

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
    ...parseListeningParams(params),
    ...libraryScopeQuery(readLibraryScope(params)),
  })
}

/** Queue bounded, explicit selections without automatically retrying uncertain requests. */
export async function dispatchArtistSelection(
  selected: string[],
  send: (ids: string[]) => Promise<ArtistEnrichmentResult>,
  onProgress: (count: number) => void,
) {
  const ids = [...new Set(selected)]
  function* batches() {
    for (let offset = 0; offset < ids.length; offset += 100)
      yield ids.slice(offset, offset + 100)
  }
  return dispatchArtistBatches(batches(), send, onProgress)
}

/** Resolve only lightweight snapshot IDs as each confirmed queue batch advances. */
export async function dispatchArtistSnapshot(
  excluded: string[],
  load: (after: string | undefined) => Promise<ArtistSelectionSnapshotPage>,
  send: (ids: string[]) => Promise<ArtistEnrichmentResult>,
  onProgress: (count: number) => void,
) {
  const omitted = new Set(excluded)
  async function* batches() {
    let after: string | undefined
    const cursors = new Set<string>()
    const seen = new Set<string>()
    while (true) {
      const page = await load(after)
      if (page.nextCursor !== null) {
        if (!page.ids.length || cursors.has(page.nextCursor))
          throw new Error('The selection cursor did not advance')
        cursors.add(page.nextCursor)
      }
      const ids = page.ids.filter((id) => {
        if (seen.has(id)) return false
        seen.add(id)
        return !omitted.has(id)
      })
      if (ids.length) yield ids
      if (page.nextCursor === null) return
      after = page.nextCursor
    }
  }
  return dispatchArtistBatches(batches(), send, onProgress)
}

async function dispatchArtistBatches(
  batches: Iterable<string[]> | AsyncIterable<string[]>,
  send: (ids: string[]) => Promise<ArtistEnrichmentResult>,
  onProgress: (count: number) => void,
) {
  const completed: string[] = []
  let queued = 0
  let skipped = 0
  const warnings = new Set<string>()
  let interrupted = false
  try {
    for await (const chunk of batches) {
      const result = await send(chunk)
      completed.push(...chunk)
      queued += result.jobs.length
      skipped += result.skipped.length
      result.skipped.forEach((entry) => warnings.add(entry.reason))
      onProgress(completed.length)
    }
  } catch {
    interrupted = true
    warnings.add(
      'Stopped: this batch could not be confirmed or the selection expired. Check artist jobs before retrying the remaining selection.',
    )
  }
  return { queued, skipped, completed, warnings: [...warnings], interrupted }
}
