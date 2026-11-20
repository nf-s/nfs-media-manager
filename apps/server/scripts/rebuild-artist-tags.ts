import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  ArtistProfileSchema,
  ArtistProviderIdSchema,
} from '@repo/schemas/artist-profiles'
import { db } from '@/lib/db'
import { getScrapePlugin } from '@/plugins/registry'
import {
  artistProviderCurrentState as state,
  artistProviderSnapshot as snapshot,
} from '@/schemas/db'

const TagPatchSchema = ArtistProfileSchema.pick({
  tags: true,
  tagReleaseSupport: true,
})
const StoredSupportSchema = ArtistProfileSchema.shape.tagReleaseSupport
  .unwrap()
  .nullable()

/** Re-normalize current evidence without making a request or changing scrape freshness. */
export async function rebuildArtistTags(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      provider: { type: 'string' },
      'artist-id': { type: 'string' },
      apply: { type: 'boolean', default: false },
      review: { type: 'string' },
    },
  })
  const provider = ArtistProviderIdSchema.parse(values.provider)
  const artistId = values['artist-id']?.trim()
  if (artistId === '') throw new Error('--artist-id cannot be blank')
  if (
    values.apply
      ? !/^[a-f0-9]{64}$/.test(values.review ?? '')
      : values.review !== undefined
  )
    throw new Error(
      '--apply requires the --review hash from a preview of the same selection',
    )
  const plugin = await getScrapePlugin(provider)
  const readSupport = plugin?.readStoredArtistTagReleaseSupport
  if (!readSupport)
    throw new Error(
      'Provider does not support rebuilding artist tags from saved responses',
    )

  return db.transaction(
    async (tx) => {
      const digest = createHash('sha256').update(
        JSON.stringify([provider, artistId]),
      )
      const counts = {
        scanned: 0,
        changed: 0,
        unsupported: 0,
        before: 0,
        after: 0,
      }
      let cursor: string | undefined
      for (;;) {
        const rows = await tx
          .select({
            artistId: state.artistId,
            snapshotId: snapshot.id,
            payload: snapshot.payload,
            profile: snapshot.normalizedData,
          })
          .from(state)
          .innerJoin(
            snapshot,
            and(
              eq(snapshot.id, state.latestSnapshotId),
              eq(snapshot.artistId, state.artistId),
              eq(snapshot.provider, state.provider),
            ),
          )
          .where(
            and(
              eq(state.provider, provider),
              artistId ? eq(state.artistId, artistId) : undefined,
              cursor ? gt(state.artistId, cursor) : undefined,
            ),
          )
          .orderBy(asc(state.artistId))
          .limit(50)
        if (!rows.length) break
        for (const row of rows) {
          cursor = row.artistId
          counts.scanned++
          const support = StoredSupportSchema.parse(readSupport(row.payload))
          digest.update(JSON.stringify([row.artistId, row.snapshotId, support]))
          if (support === null) {
            counts.unsupported++
            continue
          }
          const patch = {
            tagReleaseSupport: support,
            tags: ArtistProfileSchema.shape.tags.parse(
              support.map((tag) => tag.name),
            ),
          }
          if (patch.tags.length !== support.length)
            throw new Error('Provider returned duplicate or empty tag names')
          const before = TagPatchSchema.parse(row.profile)
          counts.before += before.tags.length
          counts.after += patch.tags.length
          if (isDeepStrictEqual(before, patch)) continue
          counts.changed++
          if (!values.apply) continue

          // Copy the untouched JSON and original database timestamp at full precision.
          const id = nanoid()
          await tx.execute(sql`insert into artist_provider_snapshot
          (id, artist_id, provider, payload, normalized_data, scrape_job_id, created_at)
          select ${id}, artist_id, provider, payload,
            normalized_data || ${JSON.stringify(patch)}::jsonb, scrape_job_id, created_at
          from artist_provider_snapshot where id = ${row.snapshotId}`)
          const moved = await tx
            .update(state)
            .set({ latestSnapshotId: id })
            .where(
              and(
                eq(state.artistId, row.artistId),
                eq(state.provider, provider),
                eq(state.latestSnapshotId, row.snapshotId),
              ),
            )
            .returning({ id: state.latestSnapshotId })
          if (moved.length !== 1)
            throw new Error('Artist snapshot changed during rebuild')
        }
      }
      const review = digest.digest('hex')
      if (values.apply && review !== values.review)
        throw new Error(
          'Current snapshots or derived tags differ from the reviewed preview',
        )
      return { ...counts, review, applied: values.apply }
    },
    {
      isolationLevel: values.apply ? 'serializable' : 'repeatable read',
      accessMode: values.apply ? 'read write' : 'read only',
    },
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void rebuildArtistTags(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => {
      process.stderr.write(
        'Artist tag rebuild failed. Check the provider, database and review hash.\n',
      )
      process.exitCode = 1
    })
    .finally(() => db.$client.end())
}
