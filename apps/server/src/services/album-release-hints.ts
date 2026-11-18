import type { AlbumReleaseHint } from '@repo/media-plugin-sdk'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { DiscogsRecordSchema } from '@/lib/album-provider-details'
import { db } from '@/lib/db'
import {
  AlbumReleaseDateSchema,
  SpotifyAlbumTypeSchema,
  SpotifyIdSchema,
} from '@/lib/spotify-api'
import {
  AlbumMbidSchema,
  DiscogsReferenceIdSchema,
} from '@/plugins/builtin/album-provider-helpers'

type ReleaseSource = AlbumReleaseHint['source']

const sources: readonly ReleaseSource[] = ['spotify', 'musicbrainz', 'discogs']
const ReferenceIdSchemas: Record<ReleaseSource, z.ZodType<string>> = {
  spotify: SpotifyIdSchema,
  musicbrainz: AlbumMbidSchema,
  discogs: DiscogsReferenceIdSchema,
}
const SpotifyReferenceTypes = ['album', 'spotify']
const ReleaseNameSchema = z.string().trim().min(1).max(500)
const CreditedArtistSchema = z.object({ name: ReleaseNameSchema })
const SpotifyReleaseSchema = z.object({
  id: SpotifyIdSchema,
  name: ReleaseNameSchema,
  release_date: z.unknown().optional(),
  album_type: z.unknown().optional(),
  artists: z.unknown().optional(),
})
const MusicBrainzReleaseSchema = z.object({
  id: AlbumMbidSchema,
  title: ReleaseNameSchema,
  'first-release-date': z.unknown().optional(),
  'primary-type': z.unknown().optional(),
  'artist-credit': z.unknown().optional(),
})
const MusicBrainzTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['album', 'single', 'ep', 'broadcast', 'other']))
const MusicBrainzCreditSchema = z.union([
  CreditedArtistSchema,
  z.object({ artist: CreditedArtistSchema }).transform(({ artist }) => artist),
])
const DiscogsMasterSchema = z.object({
  id: z.union([
    DiscogsRecordSchema.shape.id.transform(String),
    DiscogsReferenceIdSchema,
  ]),
  title: ReleaseNameSchema,
  year: z.unknown().optional(),
  artists: z.unknown().optional(),
})
const DiscogsYearSchema = DiscogsRecordSchema.shape.year
  .unwrap()
  .min(1)
  .max(9999)
const EnvelopesSchema = z.object({
  data: z.unknown().optional(),
  spotify: z.unknown().optional(),
  releaseGroup: z.unknown().optional(),
  master: z.unknown().optional(),
  discogs: z
    .object({ master: z.unknown().optional() })
    .optional()
    .catch(undefined),
  mb: z
    .object({ releaseGroup: z.unknown().optional() })
    .optional()
    .catch(undefined),
})

function matchingReference(
  source: ReleaseSource,
  { provider, referenceType }: { provider: string; referenceType: string },
) {
  if (provider !== source) return false
  if (source === 'spotify') return SpotifyReferenceTypes.includes(referenceType)
  if (source === 'discogs')
    return referenceType === 'master' || referenceType === 'release'
  return referenceType === 'release-group'
}

function releaseHint(
  source: ReleaseSource,
  title: string,
  date: unknown,
  type: unknown,
  credits: unknown,
): AlbumReleaseHint {
  const releaseDate = AlbumReleaseDateSchema.safeParse(date)
  const year =
    source === 'discogs'
      ? DiscogsYearSchema.safeParse(date).data
      : releaseDate.success
        ? Number(releaseDate.data.slice(0, 4))
        : undefined
  const releaseType =
    source === 'spotify'
      ? SpotifyAlbumTypeSchema.safeParse(type).data
      : source === 'musicbrainz'
        ? MusicBrainzTypeSchema.safeParse(type).data
        : undefined
  const artists = z
    .array(
      source === 'musicbrainz' ? MusicBrainzCreditSchema : CreditedArtistSchema,
    )
    .min(1)
    .max(30)
    .safeParse(credits)
  return {
    source,
    title,
    ...(year ? { year } : {}),
    ...(releaseType ? { releaseType } : {}),
    ...(artists.success
      ? { artists: artists.data.map(({ name }) => name) }
      : {}),
  }
}

