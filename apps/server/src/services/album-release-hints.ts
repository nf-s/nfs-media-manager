import type { AlbumReleaseHint } from '@repo/media-plugin-sdk'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  AlbumReleaseDateSchema,
  SpotifyAlbumTypeSchema,
  SpotifyIdSchema,
} from '@/lib/spotify-api'
import { AlbumMbidSchema } from '@/plugins/builtin/album-provider-helpers'

type ReleaseSource = AlbumReleaseHint['source']

const sources: readonly ReleaseSource[] = ['spotify', 'musicbrainz']
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
const EnvelopesSchema = z.object({
  data: z.unknown().optional(),
  spotify: z.unknown().optional(),
  releaseGroup: z.unknown().optional(),
  mb: z
    .object({ releaseGroup: z.unknown().optional() })
    .optional()
    .catch(undefined),
})

function matchingReference(
  source: ReleaseSource,
  { provider, referenceType }: { provider: string; referenceType: string },
) {
  if (source === 'spotify')
    return provider === source && SpotifyReferenceTypes.includes(referenceType)
  return provider === source && referenceType === 'release-group'
}

function releaseHint(
  source: ReleaseSource,
  title: string,
  date: unknown,
  type: unknown,
  credits: unknown,
): AlbumReleaseHint {
  const releaseDate = AlbumReleaseDateSchema.safeParse(date)
  const year = releaseDate.success ? Number(releaseDate.data.slice(0, 4)) : 0
  const releaseType = (
    source === 'spotify' ? SpotifyAlbumTypeSchema : MusicBrainzTypeSchema
  ).safeParse(type)
  const artists = z
    .array(
      source === 'spotify' ? CreditedArtistSchema : MusicBrainzCreditSchema,
    )
    .min(1)
    .max(30)
    .safeParse(credits)
  return {
    source,
    title,
    ...(year ? { year } : {}),
    ...(releaseType.success ? { releaseType: releaseType.data } : {}),
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
    const ids = [
      ...new Set(
        (primary.length ? primary : matching).map(
          ({ externalId }) => externalId,
        ),
      ),
    ]
    const override = overrides.find((reference) =>
      matchingReference(source, reference),
    )
    const candidateId =
      override?.externalId ?? (ids.length === 1 ? ids[0] : undefined)
    const id = (
      source === 'spotify' ? SpotifyIdSchema : AlbumMbidSchema
    ).safeParse(candidateId).data
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
