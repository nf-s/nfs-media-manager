import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { PluginLinkSchema, PluginReferenceSchema } from '@repo/media-plugin-sdk'
import type { PaginationQuerySchema } from '@repo/schemas/common'
import {
  AlbumMatchRejectionInputSchema,
  AlbumMatchRejectionSchema,
  type AlbumMatchRejection,
  type AlbumMatchRejectionInput,
  type AlbumMatchRejectionPage,
} from '@repo/schemas/match-diagnostics'
import { AlbumHttpUrlSchema } from '@repo/schemas/provider-identification'
import {
  albumMatchUrlHasIdentityQuery,
  createAlbumMatchRejectionPredicate,
} from '@/lib/album-match-identities'
import { LastFmUrlSchema } from '@/lib/album-provider-details'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { AlbumMbidSchema } from '@/plugins/builtin/album-provider-helpers'
import { album, mediaItem, mediaOverride, providerSnapshot } from '@/schemas/db'
import {
  legacyAlbumGoogleMatchEvidence,
  mediaMatchEvidence,
  visibleMediaMatches,
} from './media-match-evidence'

type MatchDatabase =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0]

export const albumMatchRejectionField = 'albumMatchRejection'

const IdentityAliasSchema = z.object({
  referenceType: AlbumMatchRejectionInputSchema.shape.referenceType,
  externalId: AlbumMatchRejectionInputSchema.shape.identifier,
})
const StoredMatchRejectionSchema = AlbumMatchRejectionInputSchema.extend({
  aliases: z.array(IdentityAliasSchema).default([]),
})
type IdentityAlias = z.infer<typeof IdentityAliasSchema>
type StoredMatchRejection = z.infer<typeof StoredMatchRejectionSchema>
type RecordedMatchRejection = StoredMatchRejection & { rejectedAt: string }

function formatRejection(row: { value: unknown; createdAt: Date }) {
  const value = StoredMatchRejectionSchema.safeParse(row.value)
  if (value.success)
    return { ...value.data, rejectedAt: row.createdAt.toISOString() }
  return null
}

export async function readAlbumMatchRejectionsForItems(
  database: MatchDatabase,
  mediaItemIds: string[],
) {
  const result = new Map<string, RecordedMatchRejection[]>()
  if (!mediaItemIds.length) return result
  const rows = await database
    .select({
      mediaItemId: mediaOverride.mediaItemId,
      value: mediaOverride.value,
      createdAt: mediaOverride.createdAt,
    })
    .from(mediaOverride)
    .where(
      and(
        inArray(mediaOverride.mediaItemId, mediaItemIds),
        eq(mediaOverride.field, albumMatchRejectionField),
      ),
    )
    .orderBy(desc(mediaOverride.createdAt), desc(mediaOverride.id))
  for (const row of rows) {
    const rejection = formatRejection(row)
    if (!rejection) continue
    const matches = result.get(row.mediaItemId)
    if (matches) matches.push(rejection)
    else result.set(row.mediaItemId, [rejection])
  }
  return result
}

export async function readAlbumMatchRejections(
  database: MatchDatabase,
  mediaItemId: string,
) {
  const matches = await readAlbumMatchRejectionsForItems(database, [
    mediaItemId,
  ])
  return matches.get(mediaItemId) ?? []
}

function albumNotFound() {
  return new ServerError({ statusCode: 404, message: 'Album not found.' })
}

function currentMatchChanged() {
  return new ServerError({
    statusCode: 409,
    message: 'The album match changed. Refresh Matches and try again.',
  })
}

export async function listAlbumMatchRejections(
  mediaItemId: string,
  { page, size }: z.infer<typeof PaginationQuerySchema>,
): Promise<AlbumMatchRejectionPage> {
  const albumRow = await db.query.album.findFirst({
    columns: { mediaItemId: true },
    where: eq(album.mediaItemId, mediaItemId),
  })
  if (!albumRow) throw albumNotFound()

  const where = and(
    eq(mediaOverride.mediaItemId, mediaItemId),
    eq(mediaOverride.field, albumMatchRejectionField),
  )
  const [rows, totals] = await Promise.all([
    db
      .select({
        value: mediaOverride.value,
        createdAt: mediaOverride.createdAt,
      })
      .from(mediaOverride)
      .where(where)
      .orderBy(desc(mediaOverride.createdAt), desc(mediaOverride.id))
      .limit(size)
      .offset((page - 1) * size),
    db.select({ count: count() }).from(mediaOverride).where(where),
  ])
  const totalCount = totals[0]?.count ?? 0
  const items = rows.flatMap((row) => {
    const rejection = formatRejection(row)
    return rejection ? [AlbumMatchRejectionSchema.parse(rejection)] : []
  })
  return {
    items,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    page,
    size,
  }
}

async function hasCurrentTarget(
  database: MatchDatabase,
  mediaItemId: string,
  target: AlbumMatchRejectionInput,
) {
  const result = await database.execute(sql`
    with evidence_scope as (select ${mediaItemId}::text as id), evidence as (
      ${mediaMatchEvidence('artist')}
      ${legacyAlbumGoogleMatchEvidence()}
    ), matches as (${visibleMediaMatches('album')})
    select 1 from matches
    where provider = ${target.provider}
      and coalesce(source_provider, provider) = ${target.sourceProvider}
      and snapshot_id = ${target.snapshotId}
      and reference_type = ${target.referenceType}
      and identifier = ${target.identifier}
    limit 1
  `)
  return result.rows.length > 0
}

const LastFmIdentitySchema = z.object({
  mbid: AlbumMbidSchema.optional().catch(undefined),
  url: LastFmUrlSchema.optional().catch(undefined),
})