function readSnapshot(
  source: ReleaseSource,
  externalId: string,
  provider: string,
  payload: unknown,
): AlbumReleaseHint | undefined {
  const envelope = EnvelopesSchema.safeParse(payload).data
  if (!envelope) return
  if (source === 'discogs') {
    // Master and release identifiers occupy different namespaces.
    const records =
      provider === 'legacy-record'
        ? [envelope.discogs?.master]
        : [envelope.master, envelope.discogs?.master]
    for (const record of records) {
      const master = DiscogsMasterSchema.safeParse(record).data
      if (master?.id !== externalId) continue
      return releaseHint(
        source,
        master.title,
        master.year,
        undefined,
        master.artists,
      )
    }
    return
  }
  if (source === 'spotify') {
    const records =
      provider === 'legacy-record'
        ? [envelope.spotify]
        : [payload, envelope.data, envelope.spotify]
    for (const record of records) {
      const release = SpotifyReleaseSchema.safeParse(record).data
      if (release?.id !== externalId) continue
      return releaseHint(
        source,
        release.name,
        release.release_date,
        release.album_type,
        release.artists,
      )
    }
    return
  }
  const records =
    provider === 'legacy-record'
      ? [envelope.mb?.releaseGroup, envelope.releaseGroup]
      : [envelope.releaseGroup, payload]
  for (const record of records) {
    const release = MusicBrainzReleaseSchema.safeParse(record).data
    if (release?.id !== externalId) continue
    return releaseHint(
      source,
      release.title,
      release['first-release-date'],
      release['primary-type'],
      release['artist-credit'],
    )
  }
}

function snapshotMatches(source: ReleaseSource, payload: SQL, id: string) {
  if (source === 'spotify')
    return sql`(${payload}->>'id' = ${id} or ${payload} #>> '{data,id}' = ${id} or ${payload} #>> '{spotify,id}' = ${id})`
  if (source === 'discogs')
    return sql`(${payload} #>> '{master,id}' = ${id} or ${payload} #>> '{discogs,master,id}' = ${id})`
  return sql`(${payload}->>'id' = ${id} or ${payload} #>> '{releaseGroup,id}' = ${id} or ${payload} #>> '{mb,releaseGroup,id}' = ${id})`
}

export async function getAlbumReleaseHints(
  mediaItemId: string,
): Promise<AlbumReleaseHint[]> {
  const [references, overrides] = await Promise.all([
    db.query.providerReference.findMany({
      columns: {
        provider: true,
        referenceType: true,
        externalId: true,
        isPrimary: true,
      },
      where: (table, operators) =>
        operators.and(
          operators.eq(table.mediaItemId, mediaItemId),
          operators.inArray(table.provider, sources),
        ),
    }),
    db.query.providerReferenceOverride.findMany({
      columns: { provider: true, referenceType: true, externalId: true },
      where: (table, operators) =>
        operators.and(
          operators.eq(table.mediaItemId, mediaItemId),
          operators.inArray(table.provider, sources),
        ),
      orderBy: (table, operators) => [
        operators.desc(table.createdAt),
        operators.desc(table.id),
      ],
    }),
  ])
  const hints: AlbumReleaseHint[] = []
  for (const source of sources) {
    const matching = references.filter((reference) =>
      matchingReference(source, reference),
    )
    const primary = matching.filter(({ isPrimary }) => isPrimary)
    const active = primary.length ? primary : matching
    const override = overrides.find((reference) =>
      matchingReference(source, reference),
    )
    if (
      source === 'discogs' &&
      (override
        ? override.referenceType !== 'master'
        : active.some(({ referenceType }) => referenceType !== 'master'))
    )
      continue
    const ids = [...new Set(active.map(({ externalId }) => externalId))]
    const candidateId =
      override?.externalId ?? (ids.length === 1 ? ids[0] : undefined)
    const id = ReferenceIdSchemas[source].safeParse(candidateId).data
    if (!id) continue
    const snapshots = await db.query.providerSnapshot.findMany({
      columns: { provider: true, payload: true },
      where: (table, operators) =>
        operators.and(
          operators.eq(table.mediaItemId, mediaItemId),
          operators.inArray(table.provider, [source, 'legacy-record']),
          snapshotMatches(source, sql`${table.payload}`, id),
        ),
      orderBy: (table, operators) => [
        operators.desc(table.createdAt),
        operators.desc(table.id),
      ],
      limit: 8,
    })
    for (const snapshot of snapshots) {
      const hint = readSnapshot(source, id, snapshot.provider, snapshot.payload)
      if (!hint) continue
      hints.push(hint)
      break
    }
  }
  return hints
}
