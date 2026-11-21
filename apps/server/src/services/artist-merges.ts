import type { ArtistMergeRequest } from '@repo/schemas/artist-merges'
import type { LibraryChange } from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { refreshArtistListeningTotals } from './artist-listening'
import { mergeArtistInto } from './artist-merge-effects'
import { readArtistMergePlan } from './artist-merge-plan'
import { clearKeptSeparate } from './keep-separate-effects'
import type { ChangeEffectEntry } from './library-change-effect'
import {
  getLibraryChange,
  readChangeRecords,
  recordChange,
} from './library-changes'

/**
 * Merges the selected artists into one and records the change. The merged
 * artists stay as names the kept artist keeps, and their credits go to it. A
 * plan with cautions must have been reviewed.
 */
export async function mergeArtists({
  reviewed,
  ...selection
}: ArtistMergeRequest): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const plan = await readArtistMergePlan(tx, selection, true)
    if (plan.blocked)
      throw new ServerError({
        statusCode: 409,
        message: 'Artists with film credits cannot be merged.',
      })
    if (plan.cautions.length && !reviewed)
      throw new ServerError({
        statusCode: 409,
        message: 'Review this merge before it is made.',
      })
    const sources = plan.artists.filter((artist) => artist.id !== plan.targetId)
    const ids = plan.artists.map((artist) => artist.id)
    const [target] = await readChangeRecords(tx, 'artist', [plan.targetId])
    const records = await readChangeRecords(
      tx,
      'artist',
      sources.map((artist) => artist.id),
    )
    const effects: ChangeEffectEntry[] = []
    let credits = 0
    let names = 0
    for (const source of sources) {
      const merged = await mergeArtistInto(tx, source, plan.targetId)
      effects.push(merged.entry)
      credits += merged.credits
      names += merged.names
    }
    const separate = await clearKeptSeparate(tx, 'artist', ids)
    if (separate) effects.push(separate)
    await refreshArtistListeningTotals(tx, ids)
    const changeId = await recordChange(
      tx,
      {
        kind: 'artist',
        action: 'merge',
        target: target ?? null,
        sources: records,
        details: {
          counts: { credit: credits, 'artist-name': names },
          labels: sources.slice(0, 5).map((artist) => artist.name),
        },
      },
      { effects },
    )
    if (!changeId)
      throw new ServerError({
        statusCode: 409,
        message: 'The selected artists have nothing to merge.',
      })
    return getLibraryChange(changeId, tx)
  })
}
