import {
  ARTIST_ENRICHMENT_TASK,
  ArtistEnrichmentResultSchema,
  QueueArtistSelectionSchema,
  type ArtistEnrichmentResult,
  type QueueArtistSelection,
} from '@repo/schemas/artist-profiles'
import { ServerError } from '@/lib/error'
import { matchingArtistSelection } from './creators'
import { requireEnrichmentConfirmation } from './film-enrichment'
import { createTaskJob } from './jobs'

export async function queueArtistSelection(
  input: QueueArtistSelection,
  userId: string | null,
) {
  const options = QueueArtistSelectionSchema.parse(input)
  const ids = [...new Set(options.artistIds)]
  const providers = [...new Set(options.providers)]
  requireEnrichmentConfirmation(
    ids.length * providers.length,
    options.confirmBroadRun,
  )
  const freshness = options.freshness ?? []
  if (
    freshness.some(
      (filter) => !providers.some((provider) => provider === filter.provider),
    )
  )
    throw new ServerError({
      statusCode: 422,
      message: 'Queue freshness filters must match selected providers',
    })
  const visible = await matchingArtistSelection(ids)
  if (visible.length !== ids.length)
    throw new ServerError({
      statusCode: 422,
      message:
        'Selection includes missing or archived artists. Reload and select again.',
    })
  const result: ArtistEnrichmentResult = { jobs: [], skipped: [] }
  for (const provider of providers) {
    const matching = new Set(
      await matchingArtistSelection(
        ids,
        freshness.filter((filter) => filter.provider === provider),
      ),
    )
    for (const artistId of ids) {
      if (!matching.has(artistId)) {
        result.skipped.push({
          artistId,
          provider,
          reason: 'No longer matches the freshness filter.',
        })
        continue
      }
      try {
        result.jobs.push(
          await createTaskJob(ARTIST_ENRICHMENT_TASK, userId, {
            taskOptions: { artistId, provider },
            skipActive: true,
          }),
        )
      } catch (error) {
        if (!(error instanceof ServerError)) throw error
        result.skipped.push({
          artistId,
          provider,
          reason:
            error.response.statusCode === 409
              ? 'An artist job is already queued or running.'
              : error.response.message,
        })
      }
    }
  }
  return ArtistEnrichmentResultSchema.parse(result)
}