const PrimaryLinkEvidenceSchema = z.object({
  references: z.array(PluginReferenceSchema),
  links: z.array(PluginLinkSchema),
})

function singlePrimaryLinkAlias(
  target: AlbumMatchRejectionInput,
  normalizedData: unknown,
): IdentityAlias[] {
  const recorded = PrimaryLinkEvidenceSchema.safeParse(normalizedData)
  if (!recorded.success) return []
  const primary = recorded.data.references.filter(
    (reference) =>
      reference.isPrimary && !['upc', 'ean'].includes(reference.referenceType),
  )
  const links = recorded.data.links.filter(
    (link) => link.provider === target.sourceProvider,
  )
  const [reference] = primary
  const [link] = links
  if (
    primary.length !== 1 ||
    !reference ||
    reference.referenceType !== target.referenceType ||
    reference.externalId.split(/[?#]/, 1)[0] !== target.identifier ||
    links.length !== 1 ||
    !link ||
    !AlbumHttpUrlSchema.safeParse(link.url).success
  )
    return []
  const url = new URL(link.url)
  if (url.hash || albumMatchUrlHasIdentityQuery(url)) return []
  const [externalId] = link.url.split(/[?#]/, 1)
  if (
    !externalId ||
    externalId.length > 500 ||
    externalId === target.identifier
  )
    return []
  return [{ referenceType: 'url', externalId }]
}

function aliasesFromSnapshot(
  target: AlbumMatchRejectionInput,
  snapshot: { payload: unknown; normalizedData: unknown },
): IdentityAlias[] {
  const { sourceProvider, referenceType, identifier } = target
  if (
    target.provider !== sourceProvider ||
    sourceProvider === 'google-custom-search'
  )
    return []
  if (sourceProvider === 'lastfm') {
    const { payload } = snapshot
    const wrapped = z.object({ album: z.unknown() }).safeParse(payload)
    const raw = LastFmIdentitySchema.safeParse(
      wrapped.success ? (wrapped.data.album ?? payload) : payload,
    )
    const mbid = raw.success ? raw.data.mbid : undefined
    const url = raw.success ? raw.data.url?.split(/[?#]/, 1)[0] : undefined
    if (
      referenceType === 'mbid' &&
      mbid === identifier &&
      url &&
      url.length <= 500
    )
      return [{ referenceType: 'url', externalId: url }]
    if (referenceType === 'url' && url === identifier && mbid)
      return [{ referenceType: 'mbid', externalId: mbid }]
  }
  if (
    sourceProvider === 'discogs' &&
    /^(master|release)$/.test(referenceType) &&
    /^\d+$/.test(identifier)
  )
    return [
      {
        referenceType: 'url',
        externalId: `https://www.discogs.com/${referenceType}/${identifier}`,
      },
    ]
  if (
    sourceProvider === 'musicbrainz' &&
    referenceType === 'release-group' &&
    AlbumMbidSchema.safeParse(identifier).success
  )
    return [
      {
        referenceType: 'url',
        externalId: `https://musicbrainz.org/release-group/${identifier}`,
      },
    ]
  if (
    sourceProvider === 'spotify' &&
    /^(album|spotify)$/.test(referenceType) &&
    /^[A-Za-z0-9]{22}$/.test(identifier)
  )
    return [
      {
        referenceType: 'url',
        externalId: `https://open.spotify.com/album/${identifier}`,
      },
    ]
  return singlePrimaryLinkAlias(target, snapshot.normalizedData)
}

function isSameTarget(
  previous: RecordedMatchRejection,
  target: AlbumMatchRejectionInput,
) {
  return (
    previous.provider === target.provider &&
    previous.sourceProvider === target.sourceProvider &&
    previous.snapshotId === target.snapshotId &&
    previous.referenceType === target.referenceType &&
    previous.identifier === target.identifier
  )
}

/** Records the owner decision without rewriting the provider's recorded evidence. */
export async function rejectAlbumMatch(
  mediaItemId: string,
  target: AlbumMatchRejectionInput,
  userId: string | null,
): Promise<AlbumMatchRejection> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .innerJoin(album, eq(album.mediaItemId, mediaItem.id))
      .where(
        and(eq(mediaItem.id, mediaItemId), eq(mediaItem.mediaType, 'album')),
      )
      .for('update', { of: mediaItem })
    if (!locked) throw albumNotFound()

    const previous = await readAlbumMatchRejections(tx, mediaItemId)
    const replay = previous.find((row) => isSameTarget(row, target))
    if (replay) return AlbumMatchRejectionSchema.parse(replay)
    if (!(await hasCurrentTarget(tx, mediaItemId, target)))
      throw currentMatchChanged()

    const matching = previous.find((row) =>
      createAlbumMatchRejectionPredicate(target.provider, [row])({
        referenceType: target.referenceType,
        externalId: target.identifier,
      }),
    )
    if (matching) return AlbumMatchRejectionSchema.parse(matching)

    const snapshot = await tx.query.providerSnapshot.findFirst({
      columns: { payload: true, normalizedData: true },
      where: and(
        eq(providerSnapshot.id, target.snapshotId),
        eq(providerSnapshot.mediaItemId, mediaItemId),
        eq(providerSnapshot.provider, target.sourceProvider),
      ),
    })
    if (!snapshot) throw currentMatchChanged()

    const value = { ...target, aliases: aliasesFromSnapshot(target, snapshot) }
    const [saved] = await tx
      .insert(mediaOverride)
      .values({
        id: nanoid(),
        mediaItemId,
        field: albumMatchRejectionField,
        value,
        createdByUserId: userId,
      })
      .returning({ createdAt: mediaOverride.createdAt })
    if (!saved) throw new Error('Could not save album match rejection.')
    return { ...target, rejectedAt: saved.createdAt.toISOString() }
  })
}
